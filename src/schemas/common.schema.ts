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
