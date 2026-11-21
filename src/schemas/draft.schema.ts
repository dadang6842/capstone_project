import { z } from "zod";
import { userRefSchema } from "./common.schema.js";

export const draftIdParamsSchema = z.object({
    draftId: z.coerce.number().int().positive().meta({ description: "초안 아이디" }),
});

// AI 문서가 가리키는 원문 발화 (출처·검토 근거). 원본 대화 열람(CONV-03)의 messages[].sourceId로 찾아 강조한다
const sourceRefSchema = z
    .object({
        conversationId: z.number().int().meta({ example: 7 }),
        sourceId: z
            .string()
            .meta({ example: "a1b2c3d4-...", description: "발화 아이디 (CONV-03 messages[].sourceId)" }),
        role: z.enum(["USER", "ASSISTANT"]).nullable(),
    })
    .meta({ id: "SourceRef" });

// AI 자동 검토 의견 (2026-11-15 지식 분할 저장). AI가 만든 1회차에만 있다
export const draftReviewSchema = z
    .object({
        status: z
            .string()
            .meta({
                example: "attention_needed",
                description:
                    "AI 검토 상태. attention_needed 확인할 사항 있음, no_issues_detected 지적 없음, incomplete 검토 미완료",
            }),
        label: z.string().meta({ example: "확인할 사항 있음", description: "화면에 그대로 보여 줄 한 줄 판정" }),
        findings: z
            .array(
                z.object({
                    category: z.string().meta({ description: "의견 종류 (AI가 정한 코드값)" }),
                    certainty: z
                        .string()
                        .meta({ example: "likely", description: "확실도. uncertain이면 근거 확인이 안 된 의견" }),
                    fieldPath: z
                        .string()
                        .meta({
                            example: "content",
                            description:
                                "지적한 필드. 본문은 content, 나머지는 AI 쪽 필드 경로 그대로(title, summary, keywords[0], metadata.… 등)",
                        }),
                    passage: z
                        .string()
                        .meta({ description: "지적한 문서 구절. 본문에서 이 문자열을 찾아 강조하면 된다" }),
                    reason: z.string(),
                    impact: z.string(),
                    suggestion: z.string(),
                    evidence: z
                        .array(
                            z.object({
                                kind: z.string().meta({ example: "text", description: "text 또는 code" }),
                                text: z.string().meta({ description: "근거가 된 원문 일부" }),
                                sources: z.array(sourceRefSchema),
                            }),
                        )
                        .meta({ description: "근거 원문" }),
                }),
            )
            .meta({ description: "검토 의견 (최대 5개, 없으면 빈 배열)" }),
    })
    .meta({ id: "DraftReview" });

// 초안 조회(DRAFT-02)
export const draftDetailSchema = z
    .object({
        draftId: z.number().int().meta({ example: 31 }),
        documentId: z.number().int().meta({ example: 15 }),
        generationId: z
            .number()
            .int()
            .nullable()
            .meta({
                example: 9,
                description: "문서를 만든 생성 요청 (같은 입력에서 나온 초안 찾기, 2026-11-15 이전 문서는 null)",
            }),
        parentDraftId: z.number().int().nullable().meta({ description: "이전 초안 아이디 (1회차는 null)" }),
        versionNo: z.number().int().meta({ example: 1, description: "초안 회차" }),
        status: z
            .enum(["GENERATING", "GENERATED", "ACCEPTED", "FAILED"])
            .meta({ description: "초안 상태. GENERATING이면 몇 초 뒤 다시 조회" }),
        title: z.string().nullable().meta({ example: "Prisma로 ERD 옮기기", description: "생성 완료 전에는 null" }),
        summary: z.string().nullable(),
        category: z.enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]).nullable().meta({ description: "지식 유형" }),
        keywords: z.array(z.string()).meta({ example: ["Prisma", "MySQL", "ERD"] }),
        content: z.string().nullable().meta({ description: "본문 (Markdown)" }),
        charCount: z
            .number()
            .int()
            .nullable()
            .meta({
                example: 2148,
                description:
                    "본문 글자수. 공백·줄바꿈·Markdown 기호 포함, 이모지도 1자. 본문이 없으면(생성 중·실패) null",
            }),
        feedbacks: z
            .array(z.string())
            .meta({ description: "이 회차를 만들 때 요청한 보완 항목 코드 (1회차는 빈 배열)" }),
        createdAt: z.date(),
        documentStatus: z
            .enum(["GENERATING", "DRAFT_GENERATED", "FINALIZED", "FAILED"])
            .meta({ description: "문서 상태" }),
        revising: z
            .boolean()
            .meta({ description: "이 문서에 진행 중인 AI 보완 작업이 있는지 (true면 수정·보완·채택 버튼을 막음)" }),
        requester: userRefSchema.meta({ description: "최초 생성 요청자 (문서를 처음 만든 회원)" }),
        lastEditor: userRefSchema.meta({
            description:
                "최근 수정 (초안 직접 수정·AI 보완 요청·최종 채택·지식 문서 수정을 마지막으로 한 회원, 없으면 null)",
        }),
        draftRequester: userRefSchema.meta({
            description: "이번 회차의 생성·보완 요청자 (첫 생성·AI 보완·다시 시도를 요청한 회원)",
        }),
        canEdit: z
            .boolean()
            .meta({
                description:
                    "내가 이 문서의 초안을 직접 수정·AI 보완·다시 시도·채택할 수 있는지. 개인 문서와 팀 소유자·관리자는 true, 팀 일반 구성원은 최초 생성 요청자일 때만 (false면 버튼을 숨김)",
            }),
        conversations: z
            .array(
                z.object({
                    conversationId: z.number().int().meta({ example: 7 }),
                    title: z
                        .string()
                        .nullable()
                        .meta({ example: "JWT 인증 흐름 정리", description: "공유 페이지 제목" }),
                    deleted: z.boolean().meta({ description: "대화가 삭제됐는지 (true면 원문 열람 불가)" }),
                }),
            )
            .meta({ description: "분석한 원본 대화 (원본 대조 → CONV-03)" }),
        review: draftReviewSchema
            .nullable()
            .meta({
                description:
                    "AI 자동 검토 의견. AI가 만든 1회차에만 있고 AI 보완 회차(보완 요청 때는 자동 검토를 하지 않음)·예전 문서는 null",
            }),
        reviewOutdated: z
            .boolean()
            .meta({
                description:
                    "이 회차를 직접 수정·복원한 적이 있는지. true면 검토 의견은 수정 전 AI 원본에 대한 것이라고 안내한다",
            }),
        sourceLinks: z
            .array(sourceRefSchema)
            .meta({
                description:
                    "AI가 이 문서의 출처로 표시한 발화. 1회차와 AI 보완 회차에 있다 (보완 회차는 보완본을 뒷받침하는 발화, 원문 없이 분량만 줄였으면 빈 배열)",
            }),
        uncertainties: z.array(z.string()).meta({ description: "AI가 확신하지 못한 점 (1회차에만, 없으면 빈 배열)" }),
    })
    .meta({ id: "DraftDetail" });

// 초안 생성 재시도(DRAFT-05)
export const retryDraftResponseSchema = z
    .object({
        draftId: z
            .number()
            .int()
            .meta({
                example: 33,
                description: "재시도로 새로 만든 초안 아이디. 이 아이디로 초안 조회(DRAFT-02)를 폴링한다",
            }),
        status: z.literal("GENERATING"),
    })
    .meta({ id: "RetryDraftResponse" });

// AI 보완 요청(DRAFT-04). 설계서 P04의 보완 항목: TOO_LONG = 분량 줄이기, MISSING_CONTENT = 누락 내용 보완
export const createRevisionBodySchema = z
    .object({
        reasons: z
            .array(z.enum(["TOO_LONG", "MISSING_CONTENT"]))
            .min(1, "보완 항목을 하나 이상 골라 주세요.")
            .refine((reasons) => new Set(reasons).size === reasons.length, "같은 보완 항목을 두 번 보낼 수 없습니다.")
            .meta({
                example: ["TOO_LONG", "MISSING_CONTENT"],
                description:
                    "보완 항목 (1개 이상, 중복 불가). TOO_LONG = 분량 줄이기, MISSING_CONTENT = 누락 내용 보완",
            }),
    })
    .meta({ id: "CreateRevisionRequest" });

export const createRevisionResponseSchema = z
    .object({
        draftId: z
            .number()
            .int()
            .meta({ example: 33, description: "새 회차 초안 아이디. 이 아이디로 초안 조회(DRAFT-02)를 폴링한다" }),
        versionNo: z
            .number()
            .int()
            .meta({ example: 3, description: "새 회차 번호 (A05-2의 'N회차 초안을 만들고 있습니다')" }),
        status: z.literal("GENERATING"),
    })
    .meta({ id: "CreateRevisionResponse" });

// 초안 최종 채택(DRAFT-03)
export const acceptDraftResponseSchema = z
    .object({
        documentId: z.number().int().meta({ example: 15 }),
        status: z.literal("FINALIZED"),
        finalizedAt: z.date().meta({ description: "최종 채택 일시" }),
    })
    .meta({ id: "AcceptDraftResponse" });

// 여러 초안 한 번에 채택(DRAFT-09). 같은 입력에서 나온 초안 여러 편을 골라 저장하는 편의 기능 (개별 채택은 DRAFT-03)
export const acceptDraftsBodySchema = z
    .object({
        draftIds: z
            .array(z.number().int().positive())
            .min(1, "채택할 초안을 하나 이상 골라 주세요.")
            .max(20)
            .refine((ids) => new Set(ids).size === ids.length, "같은 초안을 두 번 고를 수 없습니다.")
            .meta({
                example: [31, 32, 34],
                description: "채택할 초안 아이디 (1~20개, 중복 불가). 한 문서에서는 회차 하나만",
            }),
    })
    .meta({ id: "AcceptDraftsRequest" });

export const acceptDraftsResponseSchema = z
    .object({
        documents: z
            .array(
                z.object({
                    documentId: z.number().int().meta({ example: 15 }),
                    draftId: z.number().int().meta({ example: 31 }),
                }),
            )
            .meta({ description: "채택한 문서 (보낸 순서대로)" }),
        status: z.literal("FINALIZED"),
        finalizedAt: z.date().meta({ description: "최종 채택 일시 (모두 같음)" }),
    })
    .meta({ id: "AcceptDraftsResponse" });

// 초안 제목·본문 직접 수정(DRAFT-07). 보낸 필드만 바꾼다 (둘 중 하나 이상 필수)
export const updateDraftBodySchema = z
    .object({
        title: z
            .string()
            .trim()
            .min(1, "제목을 입력해 주세요.")
            .max(255)
            .optional()
            .meta({ example: "Prisma로 ERD 옮기며 정한 규칙", description: "제목 (선택, 보내면 1~255자)" }),
        content: z
            .string()
            .refine((value) => value.trim().length > 0, "본문을 입력해 주세요.")
            .optional()
            .meta({
                example: "# Prisma로 ERD 옮기기\n\n...",
                description: "본문 Markdown (선택, 보내면 공백만 있는 값 불가)",
            }),
    })
    .refine((body) => body.title !== undefined || body.content !== undefined, "제목이나 본문 중 하나는 보내야 합니다.")
    .meta({ id: "UpdateDraftRequest" });

export const updateDraftResponseSchema = z
    .object({ draftId: z.number().int().meta({ example: 31 }) })
    .meta({ id: "UpdateDraftResponse" });

export type DraftIdParams = z.infer<typeof draftIdParamsSchema>;
export type DraftDetail = z.infer<typeof draftDetailSchema>;
export type RetryDraftResponse = z.infer<typeof retryDraftResponseSchema>;
export type AcceptDraftResponse = z.infer<typeof acceptDraftResponseSchema>;
export type AcceptDraftsBody = z.infer<typeof acceptDraftsBodySchema>;
export type AcceptDraftsResponse = z.infer<typeof acceptDraftsResponseSchema>;
export type DraftReview = z.infer<typeof draftReviewSchema>;
export type CreateRevisionBody = z.infer<typeof createRevisionBodySchema>;
export type CreateRevisionResponse = z.infer<typeof createRevisionResponseSchema>;
export type UpdateDraftBody = z.infer<typeof updateDraftBodySchema>;
export type UpdateDraftResponse = z.infer<typeof updateDraftResponseSchema>;
