import { prisma } from "../config/prisma.js";

export const conversationRepository = {
    create(data: { userId: bigint; filename: string; contentType: string; fileSize: bigint; s3Key: string }) {
        return prisma.conversation.create({ data });
    },
};
