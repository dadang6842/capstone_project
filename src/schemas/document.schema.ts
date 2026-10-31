import { z } from "zod";

// 문서 생성 요청(DRAFT-01)
export const createDocumentBodySchema = z
    .object({
        conversationIds: z
            .array(z.number().int().positive())
            .min(1)
            .refine((ids) => new Set(ids).size === ids.length, "같은 대화를 두 번 고를 수 없습니다.")
            .meta({ example: [7, 8], description: "분석할 대화 아이디 (1개 이상, 개수 제한 없음, 중복 불가)" }),
    })
    .meta({ id: "CreateDocumentRequest" });

export const createDocumentResponseSchema = z
    .object({
        documentId: z.number().int().meta({ example: 15 }),
        draftId: z
            .number()
            .int()
            .meta({ example: 31, description: "생성 중인 초안 아이디. 이 아이디로 초안 조회(DRAFT-02)를 폴링한다" }),
        status: z.literal("GENERATING"),
    })
    .meta({ id: "CreateDocumentResponse" });

export const documentIdParamsSchema = z.object({
    documentId: z.coerce.number().int().positive().meta({ description: "문서 아이디" }),
});

// 문서의 초안 이력 조회(DRAFT-06). 본문은 빼고 회차 선택·상태 표시에 필요한 것만
export const draftHistoryResponseSchema = z
    .object({
        revising: z.boolean().meta({ description: "진행 중인 AI 보완 작업이 있는지" }),
        drafts: z
            .array(
                z.object({
                    draftId: z.number().int().meta({ example: 31 }),
                    versionNo: z
                        .number()
                        .int()
                        .meta({
                            example: 1,
                            description:
                                "초안 회차. 재시도한 회차는 같은 번호로 FAILED 행과 성공한 행이 함께 있을 수 있다",
                        }),
                    status: z.enum(["GENERATING", "GENERATED", "ACCEPTED", "FAILED", "NOT_KNOWLEDGE"]),
                    title: z
                        .string()
                        .nullable()
                        .meta({ example: "Prisma로 ERD 옮기기", description: "생성 완료 전에는 null" }),
                    feedbacks: z
                        .array(z.string())
                        .meta({
                            example: [],
                            description: "이 회차를 만들 때 요청한 보완 항목 코드 (1회차는 빈 배열)",
                        }),
                    createdAt: z.date(),
                }),
            )
            .meta({ description: "초안 목록 (회차 오름차순, 같은 회차는 시도 순)" }),
    })
    .meta({ id: "DraftHistory" });

export type CreateDocumentBody = z.infer<typeof createDocumentBodySchema>;
export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;
export type DocumentIdParams = z.infer<typeof documentIdParamsSchema>;
export type DraftHistoryResponse = z.infer<typeof draftHistoryResponseSchema>;
