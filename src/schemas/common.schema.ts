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

// 팀 공간 선택값. 없으면 개인 공간
const workspaceIdMeta = { example: 3, description: "팀 워크스페이스 아이디. 생략하면 개인 워크스페이스" };
export const workspaceIdQueryShape = {
    workspaceId: z.coerce.number().int().positive().optional().meta(workspaceIdMeta),
};

export const workspaceIdBodyShape = {
    workspaceId: z.number().int().positive().optional().meta(workspaceIdMeta),
};

// 등록자·생성 요청자·최근 수정자 표시용. 회원이 탈퇴로 영구 삭제됐거나 아직 없으면 null
export const userRefSchema = z
    .object({
        userId: z.number().int().meta({ example: 1 }),
        nickname: z.string().meta({ example: "로컬 사용자" }),
    })
    .nullable()
    .meta({ id: "UserRef" });

export type UserRef = z.infer<typeof userRefSchema>;

export function toUserRef(user: { userId: bigint; nickname: string } | null): UserRef {
    return user ? { userId: Number(user.userId), nickname: user.nickname } : null;
}
