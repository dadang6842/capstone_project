import { z } from "zod";
import { pageInfoShape, pageQuerySchema } from "./common.schema.js";

// 대화 응답 (CONV-01 업로드, CONV-02 목록, CONV-03 열람에서 같이 쓴다)
export const conversationSchema = z
    .object({
        conversationId: z.number().int().meta({ example: 7 }),
        filename: z.string().meta({ example: "claude-jwt-대화.json", description: "원본 파일명" }),
        contentType: z.string().nullable().meta({ example: "application/json" }),
        fileSize: z.number().int().meta({ example: 812034, description: "파일 크기 (byte)" }),
        createdAt: z.date().meta({ description: "가져온 일시 (ISO 8601 UTC)" }),
        refinedAt: z.date().nullable().meta({ description: "AI가 정리한 일시 (null이면 올린 원본 그대로)" }),
    })
    .meta({ id: "Conversation" });

// 대화 가져오기(CONV-01) 요청 (multipart/form-data, 스웨거 문서용. 검증은 upload 미들웨어가 함)
export const uploadConversationsBodySchema = z
    .object({
        files: z
            .array(z.string().meta({ format: "binary" }))
            .meta({ description: "대화 내보내기 파일 (요청당 1~20개, 파일당 50MB, .json)" }),
    })
    .meta({ id: "UploadConversationsRequest" });

export const uploadConversationsResponseSchema = z
    .object({
        conversations: z.array(conversationSchema).meta({ description: "저장된 대화 (올린 순서)" }),
        failed: z
            .array(
                z.object({
                    filename: z.string().meta({ example: "chatgpt-export.zip" }),
                    code: z.string().meta({ example: "UNSUPPORTED_FILE_TYPE" }),
                    message: z.string().meta({ example: "JSON 파일만 올릴 수 있습니다." }),
                }),
            )
            .meta({ description: "저장하지 못한 파일 (없으면 빈 배열)" }),
    })
    .meta({ id: "UploadConversationsResponse" });

// 대화 목록 조회(CONV-02)
export const listConversationsQuerySchema = pageQuerySchema;

export const generationStatusSchema = z.enum(["NONE", "GENERATING", "FAILED", "PENDING_REVIEW", "COMPLETED"]).meta({
    description: "이 대화로 만든 문서들의 상태. 여러 개면 GENERATING > FAILED > PENDING_REVIEW > COMPLETED 순으로 하나",
});

export const conversationListItemSchema = conversationSchema
    .extend({
        generation: z.object({
            status: generationStatusSchema,
            pendingDocuments: z
                .array(
                    z.object({
                        documentId: z.number().int().meta({ example: 15 }),
                        title: z.string().nullable().meta({ description: "최신 회차 초안 제목 (생성 전이면 null)" }),
                        status: z.enum(["GENERATING", "DRAFT_GENERATED", "FAILED"]),
                        latestDraftId: z
                            .number()
                            .int()
                            .nullable()
                            .meta({ example: 31, description: "최신 회차 초안 아이디" }),
                    }),
                )
                .meta({ description: "미채택 문서 목록 (FINALIZED가 아닌 문서)" }),
        }),
    })
    .meta({ id: "ConversationListItem" });

export const listConversationsResponseSchema = z
    .object({ ...pageInfoShape, conversations: z.array(conversationListItemSchema) })
    .meta({ id: "ListConversationsResponse" });

export type ConversationResponse = z.infer<typeof conversationSchema>;
export type UploadConversationsResponse = z.infer<typeof uploadConversationsResponseSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;
