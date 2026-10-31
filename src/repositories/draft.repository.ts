import { prisma } from "../config/prisma.js";
import type { Category } from "../generated/prisma/client.js";

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

    // 채택·직접 수정용: 초안과 문서 상태, 진행 중인 AI 보완 초안(2회차 이상 GENERATING)
    findWithDocumentState(draftId: bigint) {
        return prisma.draft.findUnique({
            where: { draftId },
            include: {
                document: {
                    select: {
                        userId: true,
                        status: true,
                        deletedAt: true,
                        drafts: {
                            where: { versionNo: { gt: 1 }, status: "GENERATING" },
                            select: { draftId: true },
                            take: 1,
                        },
                    },
                },
            },
        });
    },

    // 최종 채택: 문서에 초안 내용을 복사하고 FINALIZED, 초안 ACCEPTED, 키워드를 document_keywords로 (한 트랜잭션)
    // 문서가 DRAFT_GENERATED일 때만 바꿔서, 두 회차를 동시에 채택해도 하나만 된다 (아니면 null)
    accept(draft: {
        draftId: bigint;
        documentId: bigint;
        title: string | null;
        summary: string | null;
        category: Category | null;
        content: string | null;
        keywords: string[];
    }) {
        return prisma.$transaction(async (tx) => {
            const finalizedAt = new Date();
            const { count } = await tx.document.updateMany({
                where: { documentId: draft.documentId, status: "DRAFT_GENERATED" },
                data: {
                    title: draft.title,
                    summary: draft.summary,
                    category: draft.category,
                    content: draft.content,
                    status: "FINALIZED",
                    finalizedAt,
                },
            });
            if (count === 0) return null;

            await tx.draft.update({ where: { draftId: draft.draftId }, data: { status: "ACCEPTED" } });
            await tx.documentKeyword.createMany({
                data: draft.keywords.map((keyword) => ({ documentId: draft.documentId, keyword })),
                skipDuplicates: true,
            });
            return finalizedAt;
        });
    },

    // 직접 수정: 받은 제목·본문만 덮어쓴다(AI 원본은 보관하지 않음). 그 사이 상태가 바뀌었으면 0건
    async updateContent(draftId: bigint, data: { title?: string; content?: string }) {
        const { count } = await prisma.draft.updateMany({ where: { draftId, status: "GENERATED" }, data });
        return count > 0;
    },
};
