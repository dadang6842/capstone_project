import { prisma } from "../config/prisma.js";
import type { Category, FailReason, FeedbackReason, Prisma } from "../generated/prisma/client.js";
import type { RevisionResult } from "../utils/aiServer.js";
import { messagesInclude } from "./conversation.repository.js";
import { versionRepository } from "./version.repository.js";

const ERROR_MESSAGE_MAX = 1000;

// 생성 요청자·최근 수정자 표시용
const userRef = { select: { userId: true, nickname: true } } as const;

// 채택할 초안 (키워드는 배열로 바꿔서 넘긴다)
type AcceptTarget = {
    draftId: bigint;
    documentId: bigint;
    title: string | null;
    summary: string | null;
    category: Category | null;
    content: string | null;
    keywords: string[];
};

// 여러 초안 채택 중 하나가 실패하면 트랜잭션 전체를 되돌리려고 던지는 표시용 에러
class AcceptConflict extends Error {}

// 채택 한 건 (accept·acceptMany 공용). 문서가 DRAFT_GENERATED가 아니면 아무것도 하지 않고 null
async function acceptInTx(tx: Prisma.TransactionClient, draft: AcceptTarget, editorId: bigint, finalizedAt: Date) {
    const { count } = await tx.document.updateMany({
        where: { documentId: draft.documentId, status: "DRAFT_GENERATED" },
        data: {
            title: draft.title,
            summary: draft.summary,
            category: draft.category,
            content: draft.content,
            status: "FINALIZED",
            finalizedAt,
            lastEditedBy: editorId,
        },
    });
    if (count === 0) return null;

    await tx.draft.update({ where: { draftId: draft.draftId }, data: { status: "ACCEPTED" } });
    await tx.documentKeyword.createMany({
        data: draft.keywords.map((keyword) => ({ documentId: draft.documentId, keyword })),
        skipDuplicates: true,
    });
    await versionRepository.add(tx, {
        documentId: draft.documentId,
        draftId: null,
        source: "ACCEPTED",
        savedBy: editorId,
        title: draft.title,
        content: draft.content,
        summary: draft.summary,
        category: draft.category,
        keywords: draft.keywords,
    });
    return finalizedAt;
}

export const draftRepository = {
    // 초안 조회용: 초안과 이번 회차 요청자, 보완 항목, 직접 저장·복원 이력 수(AI 검토 의견이 수정 전 내용 기준인지),
    // 문서(+ 최초 생성 요청자·최근 수정자, 진행 중인 AI 보완 초안, 분석한 원본 대화)
    findByIdWithDocument(draftId: bigint) {
        return prisma.draft.findUnique({
            where: { draftId },
            include: {
                requester: userRef,
                feedbacks: { select: { reason: true } },
                _count: { select: { versions: { where: { source: { in: ["MANUAL_SAVE", "RESTORE"] } } } } },
                document: {
                    include: {
                        user: userRef,
                        lastEditor: userRef,
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

    // 재시도용: 실패한 초안과 보완 항목·기준 회차, 문서, 분석 대상 대화(삭제한 대화 제외)
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
    // 보완 재시도(DRAFT-05)는 실패한 회차와 같은 번호를 versionNo로 넘긴다.
    // requestedBy = 보완을 요청한 회원 (새 회차의 요청자이자 문서의 최근 수정자)
    createRevision(
        documentId: bigint,
        parentDraftId: bigint,
        requestedBy: bigint,
        reasons: FeedbackReason[],
        versionNo?: number,
    ) {
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
            await tx.document.update({ where: { documentId }, data: { lastEditedBy: requestedBy } });
            return tx.draft.create({
                data: {
                    documentId,
                    parentDraftId,
                    requestedBy,
                    versionNo: versionNo ?? (_max.versionNo ?? 1) + 1,
                    feedbacks: { create: reasons.map((reason) => ({ reason })) },
                },
                select: { draftId: true, versionNo: true },
            });
        });
    },

    // AI 보완 완료(AI-03 응답): 새 회차에 결과를 저장하고 GENERATED (문서는 DRAFT_GENERATED 그대로, 기준 회차는 손대지 않음). 받은 결과는 그 회차 이력에 AI_GENERATED로.
    // 기본 5개 필드는 컬럼에, 나머지(contentHash·sourceLinks·sourceLinksStatus·reviewStatus)는 받은 그대로 이 회차의 ai_detail에 저장한다.
    // 자동 검토(review)는 보완 요청에서 하지 않아서 새 회차엔 없다 → 기준 회차의 검토 의견이 새 회차에 따라오지 않는다.
    // 기다리는 사이 상태가 바뀌었거나 팀이 삭제됐으면 저장하지 않는다 (false)
    saveRevisionResult(draftId: bigint, { title, category, summary, keywords, content, ...aiDetail }: RevisionResult) {
        const fields = { title, category, summary, keywords, content };
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.draft.updateMany({
                where: {
                    draftId,
                    status: "GENERATING",
                    document: { OR: [{ workspaceId: null }, { workspace: { deletedAt: null } }] },
                },
                data: { ...fields, aiDetail: aiDetail as Prisma.InputJsonObject, status: "GENERATED" },
            });
            if (count === 0) return false;
            const { documentId, requestedBy } = await tx.draft.findUniqueOrThrow({
                where: { draftId },
                select: { documentId: true, requestedBy: true },
            });
            await versionRepository.add(tx, {
                documentId,
                draftId,
                source: "AI_GENERATED",
                savedBy: requestedBy,
                ...fields,
            });
            return true;
        });
    },

    // AI 보완 실패: 새 회차만 FAILED로 (문서는 DRAFT_GENERATED 그대로, 기존 회차 유지)
    markRevisionFailed(draftId: bigint, failReason: FailReason, errorMessage: string) {
        return prisma.draft.updateMany({
            where: { draftId, status: "GENERATING" },
            data: { status: "FAILED", failReason, errorMessage: errorMessage.slice(0, ERROR_MESSAGE_MAX) },
        });
    },

    // 서버가 켜질 때: 이전 프로세스에서 AI 서버 응답을 기다리던 초안을 실패로 바꾼다 (기다리던 요청은 서버와 함께 사라짐)
    //  - 2회차 이상은 초안만 (A05-2 보완 실패 → 다시 시도)
    //  - 예전 데이터의 1회차 생성 중 초안이 남아 있으면 문서도 FAILED로 (첫 생성은 이제 generations에서 처리)
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
                        workspaceId: true,
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
    // 문서가 DRAFT_GENERATED일 때만 바꿔서, 두 회차를 동시에 채택해도 하나만 된다 (아니면 null). 채택한 회원이 최근 수정자.
    // 채택한 내용은 지식 문서 이력의 첫 버전(ACCEPTED)이 된다
    accept(draft: AcceptTarget, editorId: bigint) {
        return prisma.$transaction((tx) => acceptInTx(tx, draft, editorId, new Date()));
    },

    // 여러 초안 한 번에 채택(DRAFT-09): 모두 한 트랜잭션에서 채택하고, 하나라도 그 사이 상태가 바뀌었으면 전부 되돌린다 (null)
    async acceptMany(drafts: AcceptTarget[], editorId: bigint) {
        const finalizedAt = new Date();
        try {
            await prisma.$transaction(
                async (tx) => {
                    for (const draft of drafts) {
                        if (!(await acceptInTx(tx, draft, editorId, finalizedAt))) throw new AcceptConflict();
                    }
                },
                { timeout: 30_000 },
            );
            return finalizedAt;
        } catch (err) {
            if (err instanceof AcceptConflict) return null;
            throw err;
        }
    },

    // 직접 수정: 받은 제목·본문만 덮어쓰고 수정한 회원을 문서의 최근 수정자로. 저장한 결과는 그 회차 이력에 MANUAL_SAVE로.
    // 그 사이 상태가 바뀌었으면 false
    updateContent(draftId: bigint, documentId: bigint, editorId: bigint, data: { title?: string; content?: string }) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.draft.updateMany({ where: { draftId, status: "GENERATED" }, data });
            if (count === 0) return false;
            await tx.document.update({ where: { documentId }, data: { lastEditedBy: editorId } });
            const saved = await tx.draft.findUniqueOrThrow({ where: { draftId } });
            await versionRepository.add(tx, {
                documentId,
                draftId,
                source: "MANUAL_SAVE",
                savedBy: editorId,
                title: saved.title,
                content: saved.content,
                summary: saved.summary,
                category: saved.category,
                keywords: Array.isArray(saved.keywords) ? (saved.keywords as string[]) : [],
            });
            return true;
        });
    },
};
