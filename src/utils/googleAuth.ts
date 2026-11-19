import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";
import { AppError } from "./appError.js";
import { logger } from "./logger.js";

// 구글 로그인 (2026-11-17)
// 프론트의 "Google로 로그인" 버튼(Google Identity Services)이 준 ID 토큰(credential)을 검증한다.
// 구글 공개키로 서명, 발급자(accounts.google.com), 만료, 대상(aud = 우리 클라이언트 ID)을 확인한다. 공개키는 라이브러리가 받아서 캐시한다
const client = new OAuth2Client();

export type GoogleProfile = {
    sub: string; // 구글 계정 고유 ID (이메일이 바뀌어도 그대로)
    email: string;
    name: string | null;
};

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
    if (!env.GOOGLE_CLIENT_ID) throw new AppError("GOOGLE_LOGIN_UNAVAILABLE");

    let payload;
    try {
        const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
        payload = ticket.getPayload();
    } catch (err) {
        // 위조·만료·다른 앱용 토큰. 구글 공개키를 못 받아 온 경우도 여기로 온다 (원인은 로그로 확인)
        logger.warn(
            "INVALID_GOOGLE_TOKEN",
            `구글 ID 토큰 검증 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new AppError("INVALID_GOOGLE_TOKEN");
    }

    if (!payload?.sub || !payload.email) throw new AppError("INVALID_GOOGLE_TOKEN");
    // 구글이 확인한 이메일만 받는다 (가입 시 users.email로 저장하기 때문)
    if (payload.email_verified !== true) throw new AppError("GOOGLE_EMAIL_NOT_VERIFIED");
    // users.email이 VARCHAR(100)
    if (payload.email.length > 100) throw new AppError("VALIDATION_ERROR", { message: "이메일이 너무 깁니다." });

    return { sub: payload.sub, email: payload.email, name: payload.name?.trim() || null };
}
