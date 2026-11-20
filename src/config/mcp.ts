import "dotenv/config";
import { z } from "zod";

// ChatGPT 커넥터(MCP)용 OAuth 설정.
// 기존 env.ts와 따로 둔 이유: 값이 하나라도 비어 있으면 OAuth·MCP 저장 API를 아예 켜지 않기 위해서 (로컬 개발에는 필요 없음)
const mcpEnvSchema = z.object({
    // 서비스 주소. 끝에 / 없이 (예: https://ai-archive.shop)
    MCP_PUBLIC_URL: z.string().default("https://ai-archive.shop"),
    // ChatGPT용 토큰 서명 키 (HS256). 웹 로그인 키(JWT_ACCESS_SECRET)와 다른 값. MCP 서버(Python)에도 같은 값을 넣는다
    MCP_JWT_SECRET: z.string().default(""),
    // ChatGPT 등록 화면 "사용자 정의 OAuth 클라이언트"에 넣는 값과 같게
    MCP_OAUTH_CLIENT_ID: z.string().default(""),
    MCP_OAUTH_CLIENT_SECRET: z.string().default(""),
    // (선택) ChatGPT 콜백 URL 말고 더 허용할 주소. 쉼표로 여러 개. 보통은 비워 둔다
    //  ChatGPT 콜백 URL(https://chatgpt.com/connector/oauth/... 와 connector_platform_oauth_redirect)은 이 값 없이도 허용한다
    //  (개발자 모드로 등록하는 사람마다 콜백 URL이 달라서, 하나씩 넣지 않게)
    MCP_OAUTH_EXTRA_REDIRECT_URIS: z.string().default(""),
});

const raw = mcpEnvSchema.parse(process.env);
const publicUrl = raw.MCP_PUBLIC_URL.replace(/\/+$/, "");

export const mcpConfig = {
    jwtSecret: raw.MCP_JWT_SECRET,
    clientId: raw.MCP_OAUTH_CLIENT_ID,
    clientSecret: raw.MCP_OAUTH_CLIENT_SECRET,
    extraRedirectUris: raw.MCP_OAUTH_EXTRA_REDIRECT_URIS.split(",")
        .map((uri) => uri.trim())
        .filter(Boolean),
    publicUrl,
    // issuer는 끝에 /를 붙인다. MCP 서버(FastMCP)가 authorization_servers를 "https://ai-archive.shop/"로 알려 주는데
    // ChatGPT가 이 값과 issuer를 글자 그대로 비교하기 때문
    issuer: `${publicUrl}/`,
    // MCP 엔드포인트 주소 = 토큰의 aud
    resource: `${publicUrl}/mcp`,
    enabled: Boolean(raw.MCP_JWT_SECRET && raw.MCP_OAUTH_CLIENT_ID && raw.MCP_OAUTH_CLIENT_SECRET),
};
