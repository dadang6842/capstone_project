import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";

// 목록에서 대화마다 같이 가져오는 연결 문서 (삭제·NOT_KNOWLEDGE 문서는 빼고, 최신 문서부터)
// 초안은 생성 중인 초안이 있는지와 최신 회차를 보려고 최신순으로 전부 가져온다
const listInclude = {
    documentConversations: {
        where: { document: { deletedAt: null, status: { not: "NOT_KNOWLEDGE" } } },
        orderBy: { documentId: "desc" },
        select: {
            document: {
                select: {
                    documentId: true,
                    status: true,
                    drafts: { orderBy: { draftId: "desc" }, select: { draftId: true, title: true, status: true } },
                },
            },
        },
    },
} satisfies Prisma.ConversationInclude;

export type ConversationWithDocuments = Prisma.ConversationGetPayload<{ include: typeof listInclude }>;

export const conversationRepository = {
    create(data: { userId: bigint; filename: string; contentType: string; fileSize: bigint; s3Key: string }) {
        return prisma.conversation.create({ data });
    },

    // 삭제하지 않은 내 대화를 등록일 최신순(같으면 아이디 내림차순)으로 한 페이지와 전체 개수
    findPageByUser(userId: bigint, { skip, take }: { skip: number; take: number; q?: string }) {
        const where: Prisma.ConversationWhereInput = {
            userId,
            deletedAt: null,
        };
        return prisma.$transaction([
            prisma.conversation.findMany({
                where,
                orderBy: [{ createdAt: "desc" }, { conversationId: "desc" }],
                skip,
                take,
                include: listInclude,
            }),
            prisma.conversation.count({ where }),
        ]);
    },
};
