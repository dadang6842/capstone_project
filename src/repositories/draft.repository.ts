import { prisma } from "../config/prisma.js";

export const draftRepository = {
    // 초안 조회용: 초안, 보완 항목, 문서(+ 진행 중인 AI 보완 초안, 분석한 원본 대화)
    findByIdWithDocument(draftId: bigint) {
        return prisma.draft.findUnique({
            where: { draftId },
            include: {
                feedbacks: { select: { reason: true } },
                document: {
                    include: {
                        // AI 보완 진행 중 여부 (2회차 이상이 GENERATING)
                        drafts: {
                            where: { versionNo: { gt: 1 }, status: "GENERATING" },
                            select: { draftId: true },
                            take: 1,
                        },
                        sources: {
                            orderBy: { conversationId: "asc" },
                            select: {
                                conversation: { select: { conversationId: true, filename: true, deletedAt: true } },
                            },
                        },
                    },
                },
            },
        });
    },

    // 재시도용: 실패한 초안과 문서, 분석 대상 대화(삭제한 대화 제외)
    findForRetry(draftId: bigint) {
        return prisma.draft.findUnique({
            where: { draftId },
            include: {
                document: {
                    include: {
                        sources: {
                            where: { conversation: { deletedAt: null } },
                            orderBy: { conversationId: "asc" },
                            select: { conversation: true },
                        },
                    },
                },
            },
        });
    },

    // 같은 문서·회차에서 이 초안보다 나중에 만든 시도가 있는지 (이미 재시도함)
    async hasNewerAttempt(documentId: bigint, versionNo: number, draftId: bigint) {
        const count = await prisma.draft.count({ where: { documentId, versionNo, draftId: { gt: draftId } } });
        return count > 0;
    },

    // 첫 초안 재시도: 문서를 FAILED → GENERATING으로 돌리고 같은 회차(1)의 새 초안 행을 만든다. 실패한 행은 그대로 둔다.
    // 문서가 FAILED일 때만 바꿔서, 버튼을 두 번 눌러도 새 행은 하나만 생긴다 (아니면 null)
    createFirstDraftRetry(documentId: bigint) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.document.updateMany({
                where: { documentId, status: "FAILED" },
                data: { status: "GENERATING" },
            });
            if (count === 0) return null;
            return tx.draft.create({ data: { documentId, versionNo: 1 }, select: { draftId: true } });
        });
    },
};
