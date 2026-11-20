"""ChatGPT 커넥터용 MCP 서버.

손요한의 mcp_adapter.register_import_tool에 인증(토큰 검사)과 저장 콜백을 붙여 HTTP로 띄운다.
  - 주소: https://ai-archive.shop/mcp (Nginx가 이 컨테이너 8000번으로 넘김)
  - 인증: ChatGPT가 붙여 보내는 access token(백엔드 /oauth/token이 발급, HS256)을 FastMCP가 검사한다.
          토큰이 없거나 틀리면 401 + 보호 리소스 메타데이터 주소를 알려 줘서 ChatGPT가 로그인 화면을 띄운다.
  - 저장: 수집이 끝나면 같은 토큰을 그대로 백엔드 POST /api/v1/mcp/captures에 넘긴다.
          user_id는 백엔드가 토큰의 sub에서 꺼낸다 (모델이 user_id를 넘기지 않는다).
실행: python mcp_server.py  (collector/ 폴더에서)
"""
import os

import httpx
from fastmcp import FastMCP
from fastmcp.server.auth import RemoteAuthProvider
from fastmcp.server.auth.providers.jwt import JWTVerifier
from fastmcp.server.dependencies import get_access_token

from collect import to_output
from mcp_adapter import register_import_tool

PUBLIC_URL = os.environ.get('MCP_PUBLIC_URL', 'https://ai-archive.shop').rstrip('/')
# 끝에 /를 붙인다. FastMCP가 authorization_servers를 이 모양으로 바꿔 알려 주고, 백엔드 issuer도 같은 값이다
ISSUER = PUBLIC_URL + '/'
RESOURCE = PUBLIC_URL + '/mcp'
BACKEND_URL = os.environ.get('BACKEND_INTERNAL_URL', 'http://app:3000').rstrip('/')
SAVE_TIMEOUT_SECONDS = 60

verifier = JWTVerifier(
    public_key=os.environ['MCP_JWT_SECRET'],  # HS256은 공유 비밀키를 public_key 자리에 넣는다
    algorithm='HS256',
    issuer=ISSUER,
    audience=RESOURCE,
)
auth = RemoteAuthProvider(
    token_verifier=verifier,
    authorization_servers=[ISSUER],
    base_url=PUBLIC_URL,  # MCP 경로(/mcp)는 빼고 도메인만. 메타데이터는 /.well-known/oauth-protected-resource/mcp
    resource_name='AI Archive',
)
mcp = FastMCP(
    'AI Archive',
    instructions='사용자가 ChatGPT 공유 링크(https://chatgpt.com/share/...)를 주며 저장을 요청하면 '
                 'import_shared_conversation_url 도구에 링크를 넘겨 AI Archive에 저장합니다.',
    auth=auth,
)


async def save_capture(record):
    """어댑터가 수집을 끝낸 뒤 부른다. 지금 도구를 부른 사용자의 토큰으로 백엔드에 저장한다."""
    token = get_access_token()
    if token is None:  # auth가 켜져 있어서 실제로는 오지 않는다
        raise RuntimeError('로그인 정보가 없습니다. ChatGPT에서 AI Archive 연결을 다시 해 주세요.')

    payload = to_output(record)  # collect.py와 같은 모양 {captureId, title, messages}
    payload.pop('ok', None)
    payload['shareUrl'] = record['source_url']

    async with httpx.AsyncClient(timeout=SAVE_TIMEOUT_SECONDS) as client:
        res = await client.post(
            f'{BACKEND_URL}/api/v1/mcp/captures',
            json=payload,
            headers={'Authorization': f'Bearer {token.token}'},
        )
    if res.status_code == 401:
        raise RuntimeError('로그인이 만료되었습니다. ChatGPT에서 AI Archive 연결을 다시 해 주세요.')
    if res.status_code >= 400:
        try:
            message = res.json()['error']['message']
        except Exception:
            message = f'HTTP {res.status_code}'
        raise RuntimeError(f'저장하지 못했습니다: {message}')
    return res.json()['data']  # {status: saved|duplicated, conversationId, message}


register_import_tool(mcp, save_capture)

if __name__ == '__main__':
    mcp.run(transport='http', host='0.0.0.0', port=int(os.environ.get('MCP_PORT', '8000')), path='/mcp')