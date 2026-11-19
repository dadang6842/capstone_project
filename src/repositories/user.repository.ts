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
    create(data: { email: string; password: string | null; nickname: string; googleSub?: string }) {
        return prisma.user.create({ data });
    },
    update(
        userId: bigint,
        data: { nickname?: string; password?: string; deletedAt?: Date | null; googleSub?: string },
    ) {
        return prisma.user.update({ where: { userId }, data });
    },
};
