import { Prisma, type User } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { userRepository } from "../repositories/user.repository.js";
import { passwordMatches } from "./auth.service.js";
import { AppError } from "../utils/appError.js";
import { verifyGoogleIdToken } from "../utils/googleAuth.js";
import { createLinkChallenge, verifyLinkChallenge } from "../utils/googleLinkChallenge.js";
import type {
    GoogleConnection,
    GoogleLinkBody,
    GoogleLinkChallenge,
    GoogleLinkChallengeBody,
    GoogleUnlinkBody,
} from "../schemas/googleAccount.schema.js";

// 구글 계정 연동·해제 (2026-11-19, 계정 정보 A08)
// 이메일로 계정을 합치지 않는다. 로그인한 회원이 비밀번호를 확인하고 직접 고른 구글 계정(sub)만 연결한다 (다현 결정 2026-11-19)

// 토큰은 유효해도 그사이 탈퇴 요청을 했으면 로그인이 끊긴 것으로 본다 (user.service와 같은 규칙)
async function findActiveUser(userId: number) {
    const user = await userRepository.findById(BigInt(userId));
    if (!user || user.deletedAt) throw new AppError("UNAUTHORIZED");
    return user;
}

function toConnection(user: User): GoogleConnection {
    const linked = user.googleSub !== null;
    // 구글로만 가입한 회원은 비밀번호가 없어서 구글이 유일한 로그인 방법 → 해제 불가
    const lastLoginMethod = linked && user.password === null;
    return {
        version: user.googleLinkVersion,
        account: linked
            ? {
                  email: user.googleEmail ?? user.email,
                  name: user.googleName,
                  linkedAt: user.googleLinkedAt ?? user.createdAt,
              }
            : null,
        canUnlink: linked && !lastLoginMethod,
        unlinkBlockedReason: lastLoginMethod ? "LAST_LOGIN_METHOD" : null,
    };
}

async function checkPassword(user: User, password: string) {
    if (user.password === null) throw new AppError("PASSWORD_NOT_SET");
    if (!(await passwordMatches(user, password))) throw new AppError("INVALID_PASSWORD");
}

export const googleAccountService = {
    // USER-05 연결 상태 조회
    async getConnection(userId: number): Promise<GoogleConnection> {
        return toConnection(await findActiveUser(userId));
    },

    // USER-06 연결 시작: 비밀번호를 확인하고 2분짜리 연결 시도(challengeId·nonce)를 준다
    async startLink(userId: number, { password }: GoogleLinkChallengeBody): Promise<GoogleLinkChallenge> {
        const user = await findActiveUser(userId);
        if (user.googleSub !== null) throw new AppError("GOOGLE_ACCOUNT_ALREADY_LINKED");
        await checkPassword(user, password);
        if (!env.GOOGLE_CLIENT_ID) throw new AppError("GOOGLE_LOGIN_UNAVAILABLE");

        const challenge = createLinkChallenge(Number(user.userId), user.googleLinkVersion);
        return { ...challenge, clientId: env.GOOGLE_CLIENT_ID };
    },

    // USER-07 연결 완료: 연결 시도와 구글 ID 토큰(nonce 포함)을 확인하고 구글 sub를 이 회원에 저장한다
    async completeLink(userId: number, { challengeId, credential }: GoogleLinkBody): Promise<GoogleConnection> {
        const challenge = verifyLinkChallenge(challengeId, userId);
        const google = await verifyGoogleIdToken(credential);
        // 이 연결 시도에서 고른 구글 계정의 토큰인지 (다른 곳에서 얻은 토큰을 끼워 넣는 것 방지)
        if (google.nonce !== challenge.nonce) throw new AppError("INVALID_GOOGLE_TOKEN");

        const user = await findActiveUser(userId);
        // 응답을 못 받아 같은 요청을 다시 보낸 경우: 이미 이 구글로 연결돼 있으면 그대로 성공
        if (user.googleSub === google.sub) return toConnection(user);
        if (user.googleSub !== null) throw new AppError("GOOGLE_ACCOUNT_ALREADY_LINKED");
        if (user.googleLinkVersion !== challenge.ver) throw new AppError("GOOGLE_LINK_CHANGED");
        if (await userRepository.findByGoogleSub(google.sub)) throw new AppError("GOOGLE_ACCOUNT_IN_USE");

        let count: number;
        try {
            count = await userRepository.linkGoogle(user.userId, challenge.ver, google);
        } catch (err) {
            // 같은 구글 계정을 다른 회원이 동시에 연결한 경우
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw new AppError("GOOGLE_ACCOUNT_IN_USE");
            }
            throw err;
        }

        const updated = await findActiveUser(userId);
        // count 0: 그사이 다른 요청이 먼저 바꿈. 같은 구글로 먼저 연결됐으면(더블 클릭) 성공으로 본다
        if (count === 0 && updated.googleSub !== google.sub) throw new AppError("GOOGLE_LINK_CHANGED");
        return toConnection(updated);
    },

    // USER-08 연결 해제: 비밀번호와 화면의 연결 버전을 확인한다. 구글이 유일한 로그인 방법이면 막는다
    async unlink(userId: number, { password, expectedVersion }: GoogleUnlinkBody): Promise<GoogleConnection> {
        const user = await findActiveUser(userId);
        if (user.googleSub === null) throw new AppError("GOOGLE_LINK_CHANGED");
        if (user.password === null) throw new AppError("GOOGLE_LAST_LOGIN_METHOD");
        await checkPassword(user, password);
        if (user.googleLinkVersion !== expectedVersion) throw new AppError("GOOGLE_LINK_CHANGED");

        const count = await userRepository.unlinkGoogle(user.userId, expectedVersion);
        if (count === 0) throw new AppError("GOOGLE_LINK_CHANGED");
        return toConnection(await findActiveUser(userId));
    },
};
