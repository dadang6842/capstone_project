import { z } from "zod";
import { pageInfoShape, pageQuerySchema } from "./common.schema.js";

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
        latestDraftId: z.number().int().nullable().meta({
            example: 31,
            description:
                "처음 보여 줄 초안. 채택한 회차, 없으면 생성이 끝난 최신 회차 (AI 보완 중인 회차 제외). 볼 초안이 없으면 null",
        }),
        revision: z
            .object({
                draftId: z.number().int().meta({
                    example: 33,
                    description: "AI 보완 초안. 회차·보완 항목은 이 아이디로 초안 조회(DRAFT-02)",
                }),
                status: z.enum(["GENERATING", "FAILED"]).meta({
                    description: "GENERATING이면 보완 중(버튼을 막고 폴링), FAILED면 보완 실패(실패 안내와 다시 시도)",
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

// 지식 문서 목록(DOC-01). 최종 채택한 문서를 검색어·지식 유형으로 거르고 수정일·생성일 최신순으로
export const categorySchema = z
    .enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"])
    .meta({ description: "지식 유형" });

export const listDocumentsQuerySchema = pageQuerySchema.extend({
    q: z
        .string()
        .trim()
        // 빈 검색어(?q=)는 검색하지 않은 것으로 본다
        .transform((q) => q || undefined)
        .refine(
            (q) => q === undefined || q.replace(/\s/g, "").length >= 2,
            "검색어는 공백을 빼고 2글자 이상이어야 합니다.",
        )
        .optional()
        .meta({
            example: "RAG",
            description: "제목·본문 검색어 (공백 제외 2글자 이상). 띄어 쓴 단어가 모두 들어간 문서를 찾는다",
        }),
    category: categorySchema.optional().meta({ description: "지식 유형 (생략하면 전체)" }),
    sort: z
        .enum(["updated", "created"])
        .default("updated")
        .meta({ description: "updated: 수정일 최신순(기본), created: 생성일 최신순" }),
});

export const documentListItemSchema = z
    .object({
        documentId: z.number().int().meta({ example: 12 }),
        title: z.string().nullable().meta({
            example: "JWT 인증 흐름 정리",
            description: "최종 문서는 항상 있음 (DB 컬럼이 NULL 허용이라 nullable)",
        }),
        summary: z.string().nullable().meta({ example: "Access·Refresh Token을 나눠 쓰는 이유와 재발급 흐름" }),
        category: categorySchema.nullable(),
        keywords: z.array(z.string()).meta({ example: ["JWT", "Refresh Token"] }),
        createdAt: z.date().meta({ description: "생성일 (문서 생성을 요청한 일시)" }),
        updatedAt: z.date().meta({ description: "수정일" }),
    })
    .meta({ id: "DocumentListItem" });

export const listDocumentsResponseSchema = z
    .object({
        ...pageInfoShape,
        documents: z.array(documentListItemSchema).meta({ description: "지식 문서 목록 (본문 제외)" }),
    })
    .meta({ id: "DocumentList" });

// 지식 문서 상세(DOC-02). 최종 채택한 문서만 (검토 중인 초안은 초안 조회 DRAFT-02)
export const documentDetailSchema = documentListItemSchema
    .extend({
        content: z.string().nullable().meta({
            example: "# JWT 인증 흐름 정리\n\n## Access Token\n- 유효기간 30분 ...",
            description: "본문 (Markdown, 최종 문서는 항상 있음)",
        }),
        conversations: z
            .array(
                z.object({
                    conversationId: z.number().int().meta({ example: 7 }),
                    title: z
                        .string()
                        .nullable()
                        .meta({ example: "JWT 인증 흐름 정리", description: "공유 페이지 제목" }),
                    deleted: z.boolean().meta({
                        description: "대화가 삭제됐는지 (true면 '삭제된 원문'으로 표시하고 열람 버튼을 막음)",
                    }),
                }),
            )
            .meta({ description: "연결된 원문 대화 (가져온 순). '원문 열람'은 원본 대화 열람(CONV-03)" }),
    })
    .meta({ id: "DocumentDetail" });

// 지식 문서 직접 수정(DOC-03). A07-1에서 제목·본문·키워드 중 바꾼 것만 보낸다(하나 이상). 지식 유형·요약은 수정하지 않는다
export const updateDocumentBodySchema = z
    .object({
        title: z
            .string()
            .trim()
            .min(1, "제목을 입력해 주세요.")
            .max(255)
            .optional()
            .meta({ example: "JWT 인증 흐름 정리 (Express)", description: "제목 (선택, 보내면 1~255자)" }),
        content: z
            .string()
            .refine((value) => value.trim().length > 0, "본문을 입력해 주세요.")
            .optional()
            .meta({
                example: "# JWT 인증 흐름 정리\n\n## Access Token\n- 유효기간 30분 ...",
                description: "본문 Markdown (선택, 보내면 공백만 있는 값 불가)",
            }),
        keywords: z
            .array(z.string().trim().min(1, "공백만 있는 키워드는 넣을 수 없습니다.").max(50))
            .max(10)
            .optional()
            .meta({
                example: ["JWT", "Refresh Token", "Express"],
                description:
                    "키워드 전체 목록 (선택, 보내면 0~10개, 키워드당 1~50자). 보낸 목록으로 통째로 바꾸고, 중복(대소문자 무시)은 하나로 합친다",
            }),
    })
    .refine(
        (body) => body.title !== undefined || body.content !== undefined || body.keywords !== undefined,
        "제목·본문·키워드 중 하나는 보내야 합니다.",
    )
    .meta({ id: "UpdateDocumentRequest" });

export const updateDocumentResponseSchema = z
    .object({
        documentId: z.number().int().meta({ example: 12 }),
        title: z
            .string()
            .nullable()
            .meta({ example: "JWT 인증 흐름 정리 (Express)", description: "저장된 제목 (최종 문서는 항상 있음)" }),
        keywords: z
            .array(z.string())
            .meta({ example: ["JWT", "Refresh Token", "Express"], description: "저장된 키워드" }),
        updatedAt: z.date().meta({ description: "수정일 (A07에 표시)" }),
    })
    .meta({ id: "UpdateDocumentResponse" });

export type CreateDocumentBody = z.infer<typeof createDocumentBodySchema>;
export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;
export type DocumentIdParams = z.infer<typeof documentIdParamsSchema>;
export type DraftHistoryResponse = z.infer<typeof draftHistoryResponseSchema>;
export type PendingDocumentsResponse = z.infer<typeof pendingDocumentsResponseSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export type UpdateDocumentBody = z.infer<typeof updateDocumentBodySchema>;
export type UpdateDocumentResponse = z.infer<typeof updateDocumentResponseSchema>;
