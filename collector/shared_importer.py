"""ChatGPT shared-page text importer. Does not invoke an LLM or write to a DB."""
from pathlib import Path
import asyncio
import hashlib
import json
import os
import re
import tempfile
import heapq
from time import perf_counter
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urlsplit
from share_input import resolve_share_input


def validate_share_url(url):
    if not isinstance(url, str):
        raise ValueError('공유 URL은 문자열이어야 합니다.')
    url = url.strip()
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc != 'chatgpt.com'
        or not re.fullmatch(r'/share/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/?', parsed.path)
        or parsed.query or parsed.fragment):
        raise ValueError('https://chatgpt.com/share/공유ID 형태의 링크를 입력해 주세요.')
    return url


# 첫 번째 구조는 실제 공유 페이지에서 확인한 속성입니다.
# 두 번째 구조는 다른 화면 버전을 위한 호환 경로이며 실행 결과 검증이 필요합니다.
EXTRACT_JS = r"""() => {
    let nodes = Array.from(document.querySelectorAll('[data-message-role]'));
    let mode = 'data-message-role';
    if (!nodes.length) {
        nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
        mode = 'data-message-author-role';
    }
    return {mode, messages: nodes.map((node) => {
        const role = node.getAttribute('data-message-role') || node.getAttribute('data-message-author-role');
        if (!['user', 'assistant'].includes(role)) return null;
        let body = node.querySelector(role === 'user'
            ? '[data-user-message-copy], [data-user-message-bubble], .whitespace-pre-wrap'
            : '[data-assistant-markdown-root], [data-assistant-markdown], .markdown');
        // author-role 속성이 본문 자체에 붙는 화면에서는 해당 요소를 사용합니다.
        if (!body && mode === 'data-message-author-role') body = node;
        const rawContent = body ? body.innerText : '';
        let content = rawContent;
        let removedUiSections = 0;
        if (role === 'assistant' && body) {
            const normalize = text => text.replace(/\s+/g, ' ').trim();
            for (const list of body.querySelectorAll('ul,ol')) {
                const buttons = list.querySelectorAll('[role="button"][id$="-action"]');
                const intro = list.previousElementSibling;
                // 실제 화면에서 확인한 추천 질문 목록만 제외합니다.
                // 문구만으로 본문을 자르지 않고 버튼 구조와 끝 위치도 확인합니다.
                if (buttons.length < 2 || !intro || intro.tagName !== 'P'
                    || intro.innerText.trim() !== 'If you want, I can:') continue;
                const introText = intro.innerText;
                const at = content.lastIndexOf(introText);
                if (at >= 0 && normalize(content.slice(at))
                    === normalize(introText + '\n' + list.innerText)) {
                    content = content.slice(0, at).trimEnd();
                    removedUiSections += 1;
                }
            }
        }
        const codes = body ? Array.from(body.querySelectorAll('pre')).map(pre => {
            const c = pre.querySelector('code');
            return c ? c.textContent : pre.innerText;
        }) : [];
        return {
            source_message_id: node.getAttribute('data-message-id') || node.id || null,
            role, content, code_blocks: codes,
            ...(removedUiSections ? {content_raw: rawContent} : {}),
            removed_ui_sections: removedUiSections,
            attachment_count: node.querySelectorAll('[data-user-file-attachments] [role="listitem"]').length,
            body_found: Boolean(body)
        };
    }).filter(Boolean)};
}"""


SCROLL_JS = r'''(action) => {
    const selector = '[data-message-role], [data-message-author-role]';
    const nodes = Array.from(document.querySelectorAll(selector));
    const scrollers = new Set();
    const root = document.scrollingElement;
    if (root && root.scrollHeight > root.clientHeight + 2) scrollers.add(root);
    for (const node of nodes) {
        for (let p = node.parentElement; p; p = p.parentElement) {
            const overflow = getComputedStyle(p).overflowY;
            if (/(auto|scroll)/.test(overflow) && p.scrollHeight > p.clientHeight + 2)
                scrollers.add(p);
        }
    }
    // A fitting page may have no scrollable element.
    if (!scrollers.size && root) scrollers.add(root);
    const before = Array.from(scrollers, p => ({
        top:p.scrollTop, height:p.scrollHeight, viewport:p.clientHeight
    }));
    if (action === 'top' || action === 'step') {
        for (const p of scrollers) {
            const dest = action === 'top' ? 0 :
                Math.min(p.scrollHeight-p.clientHeight, p.scrollTop+Math.max(1,p.clientHeight*0.60));
            p.scrollTo({top:dest, behavior:'instant'});
        }
    }
    const after = Array.from(scrollers, p => ({
        top:p.scrollTop, height:p.scrollHeight, viewport:p.clientHeight
    }));
    return {
        positions:after,
        at_bottom:after.length > 0 && after.every(p => p.top+p.viewport >= p.height-4),
        moved:after.some((p,i) => Math.abs(p.top-before[i].top)>1),
        loading:!!document.querySelector('[aria-busy="true"], [role="progressbar"]')
    };
}'''

class MessageAccumulator:
    """Keep nonempty bodies and ordering constraints across rendered snapshots."""
    def __init__(self):
        self.messages = {}
        self.edges = set()

    def add(self, messages):
        ids = []
        for message in messages:
            key = message.get('source_message_id')
            if not isinstance(key, str) or not key.strip():
                raise ValueError('메시지 ID가 없어 누락·중복 검사를 할 수 없습니다.')
            old = self.messages.get(key)
            if old and old['role'] != message['role']:
                raise ValueError('같은 메시지 ID의 발화자가 바뀌었습니다.')
            if key not in ids:
                ids.append(key)
            # Do not replace a populated body with a later unloaded placeholder.
            score = lambda m: (len(m.get('content', '').strip()), len(m.get('code_blocks', [])))
            if old is None or score(message) >= score(old):
                self.messages[key] = dict(message)
        self.edges.update((a,b) for a,b in zip(ids,ids[1:]) if a != b)

    def ordered(self):
        rank = {key:i for i,key in enumerate(self.messages)}
        degrees = dict.fromkeys(rank,0)
        children = {key:set() for key in rank}
        for a,b in self.edges:
            if b not in children[a]:
                children[a].add(b);degrees[b]+=1
        ready = [(rank[k],k) for k,v in degrees.items() if v == 0]
        heapq.heapify(ready)
        result = []
        while ready:
            _,key = heapq.heappop(ready)
            result.append(dict(self.messages[key]))
            for nxt in children[key]:
                degrees[nxt]-=1
                if degrees[nxt] == 0:heapq.heappush(ready,(rank[nxt],nxt))
        if len(result) != len(rank):
            raise ValueError('화면에서 관찰한 메시지 순서가 충돌합니다.')
        for i,message in enumerate(result,1):
            message['sequence'] = i
            message.pop('body_found',None)
        return result

DEFAULT_MAX_ROUNDS = 1200
DEFAULT_TIMEOUT_SECONDS = 210.0


class CollectionIncompleteError(RuntimeError):
    """수집 한도 도달. diagnostics는 진단용이며 저장 가능한 대화 원문이 아니다."""
    def __init__(self, message, diagnostics):
        self.diagnostics = diagnostics
        super().__init__(message)


async def collect_shared_conversation(
    url, max_rounds=DEFAULT_MAX_ROUNDS, *, timeout_seconds=DEFAULT_TIMEOUT_SECONDS
):
    """기존 호출 형식을 유지한다. 실패·부분 결과는 record로 반환하지 않는다.

    timeout_seconds는 페이지 접근·스크롤을 포함한 전체 수집의 제한이다.
    취소 시 브라우저 정리 시간이 추가될 수 있다. 확장 프로그램 파일은 요구하지 않는다.
    """
    if type(max_rounds) is not int or not 5 <= max_rounds <= 5000:
        raise ValueError('max_rounds는 5~5000 사이의 정수여야 합니다.')
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds,(int,float)) or not 0 < timeout_seconds <= 3600:
        raise ValueError('timeout_seconds는 0보다 크고 3600 이하인 유한한 숫자여야 합니다.')
    url=validate_share_url(resolve_share_input(url))
    try:
        from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
    except ImportError as exc:
        raise RuntimeError('먼저 requirements.txt와 Playwright Chromium을 설치해 주세요.') from exc

    accumulator=MessageAccumulator()
    trace=[]
    previous=None
    stable_at_bottom=0
    started=perf_counter()

    def diagnostics(reason, mode=None):
        return {
            'stop_reason':reason,
            'message_count':len(accumulator.messages),
            'role_counts':dict(Counter(m['role'] for m in accumulator.messages.values())),
            'collection_rounds':len(trace),
            'extraction_selector':mode,
            'stopped_after_stable_content':reason=='bottom_stable',
            'elapsed_seconds':round(perf_counter()-started,2),
            'timeout_seconds':float(timeout_seconds),
            # Operational diagnostics omit message text and retain only recent progress.
            'collection_trace_tail':trace[-12:],
        }

    async def collect():
        nonlocal previous, stable_at_bottom
        async with async_playwright() as pw:
            browser=await pw.chromium.launch(headless=True,args=['--no-sandbox'])
            try:
                page=await browser.new_page(viewport={'width':1280,'height':900})
                response=await page.goto(url,wait_until='domcontentloaded',timeout=60000)
                if response and response.status >= 400:
                    raise RuntimeError(f'공유 페이지 접근 실패: HTTP {response.status}. 차단을 우회하지 않습니다.')
                validate_share_url(page.url)
                try:
                    await page.locator('[data-message-role], [data-message-author-role]').first.wait_for(
                        state='attached',timeout=45000)
                except PlaywrightTimeout as exc:
                    raise RuntimeError('발화 요소를 찾지 못했습니다. 로그인·접근 제한 또는 페이지 구조를 확인하세요.') from exc
                await page.evaluate(SCROLL_JS,'top')
                await asyncio.sleep(1)
                for round_no in range(max_rounds):
                    snapshot=await page.evaluate(EXTRACT_JS)
                    accumulator.add(snapshot['messages'])
                    position=await page.evaluate(SCROLL_JS,'inspect')
                    signature=(
                        tuple((key,m['content'],tuple(m['code_blocks'])) for key,m in accumulator.messages.items()),
                        tuple((p['top'],p['height'],p['viewport']) for p in position['positions'])
                    )
                    if position['at_bottom'] and not position['loading'] and signature==previous:
                        stable_at_bottom+=1
                    else:
                        stable_at_bottom=0
                    previous=signature
                    trace.append({'round':round_no+1,'observed':len(snapshot['messages']),
                        'collected':len(accumulator.messages),'at_bottom':position['at_bottom'],
                        'loading':position['loading'],'positions':position['positions'],
                        'stable_at_bottom':stable_at_bottom})
                    if stable_at_bottom >= 6:
                        break
                    await page.evaluate(SCROLL_JS,'step')
                    await asyncio.sleep(1 if position['at_bottom'] else 0.45)
                else:
                    raise CollectionIncompleteError(
                        '수집 반복 한도에 도달했습니다. 부분 수집 결과는 저장하지 않습니다.',
                        diagnostics('round_limit',snapshot['mode']))

                messages=accumulator.ordered()
                if not messages:raise RuntimeError('수집한 발화가 없어 저장하지 않습니다.')
                missing=[m['source_message_id'] for m in messages if not m['content'].strip()]
                if missing:
                    raise RuntimeError('본문이 비어 있는 발화가 있어 저장하지 않습니다. 이미지 전용 발화인지 확인하세요: '+', '.join(missing))
                result_diagnostics=diagnostics('bottom_stable',snapshot['mode'])
                result_diagnostics.update({
                    'removed_ui_sections':sum(m.get('removed_ui_sections',0) for m in messages),
                    'warnings':[
                        '공유 페이지에 표시된 텍스트이며 원본 JSON과의 일치는 미검증입니다.',
                        '이미지 원본은 수집하지 않습니다. 수식·표·Markdown 형식은 보장하지 않습니다.',
                        '코드 블록에 화면의 언어명 등 표시 요소가 포함될 수 있어 비교가 필요합니다.',
                        '하단 내용의 안정화는 전체 발화의 누락 없음을 보장하지 않습니다.',
                    ]
                })
                return {
                    'schema_version':'shared_text_v1',
                    'source_url':url,
                    'captured_at':datetime.now(timezone.utc).isoformat(),
                    'capture_method':'playwright_rendered_text',
                    'extractor_version':'2.0',
                    'completeness':'unverified',
                    'conversation':{'title':await page.title(),'messages':messages},
                    'diagnostics':result_diagnostics,
                }
            finally:
                await browser.close()
    try:
        return await asyncio.wait_for(collect(),timeout=float(timeout_seconds))
    except asyncio.TimeoutError as exc:
        raise CollectionIncompleteError(
            f'수집 제한 시간({timeout_seconds}초)을 초과했습니다. 부분 결과는 저장하지 않습니다.',
            diagnostics('time_limit')) from exc
    except PlaywrightTimeout as exc:
        raise RuntimeError('공유 페이지 접근 또는 렌더링 대기 시간이 초과됐습니다.') from exc



def save_shared_capture(record, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    stable_payload = {'source_url': record['source_url'], 'conversation': record['conversation']}
    canonical = json.dumps(stable_payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    capture_id = 'share_' + hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    record['capture_id'] = capture_id
    target = directory / (capture_id + '.json')
    if target.exists():
        existing = json.loads(target.read_text(encoding='utf-8'))
        if any(existing[k] != stable_payload[k] for k in stable_payload):
            raise RuntimeError('기존 저장 파일과 내용이 달라 저장을 중단했습니다.')
        return target, 'already_saved'
    fd, temporary = tempfile.mkstemp(dir=directory, prefix='.share_', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return target, 'saved'





async def import_shared_conversation(
    url: str, *, max_rounds: int = DEFAULT_MAX_ROUNDS,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    """공유 페이지 텍스트를 반환한다. DB·파일 저장 및 Luna 호출은 하지 않는다.

    conversation_id는 공유 URL의 ID로 고정되며 원래 비공개 채팅 ID가 아니다.
    capture_id는 수집 내용의 해시다. 내용이 바뀌면 달라진다.
    """
    record = await collect_shared_conversation(url, max_rounds=max_rounds, timeout_seconds=timeout_seconds)
    record['conversation_id'] = 'chatgpt_share_' + urlsplit(record['source_url']).path.rstrip('/').split('/')[-1]
    stable_payload = {'source_url': record['source_url'], 'conversation': record['conversation']}
    canonical = json.dumps(stable_payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    record['capture_id'] = 'share_' + hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    return record


def to_source_blocks(record: dict) -> list[dict]:
    """Luna 입력용 텍스트와 출처 ID만 반환. content_raw는 넣지 않는다."""
    return [
        {'source_id': message['source_message_id'],
         'role': message['role'], 'text': message['content']}
        for message in record['conversation']['messages']
    ]


def main():
    import argparse
    parser = argparse.ArgumentParser(description='사용자가 제공한 ChatGPT 공유 링크의 텍스트 수집')
    parser.add_argument('url')
    parser.add_argument('--output-dir', type=Path, default=Path('./shared_imports'))
    parser.add_argument('--max-rounds', type=int, default=DEFAULT_MAX_ROUNDS)
    parser.add_argument('--timeout-seconds', type=float, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()
    try:
        record = asyncio.run(import_shared_conversation(
            args.url, max_rounds=args.max_rounds, timeout_seconds=args.timeout_seconds))
        path, status = save_shared_capture(record, args.output_dir)
    except (ValueError, RuntimeError) as exc:
        parser.exit(1, f'수집 실패: {exc}\n')
    print(json.dumps({'status': status, 'file': str(path),
                      'message_count': record['diagnostics']['message_count'],
                      'completeness': record['completeness']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
