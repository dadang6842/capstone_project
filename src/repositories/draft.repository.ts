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
};
