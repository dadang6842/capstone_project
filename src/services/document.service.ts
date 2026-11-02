import type { Conversation } from "../generated/prisma/client.js";
import { conversationRepository } from "../repositories/conversation.repository.js";
import { documentRepository } from "../repositories/document.repository.js";
import { requestAnalysis } from "../utils/aiServer.js";
import { getViewUrl } from "../utils/s3.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type {
    CreateDocumentBody,
    CreateDocumentResponse,
    DraftHistoryResponse,
    PendingDocumentsResponse,
} from "../schemas/document.schema.js";

// AI-01: 고른 대화의 원본 Presigned URL을 AI 서버로 보낸다. 문서 생성 요청(DRAFT-01)과 첫 초안 재시도(DRAFT-05)에서 쓴다.
// 보내지 못하면(주소 미설정, 연결 실패, 에러 응답) 첫 초안을 실패로 바꿔서 사용자가 '다시 시도'(DRAFT-05)할 수 있게 한다.
export async function sendAnalysisRequest(documentId: bigint, draftId: bigint, conversations: Conversation[]) {
    try {
        await requestAnalysis(
            Number(documentId),
            await Promise.all(
                conversations.map(async (conversation) => ({
                    conversationId: Number(conversation.conversationId),
                    url: await getViewUrl(conversation.s3Key, conversation.filename),
                    filename: conversation.filename,
                    contentType: conversation.contentType,
                })),
            ),
        );
        logger.info("AI 서버에 대화 분석을 요청하였습니다.", { documentId, draftId });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("AI_SERVER_REQUEST_FAILED", message, { documentId, draftId });
        await documentRepository
            .markFirstDraftFailed(documentId, draftId, "ANALYSIS_FAILED", `AI 서버 요청 실패: ${message}`)
            .catch((dbErr) =>
                logger.error("DATABASE_ERROR", `실패 처리 저장 실패: ${(dbErr as Error).name}`, { documentId }),
            );
    }
}

export const documentService = {
    // 문서와 1회차 초안을 GENERATING으로 만들고 바로 응답한다. AI 서버 요청은 응답과 상관없이 뒤에서 보낸다(비동기).
    // 이후 AI 서버가 결과를 돌려주면(AI-02) 초안을 채운다. 프론트는 draftId로 초안 조회(DRAFT-02)를 폴링한다.
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
