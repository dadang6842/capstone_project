import { prisma } from "../config/prisma.js";

export const userRepository = {
    findByEmail(email: string) {
        return prisma.user.findUnique({ where: { email } });
    },

    // 팀 초대(INV-01): 탈퇴 요청한 회원은 없는 회원으로 본다
    findActiveByEmail(email: string) {
        return prisma.user.findFirst({ where: { email, deletedAt: null } });
    },

    findById(userId: bigint) {
        return prisma.user.findUnique({ where: { userId } });
    },

    // 구글 로그인: 구글 계정 고유 ID(sub)로 찾는다
    findByGoogleSub(googleSub: string) {
        return prisma.user.findUnique({ where: { googleSub } });
    },

    // password는 구글로만 가입하면 null
    create(data: {
        email: string;
        password: string | null;
        nickname: string;
        googleSub?: string;
        googleEmail?: string;
        googleName?: string | null;
        googleLinkedAt?: Date;
        googleLinkVersion?: number;
    }) {
        return prisma.user.create({ data });
    },

    // 구글 연동(USER-07): 연결이 비어 있고 연결 버전이 그대로일 때만 저장한다. 바뀐 행 수(0 또는 1)를 돌려준다
    // 구글 계정이 다른 회원에 이미 연결돼 있으면 UNIQUE 위반(P2002)
    async linkGoogle(
        userId: bigint,
        expectedVersion: number,
        google: { sub: string; email: string; name: string | null },
    ) {
        const { count } = await prisma.user.updateMany({
            where: { userId, googleSub: null, googleLinkVersion: expectedVersion, deletedAt: null },
            data: {
                googleSub: google.sub,
                googleEmail: google.email,
                googleName: google.name,
                googleLinkedAt: new Date(),
                googleLinkVersion: { increment: 1 },
            },
        });
        return count;
    },

    // 구글 해제(USER-08): 연결돼 있고 연결 버전이 그대로일 때만 지운다
    async unlinkGoogle(userId: bigint, expectedVersion: number) {
        const { count } = await prisma.user.updateMany({
            where: { userId, googleSub: { not: null }, googleLinkVersion: expectedVersion, deletedAt: null },
            data: {
                googleSub: null,
                googleEmail: null,
                googleName: null,
                googleLinkedAt: null,
                googleLinkVersion: { increment: 1 },
            },
        });
        return count;
    },
    update(
        userId: bigint,
        data: { nickname?: string; password?: string; deletedAt?: Date | null; googleSub?: string },
    ) {
        return prisma.user.update({ where: { userId }, data });
    },
};
