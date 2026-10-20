import { prisma } from "../config/prisma.js";

export const userRepository = {
    findByEmail(email: string) {
        return prisma.user.findUnique({ where: { email } });
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
