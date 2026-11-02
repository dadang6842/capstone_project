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

// 문서의 초안 이력 조회(DRAFT-06). 초안 검토 화면의 회차 선택용이라 생성이 끝난 회차의 아이디·번호만
export const draftHistoryResponseSchema = z
    .object({
        latestDraftId: z
            .number()
            .int()
            .nullable()
            .meta({
                example: 31,
                description:
                    "처음 보여 줄 초안. 채택한 회차, 없으면 생성이 끝난 최신 회차 (AI 보완 중인 회차 제외). 볼 초안이 없으면 null",
            }),
        revision: z
            .object({
                draftId: z
                    .number()
                    .int()
                    .meta({
                        example: 33,
                        description: "AI 보완 초안. 회차·보완 항목은 이 아이디로 초안 조회(DRAFT-02)",
                    }),
                status: z
                    .enum(["GENERATING", "FAILED"])
                    .meta({
                        description:
                            "GENERATING이면 보완 중(버튼을 막고 폴링), FAILED면 보완 실패(실패 안내와 다시 시도)",
                    }),
            })
            .nullable()
            .meta({
                description: "마지막 AI 보완이 진행 중이거나 실패했을 때만. 보완 완료·보완 전·채택한 문서는 null",
            }),
        drafts: z
            .array(
                z.object({
                    draftId: z.number().int().meta({ example: 31 }),
                    versionNo: z.number().int().meta({ example: 1, description: "초안 회차" }),
                }),
            )
            .meta({
                description: "생성이 끝난(GENERATED·ACCEPTED) 회차 목록, 회차 오름차순. 생성 중·실패한 초안은 빠진다",
            }),
    })
    .meta({ id: "DraftHistory" });

// 미채택 문서 목록(DRAFT-08). 초안 검토 화면의 '초안 문서 선택'에 쓴다. 검토할 초안이 있는 문서만.
// 보여 줄 회차·보완 중인 회차는 문서를 고른 뒤 초안 이력(DRAFT-06)으로
export const pendingDocumentsResponseSchema = z
    .object({
        documents: z
            .array(
                z.object({
                    documentId: z.number().int().meta({ example: 15 }),
                    title: z
                        .string()
                        .nullable()
                        .meta({ example: "Prisma로 ERD 옮기기", description: "생성이 끝난 최신 회차의 제목" }),
                    createdAt: z.date(),
                }),
            )
            .meta({ description: "검토 중(DRAFT_GENERATED)인 문서 (최근 생성순)" }),
    })
    .meta({ id: "PendingDocuments" });

export type CreateDocumentBody = z.infer<typeof createDocumentBodySchema>;
export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;
export type DocumentIdParams = z.infer<typeof documentIdParamsSchema>;
export type DraftHistoryResponse = z.infer<typeof draftHistoryResponseSchema>;
export type PendingDocumentsResponse = z.infer<typeof pendingDocumentsResponseSchema>;
