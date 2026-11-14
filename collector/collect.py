"""백엔드(Node)가 child_process로 실행하는 진입점.

사용: python collect.py <공유 URL>
결과는 stdout에 JSON 한 줄로만 쓴다 (Playwright 로그 등은 stderr).
  성공: {"ok": true, "captureId": "share_...", "title": "...", "messages": [{"sourceMessageId", "role", "content"}]}
  실패: {"ok": false, "code": "NOT_ACCESSIBLE|UNSUPPORTED_CONTENT|TIMEOUT|COLLECT_ERROR|INVALID_URL", "message": "..."}
종료 코드: 성공 0, 실패 1.
수집 모듈(shared_importer.py, share_input.py)은 고치지 않고 그대로 쓴다.
"""
import asyncio
import json
import sys

from shared_importer import import_shared_conversation

TITLE_MAX = 255

# 수집 모듈은 RuntimeError 메시지로만 원인을 알려 줘서, 메시지 앞부분으로 실패 원인을 나눈다.
# 모듈에 오류 코드(예외 클래스)가 생기면 이 표 대신 그것을 쓴다.
RUNTIME_ERROR_CODES = [
    ('공유 페이지 접근 실패', 'NOT_ACCESSIBLE'),
    ('발화 요소를 찾지 못했습니다', 'NOT_ACCESSIBLE'),
    ('메시지 식별자가 없는', 'UNSUPPORTED_CONTENT'),
    ('같은 메시지 ID의 발화자가', 'UNSUPPORTED_CONTENT'),
    ('수집한 발화가 없어', 'UNSUPPORTED_CONTENT'),
    ('본문이 비어 있는 발화', 'UNSUPPORTED_CONTENT'),
]


def classify(exc):
    if isinstance(exc, ValueError):
        return 'INVALID_URL'
    if type(exc).__name__ == 'TimeoutError':  # playwright TimeoutError (페이지 로딩 60초 초과 등)
        return 'TIMEOUT'
    if type(exc).__name__ == 'CollectionIncompleteError':
       return 'TIMEOUT'
    if isinstance(exc, RuntimeError):
        for prefix, code in RUNTIME_ERROR_CODES:
            if str(exc).startswith(prefix):
                return code
    return 'COLLECT_ERROR'


def clean_title(title):
    title = (title or '').strip()
    if title.startswith('ChatGPT - '):
        title = title[len('ChatGPT - '):].strip()
    return title[:TITLE_MAX] or None


def to_output(record):
    return {
        'ok': True,
        'captureId': record['capture_id'],  # 링크+대화 내용 해시. 내용이 추가되면 달라진다
        'title': clean_title(record['conversation']['title']),
        # 추천 질문을 뺀 content만 쓴다 (content_raw·code_blocks는 저장하지 않음, code는 content에 포함돼 있음)
        'messages': [
            {'sourceMessageId': m['source_message_id'], 'role': m['role'].upper(), 'content': m['content']}
            for m in record['conversation']['messages']
        ],
    }


def write(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main(argv):
    if len(argv) != 2:
        write({'ok': False, 'code': 'INVALID_URL', 'message': '사용법: python collect.py <공유 URL>'})
        return 1
    try:
        record = asyncio.run(import_shared_conversation(argv[1]))
    except Exception as exc:  # 어떤 오류든 JSON으로 알려 준다 (원문 메시지는 Node가 로그에만 남김)
        write({'ok': False, 'code': classify(exc), 'message': f'{type(exc).__name__}: {exc}'[:1000]})
        return 1
    write(to_output(record))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))