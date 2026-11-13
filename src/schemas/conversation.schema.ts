import { z } from "zod";
import {
    pageInfoShape,
    pageQuerySchema,
    userRefSchema,
    workspaceIdBodyShape,
    workspaceIdQueryShape,
} from "./common.schema.js";

export const conversationStatusSchema = z.enum(["COLLECTING", "COLLECTED", "FAILED"]).meta({
    description:
        "수집 상태. COLLECTING이면 원본 대화 열람(CONV-03)으로 몇 초 간격 폴링, COLLECTED여야 문서 생성에 쓸 수 있음",
});

export const collectFailReasonSchema = z
    .enum(["NOT_ACCESSIBLE", "UNSUPPORTED_CONTENT", "TIMEOUT", "COLLECT_ERROR", "DUPLICATED"])
    .nullable()
    .meta({
        description:
            "수집 실패 원인 (FAILED일 때만). NOT_ACCESSIBLE 링크 접근 실패(삭제·비공개), UNSUPPORTED_CONTENT 수집할 수 없는 대화(이미지 전용 발화 등), TIMEOUT 시간 초과, COLLECT_ERROR 기타, DUPLICATED 이미 수집한 대화와 내용이 같음(삭제하고 기존 대화를 쓰면 됨)",
    });

// 대화 응답 (CONV-01 등록, CONV-02 목록, CONV-03 열람에서 같이 쓴다)
export const conversationSchema = z
    .object({
        conversationId: z.number().int().meta({ example: 7 }),
        title: z
            .string()
            .nullable()
            .meta({ example: "JWT 인증 흐름 질문", description: "공유 페이지 제목 (수집 전·실패면 null)" }),
        shareUrl: z.string().meta({ example: "https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf" }),
        status: conversationStatusSchema,
        collectFailReason: collectFailReasonSchema,
        messageCount: z.number().int().meta({ example: 34, description: "수집한 발화 수 (수집 전·실패면 0)" }),
        registrant: userRefSchema.meta({
            description: "등록자 (팀 화면의 '등록자'). 탈퇴로 영구 삭제된 회원이면 null",
        }),
        createdAt: z.date().meta({ description: "등록 일시 (ISO 8601 UTC)" }),
    })
    .meta({ id: "Conversation" });

// 대화 가져오기(CONV-01): 공유 링크 등록
export const createConversationBodySchema = z
    .object({
        url: z.string().trim().min(1).max(2000).meta({
            example: "https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf",
            description: "ChatGPT 공유 링크. 링크가 들어 있는 문장을 그대로 넣어도 된다 (링크는 1개만)",
        }),
        ...workspaceIdBodyShape,
    })
    .meta({ id: "CreateConversationRequest" });

export const createConversationResponseSchema = z
    .object({
        conversationId: z.number().int().meta({ example: 7 }),
        status: z.literal("COLLECTING"),
    })
    .meta({ id: "CreateConversationResponse" });

// 대화 목록 조회(CONV-02)
export const listConversationsQuerySchema = pageQuerySchema.extend(workspaceIdQueryShape);

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
                        title: z
                            .string()
                            .nullable()
                            .meta({ description: "latestDraftId 초안의 제목 (생성 중·실패면 null)" }),
                        status: z.enum(["GENERATING", "DRAFT_GENERATED", "FAILED"]),
                        latestDraftId: z.number().int().nullable().meta({
                            example: 31,
                            description:
                                "버튼이 이동할 초안. 검토 중이면 생성이 끝난 최신 회차(A05에서 미리 선택, AI 보완 중인 회차 제외), 생성 중·실패면 가장 최근 시도(A04 진행 확인·다시 시도)",
                        }),
                    }),
                )
                .meta({ description: "미채택 문서 목록 (FINALIZED가 아닌 문서)" }),
        }),
    })
    .meta({ id: "ConversationListItem" });

export const listConversationsResponseSchema = z
    .object({ ...pageInfoShape, conversations: z.array(conversationListItemSchema) })
    .meta({ id: "ListConversationsResponse" });

// 원본 대화 열람(CONV-03)
export const conversationIdParamsSchema = z.object({
    conversationId: z.coerce.number().int().positive().meta({ description: "대화 아이디" }),
});

export const conversationDetailSchema = conversationSchema
    .extend({
        messages: z
            .array(
                z.object({
                    sequence: z.number().int().meta({ example: 1 }),
                    role: z.enum(["USER", "ASSISTANT"]),
                    content: z.string().meta({ example: "JWT Refresh Token은 어디에 저장해야 해?" }),
                }),
            )
            .meta({ description: "수집한 발화 (순서대로). 수집 전·실패면 빈 배열" }),
        documents: z
            .array(
                z.object({
                    documentId: z.number().int().meta({ example: 12 }),
                    title: z
                        .string()
                        .nullable()
                        .meta({ example: "JWT 인증 흐름 정리", description: "문서 제목 (채택 전 null)" }),
                }),
            )
            .meta({ description: "이 대화로 만든 문서 (삭제 제외, 최신순)" }),
    })
    .meta({ id: "ConversationDetail" });

export type ConversationResponse = z.infer<typeof conversationSchema>;
export type CreateConversationBody = z.infer<typeof createConversationBodySchema>;
export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;
export type ConversationIdParams = z.infer<typeof conversationIdParamsSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
