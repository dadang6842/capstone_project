import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../utils/appError.js";
import { verifyAccessToken } from "../utils/jwt.js";

// Authorization: Bearer {accessToken} 헤더를 확인하고 req.user에 { userId, role }을 넣는다.
// 만료된 토큰은 TOKEN_EXPIRED(프론트가 재발급 요청), 그 밖의 문제는 UNAUTHORIZED.
export const authenticate: RequestHandler = (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError("UNAUTHORIZED");

    try {
        req.user = verifyAccessToken(header.slice("Bearer ".length));
    } catch (err) {
        throw new AppError(err instanceof jwt.TokenExpiredError ? "TOKEN_EXPIRED" : "UNAUTHORIZED");
    }
    next();
};
