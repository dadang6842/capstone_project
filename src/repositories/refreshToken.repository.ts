import { prisma } from "../config/prisma.js";

type NewToken = { userId: bigint; token: string; expiresAt: Date };

export const refreshTokenRepository = {
    create(data: NewToken) {
        return prisma.refreshToken.create({ data });
    },

    // 재발급 때 새 access 토큰에 role을 넣어야 해서 회원 정보도 같이 가져온다
    findByTokenWithUser(token: string) {
        return prisma.refreshToken.findUnique({ where: { token }, include: { user: true } });
    },

    // 토큰 회전: 기존 토큰 폐기 + 새 토큰 저장을 한 트랜잭션으로 처리한다.
    // 같은 토큰으로 재발급 요청이 동시에 두 번 와도 revokedAt: null 조건 때문에 하나만 성공한다.
    async rotate(oldToken: string, next: NewToken) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.refreshToken.updateMany({
                where: { token: oldToken, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            if (count === 0) return false;
            await tx.refreshToken.create({ data: next });
            return true;
        });
    },

    // 본인 토큰이고 아직 폐기되지 않은 경우에만 revoked_at을 채운다
    revoke(token: string, userId: bigint) {
        return prisma.refreshToken.updateMany({
            where: { token, userId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    },

    // 비밀번호 변경·탈퇴 때 이 회원의 모든 기기 로그인을 끊는다
    revokeAllByUser(userId: bigint) {
        return prisma.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    },
};
