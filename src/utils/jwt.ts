import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const ACCESS_EXPIRES_IN = "30m";
const REFRESH_EXPIRES_DAYS = 14;

export type AccessPayload = { userId: number; role: "USER" | "ADMIN" };

export function signAccessToken(payload: AccessPayload) {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

// 서명이 틀리거나 만료됐으면 에러를 던진다 (만료는 jwt.TokenExpiredError)
export function verifyAccessToken(token: string): AccessPayload {
    const { userId, role } = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
    return { userId, role };
}

// jti(랜덤 값)를 넣어서 같은 초에 두 번 로그인해도 토큰이 겹치지 않게 한다 (token 컬럼 UNIQUE)
export function signRefreshToken(userId: number) {
    const token = jwt.sign({ userId }, env.JWT_REFRESH_SECRET, {
        expiresIn: `${REFRESH_EXPIRES_DAYS}d`,
        jwtid: randomUUID(),
    });
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    return { token, expiresAt };
}

export function verifyRefreshToken(token: string) {
    return jwt.verify(token, env.JWT_REFRESH_SECRET);
}
