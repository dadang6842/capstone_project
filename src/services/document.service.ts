import { conversationRepository, type ConversationWithMessages } from "../repositories/conversation.repository.js";
import { documentRepository } from "../repositories/document.repository.js";
import { AiServerError, requestAnalysis, toAnalysisConversation } from "../utils/aiServer.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import { toPageInfo } from "../schemas/common.schema.js";
import type {
    CreateDocumentBody,
    CreateDocumentResponse,
    DocumentDetail,
    DraftHistoryResponse,
    ListDocumentsQuery,
    ListDocumentsResponse,
    PendingDocumentsResponse,
    UpdateDocumentBody,
    UpdateDocumentResponse,
} from "../schemas/document.schema.js";

// AI 서버 오류를 초안 fail_reason과 로그 코드로 바꾼다 (AI-01·AI-03 공용)
export function describeAiError(err: unknown, generationFailReason: "GENERATION_FAILED" | "REVISION_FAILED") {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof AiServerError))
        return { failReason: generationFailReason, logCode: "AI_SERVER_REQUEST_FAILED" as const, message };
    switch (err.kind) {
        case "TIMEOUT":
            return { failReason: "TIMEOUT" as const, logCode: "AI_SERVER_REQUEST_FAILED" as const, message };
        case "INVALID_RESPONSE":
            return { failReason: "INVALID_RESPONSE" as const, logCode: "AI_INVALID_RESPONSE" as const, message };
        case "GENERATION_FAILED":
            return { failReason: generationFailReason, logCode: "AI_GENERATION_FAILED" as const, message };
        default:
            return { failReason: generationFailReason, logCode: "AI_SERVER_REQUEST_FAILED" as const, message };
    }
}

// AI-01: 고른 대화의 발화를 AI 서버로 보내고, 응답으로 받은 첫 초안을 저장한다. 문서 생성 요청(DRAFT-01)과 첫 초안 재시도(DRAFT-05)에서 쓴다.
// AI 서버가 GPT로 초안을 만드는 동안(수십 초~수 분) 기다리므로 호출하는 쪽은 await 하지 않는다.
// 실패하면(요청 실패, 시간 초과, AI 서버 실패 응답, 형식 오류) 첫 초안·문서를 FAILED로 바꿔서 '다시 시도'(DRAFT-05)할 수 있게 한다.
export async function sendAnalysisRequest(
    documentId: bigint,
    draftId: bigint,
    conversations: ConversationWithMessages[],
) {
    try {
        const result = await requestAnalysis(Number(documentId), conversations.map(toAnalysisConversation));
        if (await documentRepository.saveFirstDraftResult(documentId, draftId, result)) {
            logger.info("첫 초안을 생성하였습니다.", { documentId, draftId });
        }
    } catch (err) {
        const { failReason, logCode, message } = describeAiError(err, "GENERATION_FAILED");
        logger.error(logCode, message, { documentId, draftId });
        await documentRepository
            .markFirstDraftFailed(documentId, draftId, failReason, message)
            .catch((dbErr) =>
                logger.error("DATABASE_ERROR", `실패 처리 저장 실패: ${(dbErr as Error).name}`, { documentId }),
            );
    }
}

export const documentService = {
    // 문서와 1회차 초안을 GENERATING으로 만들고 바로 응답한다. AI 서버 요청은 응답과 상관없이 뒤에서 보낸다(비동기).
    // AI 서버가 응답으로 초안을 주면 초안을 채운다. 프론트는 draftId로 초안 조회(DRAFT-02)를 폴링한다.
    async create(userId: number, { conversationIds }: CreateDocumentBody): Promise<CreateDocumentResponse> {
        const ids = conversationIds.map(BigInt);

        // 다른 회원의 대화, 삭제한 대화, 없는 대화가 하나라도 있으면 404
        const conversations = await conversationRepository.findActiveByIds(BigInt(userId), ids);
        if (conversations.length !== ids.length) {
            const found = new Set(conversations.map((conversation) => Number(conversation.conversationId)));
            throw new AppError("CONVERSATION_NOT_FOUND", {
                details: { conversationIds: conversationIds.filter((id) => !found.has(id)) },
            });
        }

        // 수집이 끝나지 않은(수집 중·실패) 대화가 섞여 있으면 409
        const notCollected = conversations.filter((conversation) => conversation.status !== "COLLECTED");
        if (notCollected.length > 0) {
            throw new AppError("CONVERSATION_NOT_COLLECTED", {
                details: { conversationIds: notCollected.map((conversation) => Number(conversation.conversationId)) },
            });
        }

        // 이미 생성 작업이 진행 중인 대화가 섞여 있으면 409
        const generating = await documentRepository.findGeneratingByConversationIds(ids);
        if (generating.length > 0) {
            throw new AppError("CONVERSATION_IN_USE", {
                details: { documentIds: generating.map(({ documentId }) => Number(documentId)) },
            });
        }

        const document = await documentRepository.createWithFirstDraft(BigInt(userId), ids);
        const { draftId } = document.drafts[0];

        // await 하지 않는다: AI 서버가 느리거나 죽어 있어도 사용자는 기다리지 않는다
        void sendAnalysisRequest(document.documentId, draftId, conversations);

        return { documentId: Number(document.documentId), draftId: Number(draftId), status: "GENERATING" };
    },

    // 지식 문서 목록(A06). 최종 채택한 문서만 주고, 검토 중인 초안은 미채택 문서 목록(DRAFT-08)에서 본다
    async list(userId: number, { page, limit, q, category, sort }: ListDocumentsQuery): Promise<ListDocumentsResponse> {
        const [documents, totalCount] = await documentRepository.findFinalizedPage(
            BigInt(userId),
            { q, category, sort },
            { skip: (page - 1) * limit, take: limit },
        );
        return {
            ...toPageInfo(page, limit, totalCount),
            documents: documents.map(({ documentId, keywords, ...document }) => ({
                ...document,
                documentId: Number(documentId),
                keywords: keywords.map(({ keyword }) => keyword),
            })),
        };
    },

    // 지식 문서 상세(A07). 최종 채택한 문서만 보여 주고, 검토 중·생성 중·실패 문서와 다른 회원·삭제한 문서는 404
    // 연결된 대화가 삭제됐으면 deleted: true로 알려 주고, 문서는 계속 열람·수정할 수 있다
    async get(userId: number, documentId: number): Promise<DocumentDetail> {
        const document = await documentRepository.findByIdWithDetail(BigInt(documentId));
        if (!document || document.userId !== BigInt(userId) || document.deletedAt || document.status !== "FINALIZED") {
            throw new AppError("DOCUMENT_NOT_FOUND");
        }

        return {
            documentId: Number(document.documentId),
            title: document.title,
            content: document.content,
            summary: document.summary,
            category: document.category,
            keywords: document.keywords.map(({ keyword }) => keyword),
            conversations: document.sources.map(({ conversation }) => ({
                conversationId: Number(conversation.conversationId),
                title: conversation.title,
                deleted: conversation.deletedAt !== null,
            })),
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
        };
    },

    // 지식 문서 직접 수정(A07-1). 다른 회원·삭제한 문서는 404, 최종 채택 전 문서는 409(초안은 A05에서 수정)
    async update(
        userId: number,
        documentId: number,
        { title, content, keywords }: UpdateDocumentBody,
    ): Promise<UpdateDocumentResponse> {
        const document = await documentRepository.findState(BigInt(documentId));
        if (!document || document.userId !== BigInt(userId) || document.deletedAt)
            throw new AppError("DOCUMENT_NOT_FOUND");
        if (document.status !== "FINALIZED") throw new AppError("DOCUMENT_NOT_FINALIZED");

        // 키워드 중복은 처음 나온 것만 남긴다 (DB가 대소문자를 구분하지 않으므로 같은 기준으로)
        const seen = new Set<string>();
        const uniqueKeywords = keywords?.filter((keyword) => {
            const key = keyword.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const updated = await documentRepository.updateFinalized(BigInt(documentId), {
            title,
            content,
            keywords: uniqueKeywords,
        });
        // 확인한 뒤 저장하기 전에 삭제된 경우
        if (!updated) throw new AppError("DOCUMENT_NOT_FOUND");

        return {
            documentId: Number(updated.documentId),
            title: updated.title,
            keywords: updated.keywords.map(({ keyword }) => keyword),
            updatedAt: updated.updatedAt,
        };
    },

    // 지식 문서 삭제(A07 ⑤, 확인 팝업 P03). A07에서만 삭제하므로 최종 채택한 문서만 지운다.
    // 다른 회원·삭제한·채택 전 문서는 상세(DOC-02)와 같이 404. 연결된 원본 대화는 지우지 않는다
    async delete(userId: number, documentId: number): Promise<void> {
        const document = await documentRepository.findState(BigInt(documentId));
        if (!document || document.userId !== BigInt(userId) || document.deletedAt || document.status !== "FINALIZED") {
            throw new AppError("DOCUMENT_NOT_FOUND");
        }
        // 확인한 뒤 그 사이에 이미 삭제된 경우(삭제 버튼을 두 번 누름 등)
        if (!(await documentRepository.softDeleteFinalized(BigInt(documentId))))
            throw new AppError("DOCUMENT_NOT_FOUND");
    },

    // 한 문서의 초안 회차 목록 (본문 제외). 초안 검토 화면의 회차 선택에 쓴다. 다른 회원·삭제한 문서는 404
    async listDrafts(userId: number, documentId: number): Promise<DraftHistoryResponse> {
        const document = await documentRepository.findWithDraftHistory(BigInt(documentId));
        if (!document || document.userId !== BigInt(userId) || document.deletedAt) {
            throw new AppError("DOCUMENT_NOT_FOUND");
        }

        // 초안은 오름차순이라 뒤집어서 최신부터 찾는다
        const latestFirst = [...document.drafts].reverse();
        const shown =
            latestFirst.find((draft) => draft.status === "ACCEPTED") ??
            latestFirst.find((draft) => draft.status === "GENERATED");
        // 가장 최근 초안이 AI 보완(2회차 이상)이고 생성 중·실패면 보완 상태로 알려 준다. 채택한 문서는 검토가 끝나서 뺀다
        // (다음 회차는 이전 회차가 완성돼야 생기므로 회차·시도 순으로 마지막 초안이 가장 최근 초안)
        const newest = latestFirst[0];
        const revision =
            document.status !== "FINALIZED" &&
            newest &&
            newest.versionNo > 1 &&
            (newest.status === "GENERATING" || newest.status === "FAILED")
                ? { draftId: Number(newest.draftId), status: newest.status }
                : null;

        return {
            latestDraftId: shown ? Number(shown.draftId) : null,
            revision,
            // 회차 선택에는 생성이 끝난 회차만 (한 회차에 성공한 초안은 하나뿐)
            drafts: document.drafts
                .filter((draft) => draft.status === "GENERATED" || draft.status === "ACCEPTED")
                .map((draft) => ({ draftId: Number(draft.draftId), versionNo: draft.versionNo })),
        };
    },

    // 검토할 초안이 있는 문서 목록. 원문 대화의 삭제 여부와 관계없이 보여 준다(삭제한 문서만 뺌)
    // 첫 초안 생성 중·실패 문서는 볼 초안이 없어서 빼고, 진행 확인·재시도는 대화 목록에서 한다
    async listPending(userId: number): Promise<PendingDocumentsResponse> {
        const documents = await documentRepository.findPendingByUser(BigInt(userId));
        return {
            // DRAFT_GENERATED 문서에는 생성이 끝난 회차가 항상 하나 이상 있다
            documents: documents.map(({ documentId, createdAt, drafts: [latest] }) => ({
                documentId: Number(documentId),
                title: latest.title,
                createdAt,
            })),
        };
    },
};
