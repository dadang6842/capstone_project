"""providers.py 시험: 주소 판별, 리디렉션 검사, 서비스별 추출 (가짜 페이지, 네트워크 사용 안 함).

실행: collector 폴더에서 python -m unittest discover -s tests
Playwright Chromium이 없으면 브라우저 시험은 건너뛴다.
실제 ChatGPT /s/·Gemini·Claude 화면과 같은지는 `python collect.py --diag <주소>`로 따로 확인해야 한다.
"""
import asyncio
import os
import unittest
from unittest import mock

import collect
import providers

CHATGPT_S = '''<html><head><title>ChatGPT - 예약 작업 공유</title></head><body><main>
<div data-turn-key="t1"><div data-user-message-bubble>첫 질문</div></div>
<div data-turn-key="t2"><div class="markdown"><p>첫 답변</p><pre><code>const a = 1;</code></pre></div></div>
<div data-turn-key="t3"><div data-user-message-bubble>두 번째 질문</div></div>
<div data-turn-key="t4"><div class="markdown"><p>두 번째 답변</p></div></div>
<div data-turn-key="t5"><div data-user-message-bubble>세 번째 질문</div></div>
<div data-turn-key="tool"><div class="tool-chip"></div></div>
</main></body></html>'''

# 화면에 들어온 발화만 본문을 그리는 가상 스크롤 흉내 (ChatGPT 공유 페이지의 data-transcript-spacer 문제)
CHATGPT_S_VIRTUAL = '''<html><head><title>ChatGPT - 긴 대화</title></head><body><main id="m"></main><script>
const m = document.getElementById('m');
for (let i = 1; i <= 30; i++) {
  const d = document.createElement('div');
  d.setAttribute('data-turn-key', 'k' + i);
  d.style.height = '400px';
  d.dataset.role = i % 2 ? 'user' : 'assistant';
  m.appendChild(d);
}
function paint() {
  for (const d of m.children) {
    const r = d.getBoundingClientRect();
    const visible = r.bottom > 0 && r.top < innerHeight;
    const i = d.getAttribute('data-turn-key').slice(1);
    d.innerHTML = !visible ? '' : d.dataset.role === 'user'
      ? '<div data-user-message-bubble>질문 ' + i + '</div>'
      : '<div class="markdown">답변 ' + i + '</div>';
  }
}
addEventListener('scroll', paint); paint();
</script></body></html>'''

GEMINI = '''<html><head><title>Gemini - direct access to Google AI</title></head><body>
<share-turn-viewer>
<user-query><div class="query-text"><span class="cdk-visually-hidden">말씀하신 내용</span><p class="query-text-line">JWT는 어디에 저장해?</p></div></user-query>
<model-response><message-content><div class="markdown"><p>HttpOnly 쿠키를 권장합니다.</p><pre><code>res.cookie("rt", token)</code></pre></div></message-content></model-response>
<user-query><div class="query-text"><p class="query-text-line">Access Token은?</p></div></user-query>
<model-response><message-content><div class="markdown"><p>메모리에 둡니다.</p></div></message-content></model-response>
</share-turn-viewer></body></html>'''

CLAUDE = '''<html><head><title>Express 에러 처리 | Claude</title></head><body>
<div data-testid="user-message"><p>Express 5 에러 처리 방법?</p></div>
<div class="font-claude-response"><p>async 핸들러 오류가 자동으로 전달됩니다.</p><pre><code>app.use(errorHandler)</code></pre></div>
</body></html>'''

CHROMIUM = os.environ.get('CHROMIUM_EXECUTABLE')


def run(coro):
    return asyncio.run(coro)


class ParseShareUrlTests(unittest.TestCase):
    def test_supported_shapes(self):
        cases = {
            'https://chatgpt.com/share/6AF3FB20-85d0-83ec-84a7-783771ddb6cf/': ('chatgpt', 'share', 'https://chatgpt.com/share/6AF3FB20-85d0-83ec-84a7-783771ddb6cf'),
            'https://chatgpt.com/s/cx_6afc799ae73881919c0481c74461dc4a?x=1#y': ('chatgpt', 's', 'https://chatgpt.com/s/cx_6afc799ae73881919c0481c74461dc4a?x=1'),
            'https://chat.openai.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf': ('chatgpt', 'share', 'https://chat.openai.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf'),
            'https://g.co/gemini/share/abc123': ('gemini', 'short', 'https://g.co/gemini/share/abc123'),
            'https://gemini.google.com/share/abc123': ('gemini', 'share', 'https://gemini.google.com/share/abc123'),
            'https://gemini.google.com/u/1/share/abc123': ('gemini', 'share', 'https://gemini.google.com/u/1/share/abc123'),
            'https://claude.ai/share/0f1e2d3c-aaaa-bbbb-cccc-111122223333': ('claude', 'share', 'https://claude.ai/share/0f1e2d3c-aaaa-bbbb-cccc-111122223333'),
        }
        for url, (provider, kind, cleaned) in cases.items():
            with self.subTest(url=url):
                parsed = providers.parse_share_url(url)
                self.assertEqual((parsed[0], parsed[1], parsed[3]), (provider, kind, cleaned))

    def test_rejected_shapes(self):
        for url in ['http://chatgpt.com/share/abc', 'https://chatgpt.com/c/abc', 'https://evil.com/share/abc',
                    'https://chatgpt.com:8443/share/abc', 'https://u:p@claude.ai/share/abc', 'https://chat.openai.com/s/abc',
                    'https://gemini.google.com/app/abc', 'https://claude.ai/chat/abc', 'https://chatgpt.com.evil.com/share/abc']:
            with self.subTest(url=url):
                self.assertIsNone(providers.parse_share_url(url))

    def test_canonical_drops_account_and_query(self):
        self.assertEqual(providers.canonical_share_url('gemini', 'abc', 'share'), 'https://gemini.google.com/share/abc')
        self.assertEqual(providers.canonical_share_url('chatgpt', 'cx_A', 's'), 'https://chatgpt.com/s/cx_A')


class DispatchTests(unittest.TestCase):
    def test_chatgpt_share_goes_to_original_module(self):
        calls = []

        async def fake_module(url):
            calls.append(('module', url))
            return {}

        async def fake_other(url):
            calls.append(('other', url))
            return {}

        with mock.patch.object(collect, 'import_shared_conversation', fake_module), \
                mock.patch.object(collect, 'collect_other_share', fake_other):
            run(collect.collect('https://chat.openai.com/share/6AF3FB20-85d0-83ec-84a7-783771ddb6cf'))
            run(collect.collect('https://chatgpt.com/s/cx_1'))
            run(collect.collect('https://g.co/gemini/share/abc'))
        self.assertEqual(calls, [
            ('module', 'https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf'),
            ('other', 'https://chatgpt.com/s/cx_1'),
            ('other', 'https://g.co/gemini/share/abc'),
        ])

    def test_invalid_url_is_value_error(self):
        with self.assertRaises(ValueError):
            run(collect.collect('https://example.com/share/abc'))


def browser_available():
    """playwright 패키지와 Chromium이 모두 있어야 한다 (CI는 브라우저를 설치하지 않아 건너뜀)."""
    if CHROMIUM:
        return os.path.exists(CHROMIUM)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            return os.path.exists(pw.chromium.executable_path)
    except Exception:
        return False


class FakeSites:
    """가짜 HTTPS 서버 하나로 chatgpt.com·g.co·gemini.google.com·claude.ai 등을 흉내 낸다.
    Chromium의 --host-resolver-rules로 모든 호스트를 이 서버로 보내고, 인증서 오류는 무시한다.
    pages: {전체 주소: (상태, 본문 또는 리디렉션 주소)}. 진짜 HTTP 리디렉션이라 단계별 검사를 그대로 시험할 수 있다."""

    def __init__(self):
        import http.server
        import ssl
        import subprocess
        import tempfile
        import threading
        self.pages = {}
        self.dir = tempfile.mkdtemp()
        key, crt = os.path.join(self.dir, 'k.pem'), os.path.join(self.dir, 'c.pem')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt,
                        '-days', '1', '-subj', '/CN=fake'], check=True, capture_output=True)
        sites = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                url = 'https://' + self.headers['Host'].split(':')[0] + self.path
                status, body = sites.pages.get(url, (404, '<p>없음</p>'))
                self.send_response(status)
                if 300 <= status < 400:
                    self.send_header('Location', body)
                    self.end_headers()
                    return
                data = body.encode('utf-8')
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(crt, key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def openssl_available():
    import shutil
    return shutil.which('openssl') is not None


@unittest.skipUnless(browser_available() and openssl_available(), 'Playwright 또는 openssl이 없어 브라우저 시험을 건너뜀')
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sites = FakeSites()

    @classmethod
    def tearDownClass(cls):
        cls.sites.close()

    def collect_with(self, url, pages):
        self.sites.pages = pages
        port = self.sites.port

        async def launch(pw, headless):
            kwargs = {'executable_path': CHROMIUM} if CHROMIUM else {}
            return await pw.chromium.launch(headless=True, args=[
                '--no-sandbox', f'--host-resolver-rules=MAP * 127.0.0.1:{port}', '--no-proxy-server'], **kwargs)

        async def new_page(browser):
            context = await browser.new_context(ignore_https_errors=True)
            return await context.new_page()

        with mock.patch.object(providers, '_launch', launch), mock.patch.object(providers, '_new_page', new_page), \
                mock.patch.object(providers, 'TOTAL_LIMIT_SECONDS', 60):
            return run(providers.collect_other_share(url))

    def test_chatgpt_s_reads_turns_and_skips_non_message(self):
        url = 'https://chatgpt.com/s/cx_6afc799ae73881919c0481c74461dc4a'
        record = self.collect_with(url, {url: (200, CHATGPT_S)})
        messages = record['conversation']['messages']
        self.assertEqual([m['role'] for m in messages], ['user', 'assistant', 'user', 'assistant', 'user'])
        self.assertEqual([m['source_message_id'] for m in messages], ['t1', 't2', 't3', 't4', 't5'])
        self.assertEqual(messages[1]['code_blocks'], ['const a = 1;'])
        self.assertEqual(record['conversation']['title'], '예약 작업 공유')
        self.assertEqual(record['source_url'], url)
        self.assertTrue(record['capture_id'].startswith('share_'))

    def test_chatgpt_s_virtualized_scroll_keeps_all_bodies(self):
        url = 'https://chatgpt.com/s/cx_long'
        record = self.collect_with(url, {url: (200, CHATGPT_S_VIRTUAL)})
        messages = record['conversation']['messages']
        self.assertEqual(len(messages), 30)
        self.assertEqual(messages[0]['content'], '질문 1')
        self.assertEqual(messages[29]['content'], '답변 30')

    def test_gemini_short_link_follows_redirect_and_uses_final_url(self):
        short = 'https://g.co/gemini/share/SHORT1'
        final = 'https://gemini.google.com/share/FINAL99'
        record = self.collect_with(short, {short: (302, final), final: (200, GEMINI)})
        self.assertEqual(record['source_url'], final)
        messages = record['conversation']['messages']
        self.assertEqual([m['role'] for m in messages], ['user', 'assistant', 'user', 'assistant'])
        self.assertEqual(messages[0]['content'], 'JWT는 어디에 저장해?')
        self.assertEqual(messages[1]['code_blocks'], ['res.cookie("rt", token)'])
        # 일반 제목이면 첫 질문으로
        self.assertEqual(record['conversation']['title'], 'JWT는 어디에 저장해?')

        # 같은 대화를 최종 주소로 직접 넣어도 capture_id가 같다 (중복으로 잡힘)
        direct = self.collect_with(final, {final: (200, GEMINI)})
        self.assertEqual(direct['capture_id'], record['capture_id'])
        account = 'https://gemini.google.com/u/2/share/FINAL99'
        self.assertEqual(self.collect_with(account, {account: (200, GEMINI)})['capture_id'], record['capture_id'])

    def test_redirect_to_login_domain_is_blocked(self):
        short = 'https://g.co/gemini/share/PRIVATE'
        with self.assertRaises(RuntimeError) as ctx:
            self.collect_with(short, {short: (302, 'https://accounts.google.com/ServiceLogin?continue=x')})
        self.assertTrue(str(ctx.exception).startswith('공유 페이지 접근 실패'))
        self.assertEqual(collect.classify(ctx.exception), 'NOT_ACCESSIBLE')

    def test_redirect_to_non_share_path_is_not_accessible(self):
        url = 'https://claude.ai/share/limited'
        with self.assertRaises(RuntimeError) as ctx:
            self.collect_with(url, {url: (302, 'https://claude.ai/login?returnTo=x'), 'https://claude.ai/login?returnTo=x': (200, '<p>로그인</p>')})
        self.assertEqual(collect.classify(ctx.exception), 'NOT_ACCESSIBLE')

    def test_http_404_is_not_accessible(self):
        url = 'https://claude.ai/share/deleted'
        with self.assertRaises(RuntimeError) as ctx:
            self.collect_with(url, {url: (404, '<p>Not found</p>')})
        self.assertEqual(collect.classify(ctx.exception), 'NOT_ACCESSIBLE')

    def test_claude_public_share(self):
        url = 'https://claude.ai/share/0f1e2d3c-aaaa-bbbb-cccc-111122223333'
        record = self.collect_with(url, {url: (200, CLAUDE)})
        messages = record['conversation']['messages']
        self.assertEqual([m['role'] for m in messages], ['user', 'assistant'])
        self.assertEqual(messages[1]['code_blocks'], ['app.use(errorHandler)'])
        self.assertEqual(record['conversation']['title'], 'Express 에러 처리')

    def test_page_without_messages_is_unsupported(self):
        url = 'https://chatgpt.com/s/cx_task'
        with self.assertRaises(RuntimeError) as ctx:
            # 발화 칸은 있는데 사용자·답변 본문이 하나도 없는 페이지 (예약 작업 결과만 있는 화면 등)
            self.collect_with(url, {url: (200, '<main><div data-turn-key="x"><div class="tool-chip"></div></div></main>')})
        self.assertEqual(collect.classify(ctx.exception), 'UNSUPPORTED_CONTENT')


if __name__ == '__main__':
    unittest.main()