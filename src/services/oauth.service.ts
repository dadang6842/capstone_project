import bcrypt from "bcrypt";
import { mcpConfig } from "../config/mcp.js";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import {
    MCP_ACCESS_EXPIRES_IN_SEC,
    safeEqual,
    signAuthCode,
    signMcpAccessToken,
    verifyAuthCode,
    verifyPkce,
} from "../utils/mcpToken.js";
import { verifyGoogleIdToken } from "../utils/googleAuth.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";

// ChatGPT 커넥터 연결용 OAuth 인가 서버.
// ChatGPT 등록 화면의 "사용자 정의 OAuth 클라이언트" 방식이라 클라이언트는 하나뿐이다 (.env의 MCP_OAUTH_CLIENT_ID/SECRET).
// 흐름: ChatGPT → GET /oauth/authorize(로그인 화면) → POST /oauth/authorize(로그인) → ChatGPT 콜백 URL?code=...
//       → ChatGPT 서버가 POST /oauth/token으로 code를 access token으로 바꿈 → 이후 MCP 서버 호출에 사용

// OAuth 표준 에러 (RFC 6749 5.2). 토큰 엔드포인트는 공통 응답 형식이 아니라 { error, error_description }으로 응답한다
export class OAuthError extends Error {
    constructor(
        readonly error: string,
        readonly description: string,
        readonly status = 400,
    ) {
        super(description);
        this.name = "OAuthError";
    }
}

export type AuthorizeRequest = { clientId: string; redirectUri: string; state: string; codeChallenge: string };
export type TokenResponse = {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token: string;
};

const str = (value: unknown) => (typeof value === "string" ? value : "");

// 인가 서버 메타데이터 (RFC 8414). ChatGPT가 등록할 때 읽어서 로그인·토큰 주소를 알아낸다
export function getAuthorizationServerMetadata() {
    return {
        issuer: mcpConfig.issuer,
        authorization_endpoint: `${mcpConfig.publicUrl}/oauth/authorize`,
        token_endpoint: `${mcpConfig.publicUrl}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: [],
    };
}

export const oauthService = {
    // 로그인 화면을 보여 주기 전(GET)과 로그인 처리(POST) 때 같은 값을 다시 확인한다.
    // 클라이언트나 콜백 주소가 틀리면 ChatGPT로 돌려보내지 않고 에러 화면만 보여 준다 (엉뚱한 곳으로 code가 새지 않게)
    parseAuthorizeRequest(params: Record<string, unknown>): AuthorizeRequest {
        const clientId = str(params.client_id);
        const redirectUri = str(params.redirect_uri);
        if (!clientId || !safeEqual(clientId, mcpConfig.clientId)) {
            throw new OAuthError("invalid_client", "등록되지 않은 클라이언트입니다.");
        }
        if (redirectUri !== mcpConfig.redirectUri) {
            throw new OAuthError("invalid_request", "허용되지 않은 redirect_uri입니다.");
        }
        if (str(params.response_type) !== "code") {
            throw new OAuthError("unsupported_response_type", "response_type은 code만 지원합니다.");
        }
        const codeChallenge = str(params.code_challenge);
        if (!codeChallenge || str(params.code_challenge_method) !== "S256") {
            throw new OAuthError("invalid_request", "PKCE(code_challenge, S256)가 필요합니다.");
        }
        // ChatGPT는 resource=MCP 주소를 보낸다. 다른 서비스용 토큰을 달라는 요청은 거절
        const resource = str(params.resource);
        if (resource && resource !== mcpConfig.resource) {
            throw new OAuthError("invalid_target", "허용되지 않은 resource입니다.");
        }
        return { clientId, redirectUri, state: str(params.state), codeChallenge };
    },

    // 이메일·비밀번호 확인 (웹 로그인과 같은 규칙). 성공하면 userId, 실패하면 화면에 보여 줄 문구
    async login(email: string, password: string): Promise<{ userId: number } | { message: string }> {
        const user = await userRepository.findByEmail(email.trim());
        // 구글로만 가입한 회원(password NULL)은 비밀번호로 로그인할 수 없다
        if (!user?.password || !(await bcrypt.compare(password, user.password))) {
            return { message: "이메일 또는 비밀번호가 올바르지 않습니다." };
        }
        if (user.deletedAt)
            return { message: "탈퇴 처리 중인 계정입니다. 웹에서 탈퇴를 취소한 뒤 다시 시도해 주세요." };
        return { userId: Number(user.userId) };
    },

    // 구글 로그인 (구글로만 가입한 회원도 ChatGPT를 연결할 수 있게). 로그인 화면의 구글 버튼이 준 ID 토큰을 확인한다.
    // 웹 구글 로그인과 같이 google_sub로만 회원을 찾는다 (이메일로 합치지 않음). 여기서는 새로 가입시키지 않는다
    async loginWithGoogle(idToken: string): Promise<{ userId: number } | { message: string }> {
        let profile;
        try {
            profile = await verifyGoogleIdToken(idToken);
        } catch (err) {
            if (!(err instanceof AppError)) throw err;
            return { message: "구글 로그인을 확인하지 못했습니다. 다시 시도해 주세요." };
        }
        const user = await userRepository.findByGoogleSub(profile.sub);
        if (!user) {
            return {
                message:
                    "이 구글 계정으로 가입한 AI Archive 계정이 없습니다. 웹에서 먼저 가입하거나, 계정 정보에서 구글 계정을 연결해 주세요.",
            };
        }
        if (user.deletedAt)
            return { message: "탈퇴 처리 중인 계정입니다. 웹에서 탈퇴를 취소한 뒤 다시 시도해 주세요." };
        return { userId: Number(user.userId) };
    },

    // 로그인 성공 후 ChatGPT 콜백 URL로 돌려보낼 주소 (code, state, iss를 붙임)
    buildRedirectUrl(request: AuthorizeRequest, userId: number) {
        const code = signAuthCode({ userId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge });
        const url = new URL(request.redirectUri);
        url.searchParams.set("code", code);
        if (request.state) url.searchParams.set("state", request.state);
        url.searchParams.set("iss", mcpConfig.issuer); // RFC 9207
        logger.info("ChatGPT 커넥터 연결을 위해 로그인하였습니다.", { userId });
        return url.toString();
    },

    // POST /oauth/token. client는 컨트롤러가 헤더(Basic)나 본문에서 꺼내 준다
    async issueToken(body: Record<string, unknown>, client: { id: string; secret: string }): Promise<TokenResponse> {
        if (!safeEqual(client.id, mcpConfig.clientId) || !safeEqual(client.secret, mcpConfig.clientSecret)) {
            throw new OAuthError("invalid_client", "클라이언트 인증에 실패했습니다.", 401);
        }

        const grantType = str(body.grant_type);
        if (grantType === "authorization_code") return this.exchangeCode(body);
        if (grantType === "refresh_token") return this.refresh(str(body.refresh_token));
        throw new OAuthError("unsupported_grant_type", "authorization_code, refresh_token만 지원합니다.");
    },

    async exchangeCode(body: Record<string, unknown>): Promise<TokenResponse> {
        const payload = verifyAuthCode(str(body.code));
        if (!payload) throw new OAuthError("invalid_grant", "code가 올바르지 않거나 만료되었습니다.");
        if (str(body.redirect_uri) !== payload.redirectUri) {
            throw new OAuthError("invalid_grant", "redirect_uri가 로그인할 때와 다릅니다.");
        }
        const codeVerifier = str(body.code_verifier);
        if (!codeVerifier || !verifyPkce(codeVerifier, payload.codeChallenge)) {
            throw new OAuthError("invalid_grant", "code_verifier가 올바르지 않습니다.");
        }
        const resource = str(body.resource);
        if (resource && resource !== mcpConfig.resource)
            throw new OAuthError("invalid_target", "허용되지 않은 resource입니다.");

        // code를 받은 뒤 5분 사이에 탈퇴 신청했을 수 있어서 한 번 더 확인
        const user = await userRepository.findById(BigInt(payload.userId));
        if (!user || user.deletedAt) throw new OAuthError("invalid_grant", "사용할 수 없는 계정입니다.");

        const refresh = signRefreshToken(payload.userId);
        await refreshTokenRepository.create({
            userId: user.userId,
            token: refresh.token,
            expiresAt: refresh.expiresAt,
        });
        logger.info("ChatGPT 커넥터에 토큰을 발급하였습니다.", { userId: payload.userId });
        return {
            access_token: signMcpAccessToken(payload.userId),
            token_type: "Bearer",
            expires_in: MCP_ACCESS_EXPIRES_IN_SEC,
            refresh_token: refresh.token,
        };
    },

    // ChatGPT가 access token(1시간)이 끝나면 자동으로 부른다. 웹 재발급(AUTH refresh)과 같은 규칙으로 회전
    async refresh(refreshToken: string): Promise<TokenResponse> {
        try {
            verifyRefreshToken(refreshToken);
        } catch {
            throw new OAuthError("invalid_grant", "refresh_token이 올바르지 않거나 만료되었습니다.");
        }
        const saved = await refreshTokenRepository.findByTokenWithUser(refreshToken);
        if (!saved || saved.revokedAt || saved.expiresAt <= new Date() || saved.user.deletedAt) {
            throw new OAuthError("invalid_grant", "refresh_token을 사용할 수 없습니다.");
        }

        const userId = Number(saved.userId);
        const next = signRefreshToken(userId);
        const rotated = await refreshTokenRepository.rotate(refreshToken, {
            userId: saved.userId,
            token: next.token,
            expiresAt: next.expiresAt,
        });
        if (!rotated) throw new OAuthError("invalid_grant", "이미 사용한 refresh_token입니다.");

        return {
            access_token: signMcpAccessToken(userId),
            token_type: "Bearer",
            expires_in: MCP_ACCESS_EXPIRES_IN_SEC,
            refresh_token: next.token,
        };
    },
};
