import { prisma } from "../config/prisma.js";

export const refreshTokenRepository = {
    create(data: { userId: bigint; token: string; expiresAt: Date }) {
        return prisma.refreshToken.create({ data });
    },
};
