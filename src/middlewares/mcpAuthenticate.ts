import type { RequestHandler } from "express";
import { AppError } from "../utils/appError.js";
import { verifyMcpAccessToken } from "../utils/mcpToken.js";

// MCP 서버(Python)가 넘겨준 ChatGPT용 access token을 확인하고 res.locals.userId에 넣는다.
// 웹 로그인 토큰(JWT_ACCESS_SECRET)은 여기서 통하지 않고, 반대로 이 토큰도 웹 API(authenticate)에서 통하지 않는다
export const mcpAuthenticate: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError("UNAUTHORIZED");
    try {
        res.locals.userId = verifyMcpAccessToken(header.slice("Bearer ".length));
    } catch {
        throw new AppError("UNAUTHORIZED");
    }
    next();
};
