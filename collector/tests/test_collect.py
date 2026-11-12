import asyncio
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest import mock

import collect

URL = 'https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf'
RECORD = {'capture_id': 'share_abc', 'conversation': {'title': 'ChatGPT - JWT 정리', 'messages': [
    {'source_message_id': 'm1', 'role': 'user', 'content': '질문', 'code_blocks': []},
    {'source_message_id': 'm2', 'role': 'assistant', 'content': '답변', 'content_raw': '답변 + 추천 질문'}]}}


def run(record=None, error=None):
    async def fake(url):
        if error:
            raise error
        return record
    out = io.StringIO()
    with mock.patch.object(collect, 'import_shared_conversation', fake), redirect_stdout(out):
        code = collect.main(['collect.py', URL])
    return code, json.loads(out.getvalue())


class CollectEntryTests(unittest.TestCase):
    def test_success_outputs_clean_messages_only(self):
        code, payload = run(record=RECORD)
        self.assertEqual(code, 0)
        self.assertEqual(payload, {'ok': True, 'captureId': 'share_abc', 'title': 'JWT 정리', 'messages': [
            {'sourceMessageId': 'm1', 'role': 'USER', 'content': '질문'},
            {'sourceMessageId': 'm2', 'role': 'ASSISTANT', 'content': '답변'}]})

    def test_failure_codes(self):
        PlaywrightTimeout = type('TimeoutError', (Exception,), {})
        cases = [
            (RuntimeError('공유 페이지 접근 실패: HTTP 404. 차단을 우회하지 않습니다.'), 'NOT_ACCESSIBLE'),
            (RuntimeError('발화 요소를 찾지 못했습니다. 로그인·접근 제한...'), 'NOT_ACCESSIBLE'),
            (RuntimeError('본문이 비어 있는 발화가 있습니다. ...: m3'), 'UNSUPPORTED_CONTENT'),
            (PlaywrightTimeout('Timeout 60000ms exceeded'), 'TIMEOUT'),
            (ValueError('https://chatgpt.com/share/공유ID 형태의 링크를 입력해 주세요.'), 'INVALID_URL'),
            (RuntimeError('먼저 requirements.txt와 Playwright Chromium을 설치해 주세요.'), 'COLLECT_ERROR'),
        ]
        for error, expected in cases:
            with self.subTest(expected=expected):
                code, payload = run(error=error)
                self.assertEqual(code, 1)
                self.assertFalse(payload['ok'])
                self.assertEqual(payload['code'], expected)

    def test_title_fallback(self):
        self.assertIsNone(collect.clean_title('  '))
        self.assertEqual(len(collect.clean_title('가' * 300)), 255)


if __name__ == '__main__':
    unittest.main()