"""기존 FastMCP 인스턴스에 도구만 추가한다. 서버 실행·인증은 호스트에서 처리한다."""
import asyncio
from shared_importer import import_shared_conversation, save_shared_capture
from share_input import resolve_share_input, MultipleShareLinksError


def register_import_tool(mcp, save_capture):
    """save_capture(record)는 사용자별 저장을 수행하는 async 콜백이다.

    콜백은 실제 저장 완료 후 conversation_id, capture_id, status 등을 반환한다.
    인증 사용자 확인은 MCP 호스트/콜백에서 수행한다. 모델 인자로 user_id를 받지 않는다.
    """
    browser_slot = asyncio.Semaphore(1)

    @mcp.tool()
    async def import_shared_conversation_url(url: str) -> dict:
        """사용자가 명시적으로 제공한 ChatGPT 공유 링크의 텍스트를 플랫폼에 저장합니다.

        전체 대화를 직접 재작성하지 말고 공유 URL만 전달하세요.
        공개 공유 페이지에 표시된 텍스트를 수집하며 완전성은 미검증입니다.
        """
        try:
            selected_url = resolve_share_input(url)
        except MultipleShareLinksError as exc:
            return {'status': 'needs_selection', 'candidates': exc.candidates,
                    'message': '가져올 공유 링크 하나를 선택해 주세요.'}
        except ValueError as exc:
            return {'status': 'invalid_input', 'message': str(exc)}
        async with browser_slot:
            record = await import_shared_conversation(selected_url)
        result = await save_capture(record)
        return {
            **result,
            'title': record['conversation']['title'],
            'saved_message_count': record['diagnostics']['message_count'],
            'completeness': record['completeness'],
        }

    return import_shared_conversation_url


def register_local_import_tool(mcp, directory):
    """Colab 개인 시험 전용. 플랫폼에서는 인증된 사용자별 DB 콜백을 사용한다."""
    async def save_local(record):
        path, status = await asyncio.to_thread(save_shared_capture, record, directory)
        return {'status': status, 'conversation_id': record['conversation_id'],
                'capture_id': record['capture_id'], 'saved_file': str(path)}

    return register_import_tool(mcp, save_local)
