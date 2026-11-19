"""ChatGPT /share/ 밖의 공유 링크(ChatGPT /s/, Gemini, Claude) 수집. 백엔드가 만든 파일 (2026-11-18).

손요한의 수집 모듈(shared_importer.py)은 https://chatgpt.com/share/{UUID}만 받아서 고치지 않고 그대로 두고,
나머지 주소는 이 파일이 Playwright로 직접 읽는다. 결과는 shared_importer와 같은 record 모양으로 돌려준다.

  - 주소 규칙은 src/utils/shareUrl.ts와 같다 (SHARE_ROUTES). 한쪽을 고치면 같이 고친다
  - 리디렉션은 페이지 이동(메인 프레임)마다 서비스 도메인인지 확인하고, 다른 도메인(로그인 화면 등)으로 가면 막고 접근 실패로 본다
  - 최종 주소가 같은 서비스의 공유 페이지 형태여야 한다. 중복 판단(capture_id)은 최종 주소 기준
  - 서비스마다 화면 구조가 달라 추출 스크립트를 따로 둔다 (EXTRACTORS)

주의: ChatGPT /s/는 프론트가 실제 링크로 확인한 구조(main [data-turn-key])를 따랐고,
Gemini·Claude 선택자는 실제 공개 링크로 아직 검증하지 않았다. `python collect.py --diag <주소>`로 화면 구조를 확인한다.
"""
import asyncio
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

ID = r'([A-Za-z0-9_-]{1,200})'

# provider, 허용 호스트, 경로, 쿼리 보존
SHARE_ROUTES = [
    ('chatgpt', ('chatgpt.com', 'chat.openai.com'), re.compile(r'^/share/' + ID + r'$'), False),
    ('chatgpt', ('chatgpt.com',), re.compile(r'^/s/' + ID + r'$'), True),
    ('gemini', ('gemini.google.com',), re.compile(r'^/(?:u/\d{1,3}/)?share/' + ID + r'$'), True),
    ('gemini', ('g.co',), re.compile(r'^/gemini/share/' + ID + r'$'), True),
    ('claude', ('claude.ai',), re.compile(r'^/share/' + ID + r'$'), True),
]

# 리디렉션 중에 지나가도 되는 호스트 (메인 프레임 이동만 검사. 이미지·스크립트 같은 하위 요청은 검사하지 않음)
NAVIGATION_HOSTS = {
    'chatgpt': {'chatgpt.com', 'chat.openai.com'},
    'gemini': {'g.co', 'gemini.google.com'},
    'claude': {'claude.ai'},
}

TOTAL_LIMIT_SECONDS = 200  # 백엔드 타임아웃(COLLECTOR_TIMEOUT_MS 기본 240초)보다 짧게
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


class CollectionIncompleteError(RuntimeError):
    """전체 수집 제한 시간 초과. collect.py가 TIMEOUT으로 분류한다 (shared_importer 2.0과 같은 이름)."""


def parse_share_url(url):
    """(provider, kind, share_id, 정리한 주소) 또는 None. kind: share / s / short"""
    if not isinstance(url, str):
        return None
    parts = urlsplit(url.strip())
    host = (parts.hostname or '').lower()
    if parts.scheme != 'https' or parts.username or parts.password or parts.port:
        return None
    path = parts.path.rstrip('/')
    for provider, hosts, pattern, keep_query in SHARE_ROUTES:
        match = host in hosts and pattern.match(path)
        if not match:
            continue
        kind = 's' if path.startswith('/s/') else 'short' if host == 'g.co' else 'share'
        return provider, kind, match.group(1), urlunsplit(('https', host, path, parts.query if keep_query else '', ''))
    return None


def canonical_share_url(provider, share_id, kind):
    """중복 판단에 쓰는 최종 주소. 계정 번호(u/N)·쿼리·#은 뺀다."""
    if provider == 'chatgpt':
        if kind == 's':
            return f'https://chatgpt.com/s/{share_id}'
        return f'https://chatgpt.com/share/{share_id.lower() if UUID_RE.match(share_id) else share_id}'
    if provider == 'gemini':
        return f'https://gemini.google.com/share/{share_id}'
    return f'https://claude.ai/share/{share_id}'


def capture_id_for(source_url, title, messages):
    """shared_importer와 같은 방식: 최종 주소 + 제목 + 발화 내용의 SHA-256. 내용이 늘면 달라진다."""
    payload = {'source_url': source_url, 'conversation': {
        'title': title, 'messages': [{'role': m['role'], 'content': m['content']} for m in messages]}}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return 'share_' + hashlib.sha256(canonical.encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------
# 서비스별 추출 스크립트. 화면에 보이는 발화를 문서 순서대로 [{key, role, content, code_blocks, body_found}]로 돌려준다
# key가 없으면(null) 순서로만 구분하고, 끝까지 스크롤한 뒤 한 번에 읽는다
# ---------------------------------------------------------------------------
COMMON_JS = r"""
const codesOf = (body) => body ? Array.from(body.querySelectorAll('pre')).map(pre => {
    const c = pre.querySelector('code');
    return c ? c.textContent : pre.innerText;
}) : [];
const outermost = (nodes) => nodes.filter(n => !nodes.some(o => o !== n && o.contains(n)));
const textOf = (el) => el ? el.innerText.replace(/​/g, '').trim() : '';
"""

EXTRACTORS = {
    # ChatGPT /s/: 프론트가 2026-11-18 실제 링크로 확인한 구조. 발화마다 main [data-turn-key]가 있고 그 안에 사용자 말풍선이나 Markdown 응답
    # data-message-author-role이 있으면 그것을 먼저 쓴다
    'chatgpt_s': COMMON_JS + r"""
let turns = Array.from(document.querySelectorAll('main [data-turn-key]'));
const keyAttr = turns.length ? 'data-turn-key' : 'data-message-id';
if (!turns.length) turns = outermost(Array.from(document.querySelectorAll('[data-message-author-role]')));
return turns.map((turn, i) => {
    const roleNode = turn.matches('[data-message-author-role]') ? turn : turn.querySelector('[data-message-author-role]');
    let role = roleNode ? roleNode.getAttribute('data-message-author-role') : (turn.getAttribute('data-turn') || '');
    const userBody = turn.querySelector('[data-user-message-bubble], [data-user-message-copy], .whitespace-pre-wrap');
    const mdBody = turn.querySelector('[data-assistant-markdown-root], [data-assistant-markdown], .markdown');
    if (!['user', 'assistant'].includes(role)) role = mdBody ? 'assistant' : userBody ? 'user' : '';
    if (!role) return null;  // 발화가 아닌 칸 (도구 표시, 빈 자리)
    const body = role === 'user' ? (userBody || roleNode) : mdBody;
    return {key: turn.getAttribute(keyAttr) || turn.id || null, role, content: textOf(body),
            code_blocks: codesOf(body), body_found: Boolean(body)};
}).filter(Boolean);
""",
    # Gemini 공개 공유 페이지: user-query(질문) / model-response(답변) 커스텀 요소 (실제 링크 미검증)
    'gemini': COMMON_JS + r"""
const turns = outermost(Array.from(document.querySelectorAll('user-query, model-response, [data-test-id="user-query"], [data-test-id="model-response"]')));
return turns.map((turn) => {
    const isUser = turn.matches('user-query, [data-test-id="user-query"]');
    let body;
    if (isUser) {
        body = turn.querySelector('.query-text') || turn.querySelector('.user-query-bubble-with-background') || turn;
        // 화면에만 있는 "말씀하신 내용"/"You said" 같은 라벨은 cdk-visually-hidden이라 innerText에 거의 안 나오지만, 남으면 뺀다
    } else {
        body = turn.querySelector('message-content .markdown') || turn.querySelector('message-content') || turn.querySelector('.markdown');
    }
    let content = textOf(body);
    if (isUser) content = content.replace(/^(You said|말씀하신 내용)\s*/i, '');
    return {key: null, role: isUser ? 'user' : 'assistant', content, code_blocks: codesOf(body), body_found: Boolean(body)};
});
""",
    # Claude 공개 공유 페이지: 사용자 [data-testid="user-message"], 답변 .font-claude-response / .font-claude-message (실제 링크 미검증)
    'claude': COMMON_JS + r"""
const turns = outermost(Array.from(document.querySelectorAll('[data-testid="user-message"], .font-claude-response, .font-claude-message, [data-testid="assistant-message"]')));
return turns.map((turn) => {
    const isUser = turn.matches('[data-testid="user-message"]');
    return {key: null, role: isUser ? 'user' : 'assistant', content: textOf(turn), code_blocks: codesOf(turn), body_found: true};
});
""",
}

WAIT_SELECTORS = {
    'chatgpt_s': 'main [data-turn-key], [data-message-author-role]',
    'gemini': 'user-query, model-response, [data-test-id="user-query"]',
    'claude': '[data-testid="user-message"], .font-claude-response, .font-claude-message',
}

# 대화 제목이 아닌 서비스 기본 제목 (이러면 첫 질문 앞부분을 제목으로)
GENERIC_TITLES = re.compile(r'^(chatgpt|gemini|claude|claude\.ai|google gemini|.*direct access to google ai.*|gemini - .*)$', re.IGNORECASE)


def clean_title(title, messages):
    title = (title or '').replace('‎', '').strip()
    for prefix in ('ChatGPT - ', 'Gemini - '):
        if title.startswith(prefix):
            title = title[len(prefix):].strip()
    for suffix in (' - Claude', ' | Claude', ' - Gemini', ' - ChatGPT'):
        if title.endswith(suffix):
            title = title[:-len(suffix)].strip()
    if not title or GENERIC_TITLES.match(title):
        first = next((m['content'] for m in messages if m['role'] == 'user'), '')
        title = first.splitlines()[0][:60] if first else ''
    return title or None


async def _launch(pw, headless):
    return await pw.chromium.launch(headless=headless, args=['--no-sandbox'])


async def _new_page(browser):
    context = await browser.new_context(viewport={'width': 1280, 'height': 900}, locale='ko-KR')
    return await context.new_page()


def _extractor_key(provider, kind):
    return 'chatgpt_s' if provider == 'chatgpt' else provider


async def _scroll_through(page, deadline, read=None):
    """위에서 아래로 한 화면씩 내리며 지연 로딩·가상 스크롤을 깨운다. read가 있으면 매 화면 읽어서 넘긴다."""
    await page.evaluate('() => window.scrollTo(0, 0)')
    last_height = -1
    stable = 0
    for _ in range(400):
        if time.monotonic() > deadline:
            raise CollectionIncompleteError('전체 수집 제한 시간을 넘었습니다.')
        if read:
            await read()
        moved = await page.evaluate(r"""() => {
            // 페이지 자체가 아니라 안쪽 상자가 스크롤되는 화면도 있어서, 가장 큰 스크롤 상자를 같이 내린다
            const boxes = Array.from(document.querySelectorAll('main, [class*="overflow-y"], infinite-scroller, .chat-history'))
                .filter(el => el.scrollHeight > el.clientHeight + 10);
            const box = boxes.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
            const before = box ? box.scrollTop : window.scrollY;
            if (box) box.scrollTop += box.clientHeight * 0.8;
            window.scrollBy(0, window.innerHeight * 0.8);
            const after = box ? box.scrollTop : window.scrollY;
            return {moved: after !== before || window.scrollY + window.innerHeight < document.body.scrollHeight - 2,
                    height: (box ? box.scrollHeight : 0) + document.body.scrollHeight};
        }""")
        await asyncio.sleep(0.4)
        stable = stable + 1 if (not moved['moved'] and moved['height'] == last_height) else 0
        last_height = moved['height']
        if stable >= 3:
            break
    if read:
        await read()


async def extract_messages(page, extractor, deadline):
    """현재 페이지에서 발화를 읽는다. key가 있는 화면은 스크롤하며 쌓고, 없는 화면은 끝까지 내린 뒤 한 번에 읽는다."""
    script = '() => {' + EXTRACTORS[extractor] + '}'
    collected = {}
    order = []
    keyed = {'value': None}

    async def read():
        for item in await page.evaluate(script):
            if keyed['value'] is None:
                keyed['value'] = item['key'] is not None
            if not keyed['value']:
                return
            key = item['key']
            if key is None:
                raise RuntimeError('메시지 식별자가 없는 화면 구조입니다. 순서·중복 검증 전에 저장하지 않습니다.')
            if key in collected and collected[key]['role'] != item['role']:
                raise RuntimeError('같은 메시지 ID의 발화자가 달라 수집을 중단했습니다.')
            if key not in collected:
                order.append(key)
            # 가상 스크롤로 화면 밖 발화가 빈 칸이 되면 본문이 빈 값으로 읽히므로, 본문이 있을 때만 덮어쓴다
            if key not in collected or item['content']:
                collected[key] = item

    await _scroll_through(page, deadline, read)
    if keyed['value']:
        messages = [collected[k] for k in order]
    else:
        # 키 없는 화면: 끝까지 내려서 다 그려진 뒤 두 번 읽어 개수가 같을 때만 쓴다
        first = await page.evaluate(script)
        await asyncio.sleep(1)
        messages = await page.evaluate(script)
        if len(first) != len(messages):
            raise CollectionIncompleteError('화면이 계속 바뀌어 발화 수가 안정되지 않았습니다.')
        for i, message in enumerate(messages, 1):
            message['key'] = f'{extractor}-{i}'
    return messages


async def collect_other_share(url, *, headless=True):
    """shared_importer.import_shared_conversation과 같은 record를 돌려준다 (capture_id 포함)."""
    parsed = parse_share_url(url)
    if not parsed:
        raise ValueError('지원하지 않는 공유 링크 형식입니다.')
    provider, kind, _, url = parsed
    try:
        from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
    except ImportError as exc:
        raise RuntimeError('먼저 requirements.txt와 Playwright Chromium을 설치해 주세요.') from exc

    deadline = time.monotonic() + TOTAL_LIMIT_SECONDS
    allowed_hosts = NAVIGATION_HOSTS[provider]
    navigations = []
    blocked = []  # 서비스 도메인 밖으로 간 이동
    extractor = _extractor_key(provider, kind)

    async with async_playwright() as pw:
        browser = await _launch(pw, headless)
        try:
            page = await _new_page(browser)

            # 메인 프레임 이동마다(HTTP 리디렉션 한 단계씩, 스크립트 이동 포함) 주소를 기록하고 서비스 도메인인지 확인한다
            # (로그인·동의 화면 등 다른 도메인으로 가면 접근 실패. 페이지 요청 이벤트는 리디렉션 단계마다 새로 생긴다)
            def on_request(request):
                if request.is_navigation_request() and request.frame == page.main_frame:
                    navigations.append(request.url)
                    if (urlsplit(request.url).hostname or '').lower() not in allowed_hosts:
                        blocked.append(request.url)

            def check_hops():
                if blocked:
                    raise RuntimeError(f'공유 페이지 접근 실패: 허용하지 않은 주소로 이동했습니다 ({urlsplit(blocked[0]).hostname}). '
                                       '로그인이 필요하거나 비공개 링크일 수 있습니다.')

            page.on('request', on_request)
            try:
                response = await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            except Exception:
                check_hops()
                raise
            check_hops()
            if response and response.status >= 400:
                raise RuntimeError(f'공유 페이지 접근 실패: HTTP {response.status}. 차단을 우회하지 않습니다.')

            final = parse_share_url(page.url)
            if not final or final[0] != provider or final[1] == 'short':
                raise RuntimeError(f'공유 페이지 접근 실패: 최종 주소가 공유 페이지가 아닙니다 ({urlsplit(page.url).hostname}{urlsplit(page.url).path}).')
            final_provider, final_kind, final_id, _ = final
            source_url = canonical_share_url(final_provider, final_id, final_kind)

            try:
                await page.locator(WAIT_SELECTORS[extractor]).first.wait_for(state='attached', timeout=45000)
            except PlaywrightTimeout as exc:
                visible = (await page.locator('body').inner_text())[:800]
                raise RuntimeError('발화 요소를 찾지 못했습니다. 로그인·접근 제한 또는 페이지 구조를 확인해 주세요.\n' + visible) from exc

            messages = await extract_messages(page, extractor, deadline)
            check_hops()  # 읽는 동안 스크립트가 로그인 화면 등으로 옮겼는지
            if parse_share_url(page.url) is None:
                raise RuntimeError('공유 페이지 접근 실패: 읽는 중에 공유 페이지를 벗어났습니다.')
            if not messages:
                raise RuntimeError('수집한 발화가 없어 저장하지 않습니다.')
            missing = [m['key'] for m in messages if not m['body_found'] or not m['content'].strip()]
            if missing:
                raise RuntimeError('본문이 비어 있는 발화가 있습니다. 이미지 전용 발화인지 확인이 필요합니다: ' + ', '.join(missing))

            title = clean_title(await page.title(), messages)
            out_messages = [{
                'sequence': i,
                'source_message_id': str(m['key'])[:100],
                'role': m['role'],
                'content': m['content'],
                'code_blocks': m['code_blocks'],
            } for i, m in enumerate(messages, 1)]
            return {
                'schema_version': 'shared_text_v1',
                'provider': provider,
                'source_url': source_url,
                'input_url': url,
                'navigations': navigations,
                'captured_at': datetime.now(timezone.utc).isoformat(),
                'capture_method': 'playwright_rendered_text',
                'extractor_version': f'backend-{extractor}-1.0',
                'capture_id': capture_id_for(source_url, title, out_messages),
                'conversation': {'title': title, 'messages': out_messages},
            }
        finally:
            await browser.close()


async def diagnose(url, headless=True):
    """화면 구조 진단 (저장 안 함). 선택자별 개수와 앞부분 본문을 보여 준다."""
    from playwright.async_api import async_playwright
    parsed = parse_share_url(url)
    async with async_playwright() as pw:
        browser = await _launch(pw, headless)
        try:
            page = await _new_page(browser)
            navigations = []
            page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
            response = await page.goto(parsed[3] if parsed else url, wait_until='domcontentloaded', timeout=60000)
            await asyncio.sleep(8)
            counts = await page.evaluate(r"""() => Object.fromEntries([
                'main [data-turn-key]', '[data-message-author-role]', '[data-message-role]', '[data-user-message-bubble]',
                '.markdown', 'user-query', 'model-response', 'message-content', '[data-test-id="user-query"]',
                '[data-testid="user-message"]', '.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]', 'pre'
            ].map(s => [s, document.querySelectorAll(s).length]))""")
            result = {'parsed': parsed[:3] if parsed else None, 'status': response.status if response else None,
                      'navigations': navigations, 'finalUrl': page.url, 'title': await page.title(), 'selectorCounts': counts,
                      'bodyStart': (await page.locator('body').inner_text())[:1500]}
            if parsed:
                extractor = _extractor_key(parsed[0], parsed[1])
                items = await page.evaluate('() => {' + EXTRACTORS[extractor] + '}')
                result['extracted'] = [{'key': m['key'], 'role': m['role'], 'chars': len(m['content']), 'start': m['content'][:80]}
                                       for m in items[:20]]
            return result
        finally:
            await browser.close()