import { z } from "zod";
import {
    pageInfoShape,
    pageQuerySchema,
    userRefSchema,
    workspaceIdBodyShape,
    workspaceIdQueryShape,
} from "./common.schema.js";
import { generationCardSchema } from "./generation.schema.js";

export const conversationStatusSchema = z
    .enum(["COLLECTING", "COLLECTED", "FAILED"])
    .meta({
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

export const conversationProviderSchema = z
    .enum(["CHATGPT", "GEMINI", "CLAUDE"])
    .meta({ description: "대화를 가져온 AI 서비스" });

export const conversationSourceSchema = z
    .enum(["SHARE_LINK", "PRIVATE_IMPORT"])
    .meta({
        description:
            "들여온 방법. SHARE_LINK 공유 링크 입력(CONV-01), PRIVATE_IMPORT 확장 프로그램으로 가져온 비공개 대화(CONV-05, shareUrl null)",
    });

// 대화 응답 (CONV-01 등록, CONV-02 목록, CONV-03 열람에서 같이 쓴다)
export const conversationSchema = z
    .object({
        conversationId: z.number().int().meta({ example: 7 }),
        title: z
            .string()
            .nullable()
            .meta({ example: "JWT 인증 흐름 질문", description: "공유 페이지 제목 (수집 전·실패면 null)" }),
        shareUrl: z
            .string()
            .nullable()
            .meta({
                example: "https://chatgpt.com/s/cx_6afc799ae73881919c0481c74461dc4a",
                description: "입력한 공유 링크. 비공개 가져오기(PRIVATE_IMPORT)는 null",
            }),
        provider: conversationProviderSchema,
        source: conversationSourceSchema,
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
        url: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .meta({
                example: "참고한 대화 https://chatgpt.com/s/cx_6afc799ae73881919c0481c74461dc4a",
                description:
                    "공유 링크, 또는 링크가 들어 있는 문장 (1~2000자, 링크는 1개만). ChatGPT chatgpt.com/share/·chatgpt.com/s/·chat.openai.com/share/, " +
                    "Gemini g.co/gemini/share/·gemini.google.com/share/·gemini.google.com/u/{N}/share/, Claude claude.ai/share/",
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

// 비공개 대화 가져오기(CONV-05): 확장 프로그램이 읽은 원문 저장
const importMessageSchema = z.object({
    sequence: z
        .number()
        .int()
        .min(1)
        .meta({
            example: 1,
            description: "대화 안 순서. 서로 달라야 하며, 서버는 이 순서로 정렬해 1부터 다시 번호를 붙인다",
        }),
    role: z.enum(["USER", "ASSISTANT"]),
    content: z
        .string()
        .max(1_000_000)
        .refine((value) => value.trim().length > 0, { message: "빈 발화는 보낼 수 없습니다." })
        .meta({ example: "질문 원문", description: "발화 원문 (Markdown·코드 블록 그대로)" }),
});

export const importConversationBodySchema = z
    .object({
        provider: z.enum(["chatgpt", "gemini", "claude"]).meta({ example: "gemini" }),
        externalConversationId: z
            .string()
            .trim()
            .min(1)
            .max(255)
            .meta({ example: "example-conversation-id", description: "서비스의 대화 ID" }),
        contentHash: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/, "64자리 SHA-256 16진수 문자열이어야 합니다.")
            .meta({
                description:
                    "프론트가 계산한 원문 SHA-256. 형식만 확인하고 중복 판단은 서버가 원문으로 다시 계산한 값으로 한다",
            }),
        title: z
            .string()
            .trim()
            .max(255)
            .nullable()
            .optional()
            .meta({ example: "가져온 대화 제목", description: "비어 있으면 첫 질문 앞부분을 제목으로 쓴다" }),
        ...workspaceIdBodyShape,
        messages: z
            .array(importMessageSchema)
            .min(1)
            .max(5000)
            .refine((messages) => new Set(messages.map((m) => m.sequence)).size === messages.length, {
                message: "sequence가 겹칩니다.",
            })
            .meta({ description: "발화 목록. 질문만 있는 대화도 된다" }),
    })
    .meta({ id: "ImportConversationRequest" });

export const importConversationResponseSchema = z
    .object({
        conversationId: z.number().int().meta({ example: 123 }),
        status: z.literal("COLLECTED"),
        duplicate: z
            .boolean()
            .meta({
                description: "true면 같은 공간에 이미 저장된 같은 원문이 있어 새로 만들지 않았다 (기존 conversationId)",
            }),
    })
    .meta({ id: "ImportConversationResponse" });

// 대화 목록 조회(CONV-02)
export const listConversationsQuerySchema = pageQuerySchema.extend(workspaceIdQueryShape);

export const generationStatusSchema = z
    .enum(["NONE", "GENERATING", "FAILED", "PENDING_REVIEW", "COMPLETED", "NO_CONTENT"])
    .meta({
        description:
            "이 대화로 만든 문서·생성 요청의 상태. 여러 개면 GENERATING > FAILED > PENDING_REVIEW > COMPLETED > NO_CONTENT 순으로 하나. " +
            "GENERATING 생성 요청 진행 중이거나 AI 보완 중, FAILED 최근 7일 안에 생성 실패, NO_CONTENT 최근 7일 안에 'AI가 남길 지식이 없다'로 끝난 요청만 있음",
    });

export const conversationListItemSchema = conversationSchema
    .extend({
        generation: z.object({
            status: generationStatusSchema,
            generations: z
                .array(generationCardSchema)
                .meta({
                    description:
                        "아직 문서가 없는 생성 요청 (생성 중 → A04 GEN-01 폴링, 실패 → GEN-02 다시 시도, 문서 없음 → 안내). 최신순",
                }),
            pendingDocuments: z
                .array(
                    z.object({
                        documentId: z.number().int().meta({ example: 15 }),
                        title: z
                            .string()
                            .nullable()
                            .meta({ description: "latestDraftId 초안의 제목 (생성 중·실패면 null)" }),
                        status: z
                            .enum(["GENERATING", "DRAFT_GENERATED", "FAILED"])
                            .meta({
                                description:
                                    "새 흐름의 문서는 항상 DRAFT_GENERATED. GENERATING·FAILED는 2026-11-15 이전에 만든 문서에만 있다",
                            }),
                        latestDraftId: z
                            .number()
                            .int()
                            .nullable()
                            .meta({
                                example: 31,
                                description:
                                    "버튼이 이동할 초안. 검토 중이면 생성이 끝난 최신 회차(A05에서 미리 선택, AI 보완 중인 회차 제외), 예전 데이터의 생성 중·실패 문서면 가장 최근 시도",
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
                    sourceId: z
                        .string()
                        .meta({
                            example: "a1b2c3d4-...",
                            description:
                                "공유 페이지의 메시지 아이디. 초안 조회(DRAFT-02)의 sourceLinks·검토 근거가 가리키는 발화를 찾아 강조할 때 쓴다",
                        }),
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
export type ImportConversationBody = z.infer<typeof importConversationBodySchema>;
export type ImportConversationResponse = z.infer<typeof importConversationResponseSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;
export type ConversationIdParams = z.infer<typeof conversationIdParamsSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
