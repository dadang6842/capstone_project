import { draftRepository } from "../repositories/draft.repository.js";
import { AppError } from "../utils/appError.js";
import type { DraftDetail } from "../schemas/draft.schema.js";

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
            // keywords는 JSON 컬럼이라 배열이 아니면(생성 전 null) 빈 배열
            keywords: Array.isArray(draft.keywords) ? (draft.keywords as string[]) : [],
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
};
