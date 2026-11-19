import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { validate } from "../middlewares/validate.js";
import { adminController } from "../controllers/admin.controller.js";
import {
    adminUserListQuerySchema,
    adminUserListSchema,
    generationFailureListSchema,
    generationFailureQueryDocSchema,
    generationFailureQuerySchema,
    generationStatsSchema,
    periodQueryDocSchema,
    periodQuerySchema,
    reviewStatsSchema,
    serviceStatsSchema,
} from "../schemas/admin.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

// 관리자 웹 (화면 B01~B04). 로그인은 AUTH-03 공용이고, 모든 API에서 role ADMIN을 DB로 다시 확인한다.
// 공통: 관리자 계정이 요청·생성한 데이터는 집계에서 뺀다. 날짜는 KST, from·to 모두 포함, 생략하면 오늘까지 최근 7일, 최대 1년.
const router = Router();
router.use(authenticate, requireAdmin);

const json = <T extends Parameters<typeof successResponse>[0]>(schema: T) => ({
    "application/json": { schema: successResponse(schema) },
});
const authErrors = ["UNAUTHORIZED", "TOKEN_EXPIRED", "FORBIDDEN"] as const;

registry.registerPath({
    method: "get",
    path: "/admin/users",
    tags: ["Admin"],
    summary: "회원 목록 조회 (ADMIN-01)",
    description:
        "화면: B01 회원 현황. 일반 회원(role USER)을 가입일 최신순으로 준다. q가 있으면 이메일이나 닉네임에 검색어가 들어간 회원만. " +
        "lastActiveAt은 그 회원의 가장 최근 refresh_tokens.created_at(이메일·구글 로그인, 토큰 재발급 시각). 탈퇴 유예 중인 회원도 포함하고 withdrawalRequestedAt으로 구분한다.",
    security: bearerAuth,
    request: { query: adminUserListQuerySchema },
    responses: {
        200: { description: "회원 목록", content: json(adminUserListSchema) },
        ...errorResponses("VALIDATION_ERROR", ...authErrors),
    },
});
router.get("/users", validate({ query: adminUserListQuerySchema }), adminController.listUsers);

registry.registerPath({
    method: "get",
    path: "/admin/stats/service",
    tags: ["Admin"],
    summary: "서비스 이용 통계 (ADMIN-02)",
    description:
        "화면: B02 서비스 이용 통계. 조회 시점 현황이라 기간을 받지 않는다. userCount: 탈퇴 요청하지 않은 일반 회원 수. " +
        "documentCount: 최종 채택(FINALIZED)했고 휴지통에 없는 지식 문서 수(개인·팀 모두, 검토 중 초안 제외). categories: 같은 문서를 지식 유형별로 센 수와 비율(많은 순, 문서가 없으면 빈 배열).",
    security: bearerAuth,
    responses: {
        200: { description: "서비스 이용 통계", content: json(serviceStatsSchema) },
        ...errorResponses(...authErrors),
    },
});
router.get("/stats/service", adminController.serviceStats);

registry.registerPath({
    method: "get",
    path: "/admin/stats/generation",
    tags: ["Admin"],
    summary: "문서 생성 현황 (ADMIN-03)",
    description:
        "화면: B03 문서 생성 현황. 시도 1번 = 생성 요청 1번(generations 1행, 문서가 여러 편 나와도 1번) 또는 AI 보완 1번(2회차 이상 drafts 1행). 다시 시도도 각각 1번으로 센다. 요청 일시(created_at) 기준. " +
        "failCount: 그중 실패. noContentCount: AI가 남길 지식이 없다고 답한 생성 요청(실패 아님). failureRate: 실패 / 끝난 시도(진행 중 제외), 대상이 없으면 null. " +
        "trend는 interval 구간별 시도·실패 수이고 시도가 없는 구간도 0으로 채운다.",
    security: bearerAuth,
    request: { query: periodQueryDocSchema },
    responses: {
        200: { description: "문서 생성 현황", content: json(generationStatsSchema) },
        ...errorResponses("VALIDATION_ERROR", ...authErrors),
    },
});
router.get("/stats/generation", validate({ query: periodQuerySchema }), adminController.generationStats);

registry.registerPath({
    method: "get",
    path: "/admin/stats/generation/failures",
    tags: ["Admin"],
    summary: "생성 실패 목록 (ADMIN-04)",
    description:
        "화면: B03 실패 건별 목록과 원인. 기간 안에 요청된 생성 요청 실패(FIRST_GENERATION)와 AI 보완 실패(REVISION)를 합쳐 최신순으로 준다. " +
        "생성 요청 실패는 문서가 만들어지지 않아 documentId·draftId가 null이고 generationId가 있다. 회원은 실제로 요청한 사람(팀 문서는 문서 주인과 다를 수 있음). " +
        "isRetry: 생성 요청은 '다시 시도'로 만든 요청, AI 보완은 같은 문서·같은 회차에 먼저 만든 행이 있는 경우.",
    security: bearerAuth,
    request: { query: generationFailureQueryDocSchema },
    responses: {
        200: { description: "생성 실패 목록", content: json(generationFailureListSchema) },
        ...errorResponses("VALIDATION_ERROR", ...authErrors),
    },
});
router.get(
    "/stats/generation/failures",
    validate({ query: generationFailureQuerySchema }),
    adminController.generationFailures,
);

registry.registerPath({
    method: "get",
    path: "/admin/stats/review",
    tags: ["Admin"],
    summary: "초안 검토 현황 (ADMIN-05)",
    description:
        "화면: B04 초안 검토 현황. 기간 전체(요약)와 interval 구간별(trend)을 같은 기준으로 계산한다. " +
        "firstDraftAcceptanceRate: 최종 채택일(finalized_at)이 기간 안인 문서 중 채택한 회차가 1회차인 비율(1회차를 직접 고친 뒤 채택한 경우 포함). " +
        "avgDraftsPerDocument: 같은 문서들의 정상 초안 수(GENERATED·ACCEPTED, 실패 제외) 평균. 직접 수정·저장 이력은 초안으로 세지 않는다. " +
        "revisionRequestCount: 기간 안에 요청된 AI 보완 수(같은 요구의 다시 시도 제외). 채택 문서가 없으면 비율·평균은 null.",
    security: bearerAuth,
    request: { query: periodQueryDocSchema },
    responses: {
        200: { description: "초안 검토 현황", content: json(reviewStatsSchema) },
        ...errorResponses("VALIDATION_ERROR", ...authErrors),
    },
});
router.get("/stats/review", validate({ query: periodQuerySchema }), adminController.reviewStats);

export default router;
