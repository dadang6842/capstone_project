"""ChatGPT shared-page text importer. Does not invoke an LLM or write to a DB."""
from pathlib import Path
import asyncio
import hashlib
import json
import os
import re
import tempfile
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


async def collect_shared_conversation(url, max_rounds=40):
    if not isinstance(max_rounds, int) or isinstance(max_rounds, bool) or not 5 <= max_rounds <= 120:
        raise ValueError('max_rounds는 5~120 사이의 정수여야 합니다.')
    url = resolve_share_input(url)
    try:
        from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
    except ImportError as exc:
        raise RuntimeError('먼저 requirements.txt와 Playwright Chromium을 설치해 주세요.') from exc
    url = validate_share_url(url)
    collected = {}
    stable = 0
    previous = None
    stopped_stable = False
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = await browser.new_page(viewport={'width': 1280, 'height': 900})
            response = await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            if response and response.status >= 400:
                raise RuntimeError(f'공유 페이지 접근 실패: HTTP {response.status}. 차단을 우회하지 않습니다.')
            validate_share_url(page.url)
            try:
                await page.locator('[data-message-role], [data-message-author-role]').first.wait_for(
                    state='attached', timeout=45000)
            except PlaywrightTimeout as exc:
                visible = (await page.locator('body').inner_text())[:800]
                raise RuntimeError('발화 요소를 찾지 못했습니다. 로그인·접근 제한 또는 페이지 구조를 확인해 주세요.\n'
                                   + visible) from exc

            # 위쪽부터 읽으며 수집한 메시지를 누적합니다.
            await page.keyboard.press('Control+Home')
            for round_no in range(max_rounds):
                snapshot = await page.evaluate(EXTRACT_JS)
                visible_messages = snapshot['messages']
                if any(not m['source_message_id'] for m in visible_messages):
                    raise RuntimeError('메시지 식별자가 없는 화면 구조입니다. 순서·중복 검증 전에 저장하지 않습니다.')
                for message in visible_messages:
                    key = message['source_message_id']
                    if key in collected and collected[key]['role'] != message['role']:
                        raise RuntimeError('같은 메시지 ID의 발화자가 달라 수집을 중단했습니다.')
                    if key not in collected or message['content'].strip():
                        collected[key] = message
                signature = tuple((k, m['content']) for k, m in collected.items())
                stable = stable + 1 if signature == previous else 0
                previous = signature
                if stable >= 4:
                    stopped_stable = True
                    break
                # 공유 화면의 스크롤 컨테이너가 달라도 현재 마지막 발화를 기준으로 진행합니다.
                await page.locator('[data-message-role], [data-message-author-role]').last.scroll_into_view_if_needed()
                await page.keyboard.press('Control+End')
                await asyncio.sleep(1)

            messages = list(collected.values())
            if not messages:
                raise RuntimeError('수집한 발화가 없어 저장하지 않습니다.')
            missing = [m['source_message_id'] for m in messages if not m['body_found'] or not m['content'].strip()]
            if missing:
                raise RuntimeError('본문이 비어 있는 발화가 있습니다. 이미지 전용 발화인지 확인이 필요합니다: '
                                   + ', '.join(missing))
            for i, message in enumerate(messages, 1):
                message['sequence'] = i
                message.pop('body_found', None)
            return {
                'schema_version': 'shared_text_v1',
                'source_url': url,
                'captured_at': datetime.now(timezone.utc).isoformat(),
                'capture_method': 'playwright_rendered_text',
                'extractor_version': '1.1',
                'completeness': 'unverified',
                'conversation': {'title': await page.title(), 'messages': messages},
                'diagnostics': {
                    'message_count': len(messages),
                    'removed_ui_sections': sum(m.get('removed_ui_sections', 0) for m in messages),
                    'role_counts': dict(Counter(m['role'] for m in messages)),
                    'extraction_selector': snapshot['mode'],
                    'collection_rounds': round_no + 1,
                    'stopped_after_stable_content': stopped_stable,
                    'warnings': (["수집 회수 한도에 도달했습니다. 내용 안정화가 확인되지 않았습니다."] if not stopped_stable else []) + [
                        '공유 페이지에 표시된 텍스트이며 원본 JSON과의 일치는 미검증입니다.',
                        '이미지 원본은 수집하지 않습니다. 수식·표·Markdown 형식은 보장하지 않습니다.',
                        '코드 블록에 화면의 언어명 등 표시 요소가 포함될 수 있어 비교가 필요합니다.',
                        '수집 개수의 안정화는 전체 발화의 누락 없음을 보장하지 않습니다.'
                    ]
                }
            }
        finally:
            await browser.close()


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





async def import_shared_conversation(url: str, *, max_rounds: int = 40) -> dict:
    """공유 페이지 텍스트를 반환한다. DB·파일 저장 및 Luna 호출은 하지 않는다.

    conversation_id는 공유 URL의 ID로 고정되며 원래 비공개 채팅 ID가 아니다.
    capture_id는 수집 내용의 해시다. 내용이 바뀌면 달라진다.
    """
    record = await collect_shared_conversation(url, max_rounds=max_rounds)
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
    args = parser.parse_args()
    try:
        record = asyncio.run(import_shared_conversation(args.url))
        path, status = save_shared_capture(record, args.output_dir)
    except (ValueError, RuntimeError) as exc:
        parser.exit(1, f'수집 실패: {exc}\n')
    print(json.dumps({'status': status, 'file': str(path),
                      'message_count': record['diagnostics']['message_count'],
                      'completeness': record['completeness']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
