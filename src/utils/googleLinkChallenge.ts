import { randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "./appError.js";

// 구글 계정 연동(USER-06 → USER-07)의 "연결 시도"
// 테이블 없이 서명한 JWT를 challengeId로 준다. 안에 회원·연결 버전·nonce·만료(2분)를 묶어 둔다
//  - nonce: 프론트가 구글 버튼에 넘기면 구글 ID 토큰에 그대로 들어온다 → 이 연결 시도에서 받은 토큰인지 확인
//  - 연결 버전: 연결·해제마다 +1이라, 한 번 쓴 연결 시도나 다른 화면에서 상태가 바뀐 뒤의 시도는 저절로 무효
// 로그인 토큰과 섞이지 않게 서명 키를 따로 만든다
const SECRET = `${env.JWT_ACCESS_SECRET}.google-link`;
const EXPIRES_IN_SEC = 120;

type ChallengePayload = { uid: number; ver: number; nonce: string };

export function createLinkChallenge(userId: number, version: number) {
    const nonce = randomBytes(24).toString("base64url");
    const challengeId = jwt.sign({ uid: userId, ver: version, nonce } satisfies ChallengePayload, SECRET, {
        expiresIn: EXPIRES_IN_SEC,
        jwtid: randomUUID(),
    });
    return { challengeId, nonce, expiresAt: new Date(Date.now() + EXPIRES_IN_SEC * 1000) };
}

// 만료·위조·다른 회원의 연결 시도면 400 GOOGLE_AUTH_EXPIRED (처음부터 다시)
export function verifyLinkChallenge(challengeId: string, userId: number): ChallengePayload {
    try {
        const payload = jwt.verify(challengeId, SECRET) as ChallengePayload;
        if (payload.uid !== userId || typeof payload.nonce !== "string" || typeof payload.ver !== "number")
            throw new Error();
        return payload;
    } catch {
        throw new AppError("GOOGLE_AUTH_EXPIRED");
    }
}
