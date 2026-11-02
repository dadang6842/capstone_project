import { z } from "zod";

export const draftIdParamsSchema = z.object({
    draftId: z.coerce.number().int().positive().meta({ description: "초안 아이디" }),
});

// 초안 조회(DRAFT-02)
export const draftDetailSchema = z
    .object({
        draftId: z.number().int().meta({ example: 31 }),
        documentId: z.number().int().meta({ example: 15 }),
        parentDraftId: z.number().int().nullable().meta({ description: "이전 초안 아이디 (1회차는 null)" }),
        versionNo: z.number().int().meta({ example: 1, description: "초안 회차" }),
        status: z
            .enum(["GENERATING", "GENERATED", "ACCEPTED", "FAILED", "NOT_KNOWLEDGE"])
            .meta({ description: "초안 상태. GENERATING이면 몇 초 뒤 다시 조회" }),
        title: z.string().nullable().meta({ example: "Prisma로 ERD 옮기기", description: "생성 완료 전에는 null" }),
        summary: z.string().nullable(),
        category: z.enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]).nullable().meta({ description: "지식 유형" }),
        keywords: z.array(z.string()).meta({ example: ["Prisma", "MySQL", "ERD"] }),
        content: z.string().nullable().meta({ description: "본문 (Markdown)" }),
        feedbacks: z
            .array(z.string())
            .meta({ description: "이 회차를 만들 때 요청한 보완 항목 코드 (1회차는 빈 배열)" }),
        createdAt: z.date(),
        documentStatus: z
            .enum(["GENERATING", "DRAFT_GENERATED", "FINALIZED", "FAILED", "NOT_KNOWLEDGE"])
            .meta({ description: "문서 상태" }),
        revising: z
            .boolean()
            .meta({ description: "이 문서에 진행 중인 AI 보완 작업이 있는지 (true면 수정·보완·채택 버튼을 막음)" }),
        conversations: z
            .array(
                z.object({
                    conversationId: z.number().int().meta({ example: 7 }),
                    filename: z.string().meta({ example: "claude-jwt-대화.json" }),
                    deleted: z.boolean().meta({ description: "대화가 삭제됐는지 (true면 원문 열람 불가)" }),
                }),
            )
            .meta({ description: "분석한 원본 대화 (원본 대조 → CONV-03)" }),
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
export type CreateRevisionBody = z.infer<typeof createRevisionBodySchema>;
export type CreateRevisionResponse = z.infer<typeof createRevisionResponseSchema>;
export type UpdateDraftBody = z.infer<typeof updateDraftBodySchema>;
export type UpdateDraftResponse = z.infer<typeof updateDraftResponseSchema>;
