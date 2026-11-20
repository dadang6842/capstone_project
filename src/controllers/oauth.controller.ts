import type { Request, RequestHandler, Response } from "express";
import { getAuthorizationServerMetadata, OAuthError, oauthService } from "../services/oauth.service.js";
import { renderErrorPage, renderLoginPage } from "../utils/oauthPage.js";

// 로그인 화면은 다른 사이트의 iframe 안에 넣지 못하게 한다 (클릭재킹 방지)
function sendHtml(res: Response, status: number, html: string) {
    res.status(status).set({ "X-Frame-Options": "DENY", "Cache-Control": "no-store" }).type("html").send(html);
}

// 클라이언트 인증: Authorization: Basic base64(id:secret) 또는 본문 client_id·client_secret
function readClient(req: Request) {
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
        const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        if (sep >= 0) {
            try {
                // RFC 6749 2.3.1: id·secret은 form-urlencoded로 한 번 인코딩돼 있다
                return {
                    id: decodeURIComponent(decoded.slice(0, sep)),
                    secret: decodeURIComponent(decoded.slice(sep + 1)),
                };
            } catch {
                return { id: "", secret: "" };
            }
        }
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
        id: typeof body.client_id === "string" ? body.client_id : "",
        secret: typeof body.client_secret === "string" ? body.client_secret : "",
    };
}

export const oauthController = {
    metadata: ((_req, res) => {
        res.json(getAuthorizationServerMetadata());
    }) satisfies RequestHandler,

    // GET /oauth/authorize: 로그인 화면
    showLogin: ((req, res) => {
        try {
            const request = oauthService.parseAuthorizeRequest(req.query as Record<string, unknown>);
            sendHtml(res, 200, renderLoginPage(request));
        } catch (err) {
            if (!(err instanceof OAuthError)) throw err;
            sendHtml(res, 400, renderErrorPage(err.description));
        }
    }) satisfies RequestHandler,

    // POST /oauth/authorize: 로그인 처리 → ChatGPT 콜백 URL로 302
    login: (async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        let request;
        try {
            request = oauthService.parseAuthorizeRequest(body);
        } catch (err) {
            if (!(err instanceof OAuthError)) throw err;
            return sendHtml(res, 400, renderErrorPage(err.description));
        }

        const email = typeof body.email === "string" ? body.email : "";
        const password = typeof body.password === "string" ? body.password : "";
        const result = await oauthService.login(email, password);
        if ("message" in result) return sendHtml(res, 401, renderLoginPage(request, result.message, email));

        res.redirect(302, oauthService.buildRedirectUrl(request, result.userId));
    }) satisfies RequestHandler,

    // POST /oauth/authorize/google: 로그인 화면의 구글 버튼 → ChatGPT 콜백 URL로 302
    loginWithGoogle: (async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        let request;
        try {
            request = oauthService.parseAuthorizeRequest(body);
        } catch (err) {
            if (!(err instanceof OAuthError)) throw err;
            return sendHtml(res, 400, renderErrorPage(err.description));
        }

        const credential = typeof body.credential === "string" ? body.credential : "";
        const result = credential
            ? await oauthService.loginWithGoogle(credential)
            : { message: "구글 로그인을 확인하지 못했습니다. 다시 시도해 주세요." };
        if ("message" in result) return sendHtml(res, 401, renderLoginPage(request, result.message));

        res.redirect(302, oauthService.buildRedirectUrl(request, result.userId));
    }) satisfies RequestHandler,

    // POST /oauth/token: ChatGPT 서버가 직접 부른다 (사용자 브라우저 아님)
    token: (async (req, res) => {
        res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
        try {
            const tokens = await oauthService.issueToken((req.body ?? {}) as Record<string, unknown>, readClient(req));
            res.json(tokens);
        } catch (err) {
            if (!(err instanceof OAuthError)) throw err;
            if (err.status === 401) res.set("WWW-Authenticate", 'Basic realm="oauth"');
            res.status(err.status).json({ error: err.error, error_description: err.description });
        }
    }) satisfies RequestHandler,
};
