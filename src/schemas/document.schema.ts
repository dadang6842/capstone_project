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

export type CreateDocumentBody = z.infer<typeof createDocumentBodySchema>;
export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;
