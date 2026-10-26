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
