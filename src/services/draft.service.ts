import { draftRepository } from "../repositories/draft.repository.js";
import { sendAnalysisRequest } from "./document.service.js";
import { AppError } from "../utils/appError.js";
import type {
    AcceptDraftResponse,
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
                filename: conversation.filename,
                deleted: conversation.deletedAt !== null,
            })),
        };
    },

    // 실패한 초안을 같은 조건으로 다시 요청한다. 실패한 행은 남기고 같은 회차의 새 행을 만들어 바로 응답한다.
    // 첫 초안(1회차)은 AI-01부터 다시 보낸다. AI 보완 회차(2회차 이상)는 AI-03을 만들 때 추가한다.
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
        if (draft.versionNo > 1) {
            throw new AppError("INVALID_DRAFT_STATUS", { message: "AI 보완 회차 재시도는 아직 지원하지 않습니다." });
        }

        // 실패한 문서가 쓰는 대화는 삭제가 막혀 있어서(CONV-04) 보통 남아 있지만, 모두 없으면 다시 분석할 수 없다
        const conversations = draft.document.sources.map(({ conversation }) => conversation);
        if (conversations.length === 0)
            throw new AppError("SOURCES_DELETED", { message: "원본 대화가 모두 삭제되어 다시 생성할 수 없습니다." });

        const created = await draftRepository.createFirstDraftRetry(draft.documentId);
        if (!created) throw new AppError("INVALID_DRAFT_STATUS");

        // await 하지 않는다: 문서 생성 요청(DRAFT-01)과 같이 AI 서버 요청은 뒤에서 보낸다
        void sendAnalysisRequest(draft.documentId, created.draftId, conversations);

        return { draftId: Number(created.draftId), status: "GENERATING" };
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
