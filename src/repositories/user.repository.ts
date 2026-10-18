import { prisma } from "../config/prisma.js";

export const userRepository = {
    findByEmail(email: string) {
        return prisma.user.findUnique({ where: { email } });
    },
};
