import { prisma } from "../config/prisma.js";
import type { Category, FailReason, FeedbackReason } from "../generated/prisma/client.js";
import type { DraftResult } from "../utils/aiServer.js";
import { messagesInclude } from "./conversation.repository.js";

const ERROR_MESSAGE_MAX = 1000;

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
                                conversation: { select: { conversationId: true, title: true, deletedAt: true } },
                            },
                        },
                    },
                },
            },
        });
    },

    // 재시도용: 실패한 초안과 보완 항목·기준 회차(AI 보완 회차일 때), 문서, 분석 대상 대화(삭제한 대화 제외)
    findForRetry(draftId: bigint) {
        return prisma.draft.findUnique({
            where: { draftId },
            include: {
                feedbacks: { select: { reason: true } },
                parent: true,
                document: {
                    include: {
                        sources: {
                            where: { conversation: { deletedAt: null } },
                            orderBy: { conversationId: "asc" },
                            select: { conversation: { include: messagesInclude } },
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

    // 문서의 남아 있는 원본 대화 (삭제한 대화 제외). AI 보완 요청에 보낸다
    async findLiveConversations(documentId: bigint) {
        const sources = await prisma.documentConversation.findMany({
            where: { documentId, conversation: { deletedAt: null } },
            orderBy: { conversationId: "asc" },
            select: { conversation: { include: messagesInclude } },
        });
        return sources.map(({ conversation }) => conversation);
    },

    // AI 보완 요청: 기준 회차를 부모로 새 회차(GENERATING)와 보완 항목을 만든다. 기준 회차는 그대로 둔다.
    // 문서 행을 잠근 뒤 진행 중인 보완이 없는지 다시 확인해서, 버튼을 두 번 눌러도 새 회차는 하나만 생긴다 (아니면 null).
    // 새 회차 번호 = 생성이 끝난 회차 중 가장 큰 번호 + 1 (보완이 실패했던 번호는 다시 쓴다).
    // 보완 재시도(DRAFT-05)는 실패한 회차와 같은 번호를 versionNo로 넘긴다
    createRevision(documentId: bigint, parentDraftId: bigint, reasons: FeedbackReason[], versionNo?: number) {
        return prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT document_id FROM documents WHERE document_id = ${documentId} FOR UPDATE`;

            const document = await tx.document.findUnique({ where: { documentId }, select: { status: true } });
            const revising = await tx.draft.count({
                where: { documentId, versionNo: { gt: 1 }, status: "GENERATING" },
            });
            if (document?.status !== "DRAFT_GENERATED" || revising > 0) return null;

            const { _max } = await tx.draft.aggregate({
                where: { documentId, status: { in: ["GENERATED", "ACCEPTED"] } },
                _max: { versionNo: true },
            });
            return tx.draft.create({
                data: {
                    documentId,
                    parentDraftId,
                    versionNo: versionNo ?? (_max.versionNo ?? 1) + 1,
                    feedbacks: { create: reasons.map((reason) => ({ reason })) },
                },
                select: { draftId: true, versionNo: true },
            });
        });
    },

    // AI 보완 완료(AI-03 응답): 새 회차에 결과를 저장하고 GENERATED (문서는 DRAFT_GENERATED 그대로).
    // 기다리는 사이 상태가 바뀌었으면 저장하지 않는다 (false)
    async saveRevisionResult(draftId: bigint, result: DraftResult) {
        const { count } = await prisma.draft.updateMany({
            where: { draftId, status: "GENERATING" },
            data: { ...result, status: "GENERATED" },
        });
        return count > 0;
    },

    // AI 보완 실패: 새 회차만 FAILED로 (문서는 DRAFT_GENERATED 그대로, 기존 회차 유지)
    markRevisionFailed(draftId: bigint, failReason: FailReason, errorMessage: string) {
        return prisma.draft.updateMany({
            where: { draftId, status: "GENERATING" },
            data: { status: "FAILED", failReason, errorMessage: errorMessage.slice(0, ERROR_MESSAGE_MAX) },
        });
    },

    // 서버가 켜질 때: 이전 프로세스에서 AI 서버 응답을 기다리던 초안을 실패로 바꾼다 (기다리던 요청은 서버와 함께 사라짐)
    //  - 1회차는 문서도 FAILED로 (첫 초안 재시도 가능), 2회차 이상은 초안만 (A05-2 보완 실패 → 다시 시도)
    failInterruptedGenerating() {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.draft.updateMany({
                where: { status: "GENERATING" },
                data: {
                    status: "FAILED",
                    failReason: "TIMEOUT",
                    errorMessage: "AI 서버 응답을 기다리는 중 서버가 재시작됨",
                },
            });
            await tx.document.updateMany({ where: { status: "GENERATING" }, data: { status: "FAILED" } });
            return count;
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
