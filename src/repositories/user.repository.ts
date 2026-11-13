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

    create(data: { email: string; password: string; nickname: string }) {
        return prisma.user.create({ data });
    },

    update(userId: bigint, data: { nickname?: string; password?: string; deletedAt?: Date | null }) {
        return prisma.user.update({ where: { userId }, data });
    },
};
