import { prisma } from "../config/prisma.js";
import type { CollectFailReason, Prisma } from "../generated/prisma/client.js";
import type { CollectedConversation } from "../utils/collector.js";

// 목록에서 대화마다 같이 가져오는 연결 문서 (삭제 문서는 빼고, 최신 문서부터)
// 초안은 생성 중인 초안이 있는지와 최신 회차를 보려고 최신순으로 전부 가져온다
const listInclude = {
    _count: { select: { messages: true } },
    documentConversations: {
        where: { document: { deletedAt: null } },
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

// AI 서버로 보낼 때 같이 가져오는 발화 (순서대로)
export const messagesInclude = {
    messages: { orderBy: { sequence: "asc" }, select: { sourceMessageId: true, role: true, content: true } },
} satisfies Prisma.ConversationInclude;

export type ConversationWithMessages = Prisma.ConversationGetPayload<{ include: typeof messagesInclude }>;

export const conversationRepository = {
    create(userId: bigint, shareUrl: string) {
        return prisma.conversation.create({ data: { userId, shareUrl } });
    },

    // 수집 성공: 발화를 저장하고 COLLECTED로 바꾼다. 결과: SAVED / DUPLICATED / SKIPPED
    //  - 같은 회원의 다른 대화(삭제 안 함, 수집 완료)에 같은 capture_id가 있으면 저장하지 않고 FAILED(DUPLICATED)
    //    (capture_id = 링크 + 대화 내용 해시라, 같은 링크라도 대화가 이어져 내용이 늘었으면 새 대화로 저장된다)
    //  - 수집 중에 대화를 삭제했으면 아무것도 하지 않는다
    // 수집은 대기열에서 하나씩 끝나서 이 확인과 저장 사이에 같은 내용이 끼어들지 않는다 (동시 실행 1개 기준)
    saveCollected(conversationId: bigint, { captureId, title, messages }: CollectedConversation) {
        return prisma.$transaction(async (tx) => {
            const target = await tx.conversation.findUnique({
                where: { conversationId },
                select: { userId: true, status: true, deletedAt: true },
            });
            if (!target || target.status !== "COLLECTING" || target.deletedAt) return { result: "SKIPPED" as const };

            const duplicate = await tx.conversation.findFirst({
                where: {
                    userId: target.userId,
                    captureId,
                    status: "COLLECTED",
                    deletedAt: null,
                    conversationId: { not: conversationId },
                },
                select: { conversationId: true },
            });
            if (duplicate) {
                await tx.conversation.update({
                    where: { conversationId },
                    data: { status: "FAILED", collectFailReason: "DUPLICATED", captureId },
                });
                return { result: "DUPLICATED" as const, duplicateOf: duplicate.conversationId };
            }

            await tx.conversation.update({
                where: { conversationId },
                data: { status: "COLLECTED", captureId, title },
            });
            await tx.conversationMessage.createMany({
                data: messages.map((message, i) => ({ conversationId, sequence: i + 1, ...message })),
            });
            return { result: "SAVED" as const };
        });
    },

    markCollectFailed(conversationId: bigint, reason: CollectFailReason) {
        return prisma.conversation.updateMany({
            where: { conversationId, status: "COLLECTING" },
            data: { status: "FAILED", collectFailReason: reason },
        });
    },

    // 서버가 켜질 때: 이전 프로세스에서 수집하다 끊긴 대화를 실패로 바꾼다 (대기열은 메모리에만 있어서 다시 이어 갈 수 없음)
    failInterruptedCollecting() {
        return prisma.conversation.updateMany({
            where: { status: "COLLECTING" },
            data: { status: "FAILED", collectFailReason: "TIMEOUT" },
        });
    },

    // 대화 하나와 발화, 이 대화로 만든 문서 (삭제 문서 제외, 최신 문서부터)
    findByIdWithDetail(conversationId: bigint) {
        return prisma.conversation.findUnique({
            where: { conversationId },
            include: {
                messages: { orderBy: { sequence: "asc" }, select: { sequence: true, role: true, content: true } },
                documentConversations: {
                    where: { document: { deletedAt: null } },
                    orderBy: { documentId: "desc" },
                    select: { document: { select: { documentId: true, title: true } } },
                },
            },
        });
    },

    // 삭제 전 확인용: 대화와, 이 대화를 쓰는 문서 중 삭제를 막는 문서만
    //  - 첫 초안 생성 중(GENERATING)이거나 AI 보완·재시도 중인 초안이 있는 문서 (설계서: 생성 중에만 삭제 불가)
    findByIdWithBlockingDocuments(conversationId: bigint) {
        return prisma.conversation.findUnique({
            where: { conversationId },
            include: {
                documentConversations: {
                    where: {
                        document: {
                            deletedAt: null,
                            OR: [{ status: "GENERATING" }, { drafts: { some: { status: "GENERATING" } } }],
                        },
                    },
                    select: { documentId: true },
                },
            },
        });
    },

    // 소프트 삭제. 발화(conversation_messages)는 지우지 않는다 (문서 생성 기록과 함께 남김)
    softDelete(conversationId: bigint) {
        return prisma.conversation.update({ where: { conversationId }, data: { deletedAt: new Date() } });
    },

    // 삭제하지 않은 내 대화 중 아이디가 맞는 것 (발화 포함, 문서 생성 AI-01에 보냄)
    findActiveByIds(userId: bigint, conversationIds: bigint[]) {
        return prisma.conversation.findMany({
            where: { userId, deletedAt: null, conversationId: { in: conversationIds } },
            include: messagesInclude,
        });
    },

    // 삭제하지 않은 내 대화를 등록일 최신순(같으면 아이디 내림차순)으로 한 페이지와 전체 개수
    findPageByUser(userId: bigint, { skip, take }: { skip: number; take: number }) {
        const where: Prisma.ConversationWhereInput = { userId, deletedAt: null };
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
