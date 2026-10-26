import type { Conversation } from "../generated/prisma/client.js";
import { conversationRepository } from "../repositories/conversation.repository.js";
import { documentRepository } from "../repositories/document.repository.js";
import { requestAnalysis } from "../utils/aiServer.js";
import { getViewUrl } from "../utils/s3.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type { CreateDocumentBody, CreateDocumentResponse } from "../schemas/document.schema.js";

// AI-01: 고른 대화의 원본 Presigned URL을 AI 서버로 보낸다.
// 보내지 못하면(주소 미설정, 연결 실패, 에러 응답) 첫 초안을 실패로 바꿔서 사용자가 '다시 시도'(DRAFT-05)할 수 있게 한다.
// prompt가 NULL인 채로 실패하므로 재시도는 AI-01부터 다시 보낸다.
async function sendAnalysisRequest(documentId: bigint, draftId: bigint, conversations: Conversation[]) {
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
    // 이후 AI 서버가 프롬프트를 돌려주면(AI-02) GPT로 초안을 채운다. 프론트는 draftId로 초안 조회(DRAFT-02)를 폴링한다.
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
};
