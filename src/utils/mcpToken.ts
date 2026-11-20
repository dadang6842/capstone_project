import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { mcpConfig } from "../config/mcp.js";

// ChatGPT 커넥터용 토큰. 모두 MCP_JWT_SECRET(HS256)으로 서명한다.
//  - authorization code: 로그인 직후 ChatGPT에 주는 5분짜리 일회용 쪽지. DB에 저장하지 않으려고 JWT로 만든다
//  - access token: ChatGPT가 MCP 서버를 부를 때 붙이는 출입증. sub = userId, aud = MCP 주소
// refresh token은 웹 로그인과 같은 방식(utils/jwt.ts의 signRefreshToken + refresh_tokens 테이블)을 쓴다

const CODE_EXPIRES_IN_SEC = 5 * 60;
export const MCP_ACCESS_EXPIRES_IN_SEC = 60 * 60;

export type AuthCodePayload = { typ: "oauth_code"; userId: number; redirectUri: string; codeChallenge: string };

export function signAuthCode(payload: Omit<AuthCodePayload, "typ">) {
    return jwt.sign({ typ: "oauth_code", ...payload }, mcpConfig.jwtSecret, {
        algorithm: "HS256",
        issuer: mcpConfig.issuer,
        expiresIn: CODE_EXPIRES_IN_SEC,
    });
}

// 서명·만료가 틀리거나 code가 아닌 토큰(access token 등)이면 null
export function verifyAuthCode(code: string): AuthCodePayload | null {
    try {
        const payload = jwt.verify(code, mcpConfig.jwtSecret, { algorithms: ["HS256"], issuer: mcpConfig.issuer });
        if (typeof payload === "string" || payload.typ !== "oauth_code") return null;
        return payload as unknown as AuthCodePayload;
    } catch {
        return null;
    }
}

// code에는 aud가 없어서 MCP 서버·아래 verifyMcpAccessToken에서 access token으로 통하지 않는다
export function signMcpAccessToken(userId: number) {
    return jwt.sign({ client_id: mcpConfig.clientId }, mcpConfig.jwtSecret, {
        algorithm: "HS256",
        subject: String(userId),
        issuer: mcpConfig.issuer,
        audience: mcpConfig.resource,
        expiresIn: MCP_ACCESS_EXPIRES_IN_SEC,
    });
}

// 서명·iss·aud·만료를 확인하고 userId를 돌려준다. 문제가 있으면 에러를 던진다
export function verifyMcpAccessToken(token: string): number {
    const payload = jwt.verify(token, mcpConfig.jwtSecret, {
        algorithms: ["HS256"],
        issuer: mcpConfig.issuer,
        audience: mcpConfig.resource,
    });
    const userId = typeof payload === "string" ? NaN : Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("토큰의 sub가 올바르지 않습니다.");
    return userId;
}

// PKCE(S256): base64url(sha256(code_verifier)) === code_challenge
export function verifyPkce(codeVerifier: string, codeChallenge: string) {
    return safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), codeChallenge);
}

// 길이가 같을 때만 비교 시간이 일정한 문자열 비교 (client_secret 확인용)
export function safeEqual(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
