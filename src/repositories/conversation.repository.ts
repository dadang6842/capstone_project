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

    // 대화 하나와 이 대화로 만든 문서 (삭제·NOT_KNOWLEDGE 문서 제외, 최신 문서부터)
    findByIdWithDocuments(conversationId: bigint) {
        return prisma.conversation.findUnique({
            where: { conversationId },
            include: {
                documentConversations: {
                    where: { document: { deletedAt: null, status: { not: "NOT_KNOWLEDGE" } } },
                    orderBy: { documentId: "desc" },
                    select: { document: { select: { documentId: true, title: true } } },
                },
            },
        });
    },

    // 삭제 전 확인용: 대화와, 이 대화를 쓰는 문서 중 삭제를 막는 문서만
    //  - 첫 초안 생성 중(GENERATING)이거나 AI 보완·재시도 중인 초안이 있는 문서
    //  - 분석 단계에서 실패해 재시도를 기다리는 문서 (FAILED이고 prompt가 NULL → 재시도에 원본이 필요)
    findByIdWithBlockingDocuments(conversationId: bigint) {
        return prisma.conversation.findUnique({
            where: { conversationId },
            include: {
                documentConversations: {
                    where: {
                        document: {
                            deletedAt: null,
                            OR: [
                                { status: "GENERATING" },
                                { drafts: { some: { status: "GENERATING" } } },
                                { status: "FAILED", prompt: null },
                            ],
                        },
                    },
                    select: { documentId: true },
                },
            },
        });
    },

    // 소프트 삭제. S3 파일은 지우지 않고 배치로 정리한다
    softDelete(conversationId: bigint) {
        return prisma.conversation.update({ where: { conversationId }, data: { deletedAt: new Date() } });
    },

    // 삭제하지 않은 내 대화 중 아이디가 맞는 것
    findActiveByIds(userId: bigint, conversationIds: bigint[]) {
        return prisma.conversation.findMany({
            where: { userId, deletedAt: null, conversationId: { in: conversationIds } },
        });
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
