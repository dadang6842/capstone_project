import { z } from "zod";

// 공통 응답 형식 { success: true, data } 를 만들어 주는 헬퍼 (문서용)
export const successResponse = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });

export const errorResponseSchema = z
    .object({
        success: z.literal(false),
        error: z.object({
            code: z.string().meta({ example: "VALIDATION_ERROR" }),
            message: z.string().meta({ example: "요청 값이 올바르지 않습니다." }),
        }),
    })
    .meta({ id: "ErrorResponse" });

// 목록 API 공통 페이지 쿼리 (?page=1&limit=20). 쿼리 값은 문자열로 들어와서 coerce로 숫자로 바꾼다
export const pageQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1).meta({ description: "페이지 번호 (기본 1)" }),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .meta({ description: "페이지당 항목 수 (기본 20, 최대 50)" }),
});

// 목록 응답에 같이 주는 페이지 정보
export const pageInfoShape = {
    page: z.number().int().meta({ example: 1 }),
    limit: z.number().int().meta({ example: 20 }),
    totalCount: z.number().int().meta({ example: 2, description: "전체 항목 수" }),
    totalPages: z.number().int().meta({ example: 1 }),
    hasNext: z.boolean().meta({ description: "다음 페이지 존재 여부" }),
};

export function toPageInfo(page: number, limit: number, totalCount: number) {
    const totalPages = Math.ceil(totalCount / limit);
    return { page, limit, totalCount, totalPages, hasNext: page < totalPages };
}
