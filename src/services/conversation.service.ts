import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Conversation } from "../generated/prisma/client.js";
import { conversationRepository, type ConversationWithDocuments } from "../repositories/conversation.repository.js";
import { CONVERSATION_FILE_EXT, type FailedFile } from "../middlewares/upload.js";
import { deleteFile, uploadFile } from "../utils/s3.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import { toPageInfo } from "../schemas/common.schema.js";
import type {
    ConversationListItem,
    ConversationResponse,
    ListConversationsQuery,
    ListConversationsResponse,
    UploadConversationsResponse,
} from "../schemas/conversation.schema.js";

const CONTENT_TYPE = "application/json";

function toConversationResponse(conversation: Conversation): ConversationResponse {
    return {
        conversationId: Number(conversation.conversationId),
        filename: conversation.filename,
        contentType: conversation.contentType,
        fileSize: Number(conversation.fileSize),
        createdAt: conversation.createdAt,
        refinedAt: conversation.refinedAt,
    };
}

// 대화 목록의 generation: 이 대화로 만든 문서들의 생성 결과를 하나의 상태로 묶는다
function toGeneration({ documentConversations }: ConversationWithDocuments): ConversationListItem["generation"] {
    const documents = documentConversations.map(({ document }) => document);
    const pending = documents.filter((document) => document.status !== "FINALIZED");
    // 첫 초안 생성 중이거나, 검토 중인 문서에 AI 보완 중인 초안이 있으면 생성 중
    const generating = documents.some(
        (document) =>
            document.status === "GENERATING" || document.drafts.some((draft) => draft.status === "GENERATING"),
    );

    let status: ConversationListItem["generation"]["status"] = "NONE";
    if (generating) status = "GENERATING";
    else if (documents.some((document) => document.status === "FAILED")) status = "FAILED";
    else if (pending.length > 0) status = "PENDING_REVIEW";
    else if (documents.length > 0) status = "COMPLETED";

    return {
        status,
        pendingDocuments: pending.map((document) => ({
            documentId: Number(document.documentId),
            // 초안은 최신순이라 첫 번째가 최신 회차. 제목은 AI 보완 중인 회차엔 아직 없어서 제목이 있는 가장 최근 초안 것
            title: document.drafts.find((draft) => draft.title !== null)?.title ?? null,
            status: document.status as "GENERATING" | "DRAFT_GENERATED" | "FAILED",
            latestDraftId: document.drafts[0] ? Number(document.drafts[0].draftId) : null,
        })),
    };
}

function errorText(err: unknown) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// 파일 하나를 S3에 올리고 conversations에 기록한다.
// DB 기록에 실패하면 방금 올린 S3 파일을 지워서, 기록 없는 파일이 S3에 남지 않게 한다.
async function saveOne(userId: number, file: Express.Multer.File): Promise<Conversation> {
    // 같은 이름의 파일을 여러 번 올려도 겹치지 않게 키는 UUID로 만든다
    const s3Key = `conversations/${userId}/${randomUUID()}${CONVERSATION_FILE_EXT}`;
    try {
        // 한글이 브라우저에서 깨지지 않게 S3에는 charset을 붙여 저장한다
        await uploadFile({
            key: s3Key,
            filePath: file.path,
            size: file.size,
            contentType: `${CONTENT_TYPE}; charset=utf-8`,
        });
    } catch (err) {
        logger.error("FILE_UPLOAD_FAILED", `'${file.originalname}' ${errorText(err)}`);
        throw err;
    }

    try {
        return await conversationRepository.create({
            userId: BigInt(userId),
            filename: file.originalname,
            contentType: CONTENT_TYPE,
            fileSize: BigInt(file.size),
            s3Key,
        });
    } catch (err) {
        logger.error(
            "DATABASE_ERROR",
            `'${file.originalname}' 대화 기록 실패: ${err instanceof Error ? err.name : String(err)}`,
        );
        await deleteFile(s3Key).catch((deleteErr) =>
            logger.error("FILE_UPLOAD_FAILED", `S3 파일 삭제 실패 (${s3Key}): ${errorText(deleteErr)}`),
        );
        throw err;
    }
}

export const conversationService = {
    async list(userId: number, { page, limit }: ListConversationsQuery): Promise<ListConversationsResponse> {
        const [conversations, totalCount] = await conversationRepository.findPageByUser(BigInt(userId), {
            skip: (page - 1) * limit,
            take: limit,
        });
        return {
            ...toPageInfo(page, limit, totalCount),
            conversations: conversations.map((conversation) => ({
                ...toConversationResponse(conversation),
                generation: toGeneration(conversation),
            })),
        };
    },

    // 내용은 해석하지 않고 S3에 저장한 뒤 conversations에 기록만 한다 (분석은 문서를 만들 때 AI 서버가 함)
    // 파일마다 따로 저장해서, 일부가 실패해도 성공한 파일은 그대로 남긴다
    async upload(
        userId: number,
        files: Express.Multer.File[],
        skipped: FailedFile[],
    ): Promise<UploadConversationsResponse> {
        try {
            const results = await Promise.allSettled(files.map((file) => saveOne(userId, file)));

            const conversations: ConversationResponse[] = [];
            const failed: FailedFile[] = [...skipped];
            results.forEach((result, i) => {
                if (result.status === "fulfilled") conversations.push(toConversationResponse(result.value));
                else
                    failed.push({
                        filename: files[i].originalname,
                        code: "INTERNAL_SERVER_ERROR",
                        message: "파일을 저장하지 못했습니다.",
                    });
            });

            // 하나도 저장하지 못했으면 실패로 응답한다 (원인은 위에서 파일마다 로그로 남김)
            if (conversations.length === 0) throw new AppError("INTERNAL_SERVER_ERROR", { details: { failed } });
            return { conversations, failed };
        } finally {
            // 임시 폴더에 받은 파일은 성공·실패와 상관없이 지운다
            await Promise.all(files.map((file) => rm(file.path, { force: true })));
        }
    },
};
