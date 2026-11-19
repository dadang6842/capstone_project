import { z } from "zod";
import { pageInfoShape, pageQuerySchema } from "./common.schema.js";
import { addDays, kstToday } from "../utils/kstPeriod.js";

// 관리자 웹 (화면 B01~B04). 관리자 계정(role ADMIN)이 요청한 데이터는 집계에서 뺀다

// ───────── 공통: 조회 기간 ─────────
const dateString = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v, "없는 날짜입니다.");

const DEFAULT_PERIOD_DAYS = 7; // 기간을 안 주면 오늘(KST)까지 최근 7일

const periodShape = {
    from: dateString
        .optional()
        .meta({ example: "2026-10-10", description: "시작일 YYYY-MM-DD (KST, 포함). 생략하면 to의 6일 전" }),
    to: dateString
        .optional()
        .meta({
            example: "2026-10-16",
            description: "종료일 YYYY-MM-DD (KST, 포함). 생략하면 오늘. from 이후, 최대 1년",
        }),
};

// from·to 기본값을 채우고 순서·길이를 확인한다
function withPeriod<T extends { from?: string; to?: string }>(value: T, ctx: z.RefinementCtx) {
    const to = value.to ?? (value.from ? addDays(value.from, DEFAULT_PERIOD_DAYS - 1) : kstToday());
    const from = value.from ?? addDays(to, -(DEFAULT_PERIOD_DAYS - 1));
    if (from > to) ctx.addIssue({ code: "custom", path: ["to"], message: "to는 from보다 같거나 늦어야 합니다." });
    // 최대 1년: to는 다음 해 같은 날짜보다 앞이어야 한다 (2025-10-11 ~ 2026-10-10까지 가능)
    else if (to >= `${Number(from.slice(0, 4)) + 1}${from.slice(4)}`)
        ctx.addIssue({ code: "custom", path: ["to"], message: "조회 기간은 최대 1년입니다." });
    return { ...value, from, to };
}

const intervalSchema = z
    .enum(["day", "week", "month"])
    .default("day")
    .meta({ description: "집계 단위 day(기본) / week(월요일 시작) / month" });

// 문서(스웨거)에는 transform 전 객체를 쓰고, validate에는 transform까지 한 스키마를 쓴다
export const periodQueryDocSchema = z.object({ ...periodShape, interval: intervalSchema });
export const periodQuerySchema = periodQueryDocSchema.transform(withPeriod);
export type PeriodQuery = z.output<typeof periodQuerySchema>;

const appliedShape = {
    from: z.string().meta({ example: "2026-10-10", description: "실제 적용된 시작일" }),
    to: z.string().meta({ example: "2026-10-16", description: "실제 적용된 종료일" }),
    interval: z.enum(["day", "week", "month"]).meta({ description: "실제 적용된 집계 단위" }),
    aggregatedAt: z
        .string()
        .meta({ example: "2026-10-16T05:00:00.000Z", description: "집계 시각 (조회 기준 시각 표시용)" }),
};

const trendDateMeta = {
    example: "2026-10-10",
    description: "구간 시작일 (YYYY-MM-DD). 첫 구간은 from보다 앞서지 않는다",
};

// ───────── ADMIN-01 회원 목록 (B01) ─────────
export const adminUserListQuerySchema = pageQuerySchema.extend({
    q: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .meta({ example: "학습", description: "이메일·닉네임 검색어 (선택, 앞뒤 공백 제거 후 1자 이상)" }),
});
export type AdminUserListQuery = z.output<typeof adminUserListQuerySchema>;

export const adminUserListSchema = z.object({
    ...pageInfoShape,
    users: z.array(
        z.object({
            userId: z.number().int().meta({ example: 3 }),
            nickname: z.string().meta({ example: "학습왕" }),
            email: z.string().meta({ example: "study@example.com" }),
            createdAt: z.string().meta({ example: "2026-09-27T04:30:00.000Z", description: "가입 일시" }),
            lastActiveAt: z
                .string()
                .nullable()
                .meta({
                    example: "2026-10-15T01:58:12.000Z",
                    description: "최근 활동 일시 = 마지막 로그인·토큰 재발급 (없으면 null)",
                }),
            withdrawalRequestedAt: z
                .string()
                .nullable()
                .meta({ example: null, description: "탈퇴 요청 일시 (유예 중이 아니면 null)" }),
        }),
    ),
});

// ───────── ADMIN-02 서비스 이용 통계 (B02) ─────────
export const serviceStatsSchema = z.object({
    aggregatedAt: appliedShape.aggregatedAt,
    userCount: z.number().int().meta({ example: 132, description: "탈퇴 요청하지 않은 일반 회원 수" }),
    documentCount: z
        .number()
        .int()
        .meta({ example: 187, description: "지식 문서 수 (최종 채택, 휴지통 제외, 개인+팀)" }),
    categories: z.array(
        z.object({
            category: z.enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]),
            count: z.number().int().meta({ example: 92 }),
            ratio: z.number().meta({ example: 0.492, description: "전체 지식 문서 대비 비율 (0~1)" }),
        }),
    ),
});

// ───────── ADMIN-03 문서 생성 현황 (B03) ─────────
export const generationStatsSchema = z.object({
    ...appliedShape,
    attemptCount: z
        .number()
        .int()
        .meta({
            example: 48,
            description: "생성 시도 횟수 = 생성 요청(다시 시도 포함) + AI 보완 요청(다시 시도 포함)",
        }),
    failCount: z.number().int().meta({ example: 3, description: "그중 실패" }),
    noContentCount: z
        .number()
        .int()
        .meta({ example: 2, description: "그중 AI가 남길 지식이 없다고 답한 생성 요청 (실패 아님)" }),
    failureRate: z
        .number()
        .nullable()
        .meta({ example: 0.065, description: "실패 / 끝난 시도(진행 중 제외). 대상이 없으면 null" }),
    trend: z.array(
        z.object({
            date: z.string().meta(trendDateMeta),
            attemptCount: z.number().int(),
            failCount: z.number().int(),
        }),
    ),
});

// ───────── ADMIN-04 생성 실패 목록 (B03) ─────────
export const failReasonSchema = z.enum(["GENERATION_FAILED", "REVISION_FAILED", "INVALID_RESPONSE", "TIMEOUT"]);

export const generationFailureQueryDocSchema = z.object({
    ...periodShape,
    ...pageQuerySchema.shape,
    failReason: failReasonSchema.optional().meta({ description: "원인 필터 (선택)" }),
});
export const generationFailureQuerySchema = generationFailureQueryDocSchema.transform(withPeriod);
export type GenerationFailureQuery = z.output<typeof generationFailureQuerySchema>;

export const generationFailureListSchema = z.object({
    ...pageInfoShape,
    from: appliedShape.from,
    to: appliedShape.to,
    failures: z.array(
        z.object({
            jobType: z
                .enum(["FIRST_GENERATION", "REVISION"])
                .meta({ description: "FIRST_GENERATION 문서 생성 요청(첫 초안) / REVISION AI 보완" }),
            generationId: z
                .number()
                .int()
                .nullable()
                .meta({
                    example: 41,
                    description: "생성 요청 아이디 (FIRST_GENERATION일 때. 지식 분할 저장 이전 데이터는 null)",
                }),
            draftId: z
                .number()
                .int()
                .nullable()
                .meta({
                    example: null,
                    description: "초안 아이디 (REVISION일 때. 지식 분할 저장 이전의 첫 생성 실패도 초안 아이디가 있음)",
                }),
            documentId: z
                .number()
                .int()
                .nullable()
                .meta({ example: null, description: "문서 아이디 (생성 요청이 실패하면 문서가 없어서 null)" }),
            versionNo: z.number().int().nullable().meta({ example: null, description: "초안 회차 (REVISION일 때)" }),
            requestedAt: z.string().meta({ example: "2026-10-11T03:11:02.000Z", description: "요청 일시" }),
            isRetry: z.boolean().meta({ description: "'다시 시도'로 보낸 요청인지" }),
            failReason: failReasonSchema.nullable(),
            errorMessage: z.string().nullable().meta({ example: "AI 서버 요청 실패: 502" }),
            userId: z
                .number()
                .int()
                .nullable()
                .meta({ example: 3, description: "요청한 회원 (탈퇴로 영구 삭제됐으면 null)" }),
            userEmail: z.string().nullable().meta({ example: "study@example.com" }),
        }),
    ),
});

// ───────── ADMIN-05 초안 검토 현황 (B04) ─────────
export const reviewStatsSchema = z.object({
    ...appliedShape,
    finalizedDocumentCount: z.number().int().meta({ example: 23, description: "기간 안에 최종 채택된 문서 수" }),
    firstDraftAcceptanceRate: z
        .number()
        .nullable()
        .meta({ example: 0.61, description: "첫 초안 채택률 (0~1, 없으면 null)" }),
    avgDraftsPerDocument: z
        .number()
        .nullable()
        .meta({ example: 1.43, description: "문서당 평균 초안 수 (없으면 null)" }),
    revisionRequestCount: z.number().int().meta({ example: 14, description: "AI 보완 요청 횟수 (다시 시도 제외)" }),
    trend: z.array(
        z.object({
            date: z.string().meta(trendDateMeta),
            firstDraftAcceptanceRate: z.number().nullable(),
            avgDraftsPerDocument: z.number().nullable(),
            revisionRequestCount: z.number().int(),
        }),
    ),
});
