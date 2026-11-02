import { prisma } from "../config/prisma.js";

// drafts.error_message가 VARCHAR(1000)
const ERROR_MESSAGE_MAX = 1000;

export const documentRepository = {
    // 이 대화들을 쓰는 문서 중 생성 작업이 진행 중인 문서 (첫 초안 생성 중이거나 AI 보완·재시도 중인 초안이 있음)
    findGeneratingByConversationIds(conversationIds: bigint[]) {
        return prisma.document.findMany({
            where: {
                deletedAt: null,
                sources: { some: { conversationId: { in: conversationIds } } },
                OR: [{ status: "GENERATING" }, { drafts: { some: { status: "GENERATING" } } }],
            },
            select: { documentId: true },
        });
    },

    // 문서(GENERATING) + 분석 대상 대화 연결 + 1회차 초안(GENERATING)을 한 번에 만든다 (중첩 create라 하나의 트랜잭션)
    createWithFirstDraft(userId: bigint, conversationIds: bigint[]) {
        return prisma.document.create({
            data: {
                userId,
                sources: { create: conversationIds.map((conversationId) => ({ conversationId })) },
                drafts: { create: { versionNo: 1 } },
            },
            include: { drafts: { select: { draftId: true } } },
        });
    },

    // 검토할 초안이 있는(DRAFT_GENERATED) 내 문서를 최근 생성순으로, 생성이 끝난 최신 회차의 제목과 함께
    // (AI 보완 중인 회차는 아직 제목이 없어서 뺀다)
    findPendingByUser(userId: bigint) {
        return prisma.document.findMany({
            where: { userId, deletedAt: null, status: "DRAFT_GENERATED" },
            orderBy: [{ createdAt: "desc" }, { documentId: "desc" }],
            select: {
                documentId: true,
                createdAt: true,
                drafts: {
                    where: { status: "GENERATED" },
                    orderBy: { draftId: "desc" },
                    take: 1,
                    select: { title: true },
                },
            },
        });
    },

    // 초안 이력 조회용: 문서와 모든 초안의 회차·상태
    findWithDraftHistory(documentId: bigint) {
        return prisma.document.findUnique({
            where: { documentId },
            select: {
                userId: true,
                status: true,
                deletedAt: true,
                drafts: {
                    orderBy: [{ versionNo: "asc" }, { draftId: "asc" }],
                    select: { draftId: true, versionNo: true, status: true },
                },
            },
        });
    },

    // 첫 초안 생성 실패: 초안 FAILED(원인 기록) + 문서 FAILED
    markFirstDraftFailed(documentId: bigint, draftId: bigint, failReason: "ANALYSIS_FAILED", errorMessage: string) {
        return prisma.$transaction([
            prisma.draft.update({
                where: { draftId },
                data: { status: "FAILED", failReason, errorMessage: errorMessage.slice(0, ERROR_MESSAGE_MAX) },
            }),
            prisma.document.update({ where: { documentId }, data: { status: "FAILED" } }),
        ]);
    },
};
