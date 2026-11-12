import type { Draft } from "../generated/prisma/client.js";
import type { ConversationWithMessages } from "../repositories/conversation.repository.js";
import { draftRepository } from "../repositories/draft.repository.js";
import { describeAiError, sendAnalysisRequest } from "./document.service.js";
import { requestRevision, toAnalysisConversation } from "../utils/aiServer.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type {
    AcceptDraftResponse,
    CreateRevisionBody,
    CreateRevisionResponse,
    DraftDetail,
    RetryDraftResponse,
    UpdateDraftBody,
    UpdateDraftResponse,
} from "../schemas/draft.schema.js";

// drafts.keywords는 JSON 컬럼이라 배열이 아니면(생성 전 null) 빈 배열
function toKeywords(keywords: unknown): string[] {
    return Array.isArray(keywords) ? (keywords as string[]) : [];
}

// 채택·직접 수정할 수 있는 초안을 찾는다: 생성이 끝난 회차(GENERATED)이고, 문서가 아직 채택 전(DRAFT_GENERATED)이며
// AI 보완이 진행 중이 아니어야 한다
async function findEditableDraft(userId: number, draftId: number) {
    const draft = await draftRepository.findWithDocumentState(BigInt(draftId));
    if (!draft || draft.document.userId !== BigInt(userId) || draft.document.deletedAt) {
        throw new AppError("DRAFT_NOT_FOUND");
    }
    if (draft.status !== "GENERATED" || draft.document.status !== "DRAFT_GENERATED") {
        throw new AppError("INVALID_DRAFT_STATUS");
    }
    if (draft.document.drafts.length > 0) throw new AppError("REVISION_IN_PROGRESS");
    return draft;
}

// AI-03: 기준 회차와 보완 항목, 남아 있는 원본 대화(발화)를 AI 서버로 보내고, 응답으로 받은 새 회차를 저장한다.
// AI 보완 요청(DRAFT-04)과 보완 재시도(DRAFT-05)에서 쓴다. 호출하는 쪽은 await 하지 않는다.
// 실패하면 새 회차를 FAILED로 바꿔서 A05-2에 '보완 실패'와 '다시 시도'가 보이게 한다.
export async function sendRevisionRequest(
    draftId: bigint,
    base: Draft,
    reasons: string[],
    conversations: ConversationWithMessages[],
) {
    try {
        const result = await requestRevision(
            Number(draftId),
            {
                title: base.title,
                category: base.category,
                summary: base.summary,
                keywords: toKeywords(base.keywords),
                content: base.content,
            },
            reasons,
            conversations.map(toAnalysisConversation),
        );
        if (await draftRepository.saveRevisionResult(draftId, result)) {
            logger.info("AI 보완 초안을 생성하였습니다.", { draftId, baseDraftId: base.draftId });
        }
    } catch (err) {
        const { failReason, logCode, message } = describeAiError(err, "REVISION_FAILED");
        logger.error(logCode, message, { draftId });
        await draftRepository
            .markRevisionFailed(draftId, failReason, message)
            .catch((dbErr) =>
                logger.error("DATABASE_ERROR", `실패 처리 저장 실패: ${(dbErr as Error).name}`, { draftId }),
            );
    }
}

// 보완 재시도(A05-2 보완 실패의 '다시 시도'): 실패한 회차와 같은 번호·기준 회차·보완 항목으로 새 행을 만들고 AI-03을 다시 보낸다.
// 기준 회차는 지금 저장된 내용을 쓴다(실패 뒤 직접 수정했다면 수정본). 보완 요청(DRAFT-04)과 같은 조건을 확인한다.
async function retryRevision(
    draft: NonNullable<Awaited<ReturnType<typeof draftRepository.findForRetry>>>,
    conversations: ConversationWithMessages[],
): Promise<RetryDraftResponse> {
    const { parent, document } = draft;
    if (!parent || parent.status !== "GENERATED" || document.status !== "DRAFT_GENERATED")
        throw new AppError("INVALID_DRAFT_STATUS");

    const reasons = draft.feedbacks.map(({ reason }) => reason);
    if (reasons.includes("MISSING_CONTENT") && conversations.length === 0) {
        throw new AppError("SOURCES_DELETED", {
            message: "원본 대화가 모두 삭제되어 누락 내용 보완을 다시 요청할 수 없습니다.",
        });
    }

    const created = await draftRepository.createRevision(draft.documentId, parent.draftId, reasons, draft.versionNo);
    if (!created) throw new AppError("REVISION_IN_PROGRESS");

    void sendRevisionRequest(created.draftId, parent, reasons, conversations);
    return { draftId: Number(created.draftId), status: "GENERATING" };
}

export const draftService = {
    // 프론트가 생성 상태를 폴링하는 API. 다른 회원의 초안, 삭제한 문서의 초안은 404
    async get(userId: number, draftId: number): Promise<DraftDetail> {
        const draft = await draftRepository.findByIdWithDocument(BigInt(draftId));
        if (!draft || draft.document.userId !== BigInt(userId) || draft.document.deletedAt) {
            throw new AppError("DRAFT_NOT_FOUND");
        }

        const { document } = draft;
        return {
            draftId: Number(draft.draftId),
            documentId: Number(draft.documentId),
            parentDraftId: draft.parentDraftId === null ? null : Number(draft.parentDraftId),
            versionNo: draft.versionNo,
            status: draft.status,
            title: draft.title,
            summary: draft.summary,
            category: draft.category,
            keywords: toKeywords(draft.keywords),
            content: draft.content,
            feedbacks: draft.feedbacks.map(({ reason }) => reason),
            createdAt: draft.createdAt,
            documentStatus: document.status,
            revising: document.drafts.length > 0,
            conversations: document.sources.map(({ conversation }) => ({
                conversationId: Number(conversation.conversationId),
                title: conversation.title,
                deleted: conversation.deletedAt !== null,
            })),
        };
    },

    // 실패한 초안을 같은 조건으로 다시 요청한다. 실패한 행은 남기고 같은 회차의 새 행을 만들어 바로 응답한다.
    // 첫 초안(1회차)은 AI-01부터, AI 보완 회차(2회차 이상)는 같은 기준 회차·보완 항목으로 AI-03을 다시 보낸다.
    async retry(userId: number, draftId: number): Promise<RetryDraftResponse> {
        const draft = await draftRepository.findForRetry(BigInt(draftId));
        if (!draft || draft.document.userId !== BigInt(userId) || draft.document.deletedAt) {
            throw new AppError("DRAFT_NOT_FOUND");
        }

        // 실패한 초안만, 그리고 그 회차의 가장 최근 시도만 (이미 재시도했으면 새 행으로 다시 시도해야 함)
        if (
            draft.status !== "FAILED" ||
            (await draftRepository.hasNewerAttempt(draft.documentId, draft.versionNo, draft.draftId))
        ) {
            throw new AppError("INVALID_DRAFT_STATUS");
        }
        // 남아 있는 대화로만 다시 분석한다. 실패한 문서의 대화는 삭제할 수 있어서(CONV-04) 모두 없으면 다시 생성할 수 없다
        const conversations = draft.document.sources.map(({ conversation }) => conversation);
        if (draft.versionNo > 1) return retryRevision(draft, conversations);
        if (conversations.length === 0)
            throw new AppError("SOURCES_DELETED", { message: "원본 대화가 모두 삭제되어 다시 생성할 수 없습니다." });

        const created = await draftRepository.createFirstDraftRetry(draft.documentId);
        if (!created) throw new AppError("INVALID_DRAFT_STATUS");

        // await 하지 않는다: 문서 생성 요청(DRAFT-01)과 같이 AI 서버 요청은 뒤에서 보낸다
        void sendAnalysisRequest(draft.documentId, created.draftId, conversations);

        return { draftId: Number(created.draftId), status: "GENERATING" };
    },

    // 고른 회차를 기준으로 AI 보완(새 회차)을 요청한다. 기준 회차는 저장된 내용(직접 수정했다면 수정본) 그대로 쓰고 GENERATED로 남는다.
    // 새 회차를 GENERATING으로 만들고 바로 응답하며, AI 서버 요청(AI-03)은 뒤에서 보낸다. AI 서버가 응답으로 새 회차를 주면 저장한다.
    async requestRevision(
        userId: number,
        draftId: number,
        { reasons }: CreateRevisionBody,
    ): Promise<CreateRevisionResponse> {
        const base = await findEditableDraft(userId, draftId);

        // 설계서 P04: 연결 원문이 모두 삭제됐으면 '누락 내용 보완'은 고를 수 없다 (분량 줄이기는 초안만으로 가능)
        const conversations = await draftRepository.findLiveConversations(base.documentId);
        if (reasons.includes("MISSING_CONTENT") && conversations.length === 0) {
            throw new AppError("SOURCES_DELETED", {
                message: "원본 대화가 모두 삭제되어 누락 내용 보완을 요청할 수 없습니다.",
            });
        }

        const created = await draftRepository.createRevision(base.documentId, base.draftId, reasons);
        if (!created) throw new AppError("REVISION_IN_PROGRESS");

        // await 하지 않는다: AI 서버가 느리거나 죽어 있어도 사용자는 기다리지 않는다
        void sendRevisionRequest(created.draftId, base, reasons, conversations);

        return { draftId: Number(created.draftId), versionNo: created.versionNo, status: "GENERATING" };
    },

    // 고른 회차를 지식 문서로 확정한다. 최신 회차가 아니어도 되고, 다른 회차는 GENERATED로 그대로 둔다.
    async accept(userId: number, draftId: number): Promise<AcceptDraftResponse> {
        const draft = await findEditableDraft(userId, draftId);
        const finalizedAt = await draftRepository.accept({ ...draft, keywords: toKeywords(draft.keywords) });
        if (!finalizedAt) throw new AppError("INVALID_DRAFT_STATUS");

        return { documentId: Number(draft.documentId), status: "FINALIZED", finalizedAt };
    },

    // 선택한 회차의 제목·본문을 덮어쓴다. 새 회차를 만들지 않고, 이후 채택·AI 보완의 기준이 된다.
    async update(userId: number, draftId: number, body: UpdateDraftBody): Promise<UpdateDraftResponse> {
        const draft = await findEditableDraft(userId, draftId);
        if (!(await draftRepository.updateContent(draft.draftId, body))) throw new AppError("INVALID_DRAFT_STATUS");
        return { draftId };
    },
};
