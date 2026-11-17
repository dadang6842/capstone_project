import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { searchController } from "../controllers/search.controller.js";
import {
    continueSearchBodySchema,
    searchIdParamsSchema,
    searchPageQuerySchema,
    searchResultSchema,
    startSearchBodySchema,
} from "../schemas/search.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

// 지식 문서 AI 검색 (2026-11-17). 지식 문서 목록의 제목·본문 검색(DOC-01 ?q)은 그대로 두고 따로 추가한 검색이다
const router = Router();

const resultContent = { "application/json": { schema: successResponse(searchResultSchema) } };

registry.registerPath({
    method: "post",
    path: "/searches",
    tags: ["Search"],
    summary: "AI 검색 시작 (SEARCH-01)",
    description:
        "화면: A06 지식 문서 목록의 AI 검색. 문장으로 물으면 AI가 이 공간의 최종 문서를 관련성이 높아 보이는 순서로 읽고, 관련 문서·이유·근거 구절을 준다(수 초~수십 초). " +
        "status가 IN_PROGRESS면 knownMatches를 '지금까지 n개'로 보여 주고 '더 찾아보기'(SEARCH-02)를, INCOMPLETE면 결과 없음이 아니라 오류 안내와 SEARCH-02를 보여 준다. " +
        "팀 화면에서는 body에 workspaceId를 넣는다(팀원이 아니면 404).",
    security: bearerAuth,
    request: { body: { content: { "application/json": { schema: startSearchBodySchema } } } },
    responses: {
        200: { description: "검색 결과 (첫 묶음)", content: resultContent },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "WORKSPACE_NOT_FOUND",
            "AI_SEARCH_FAILED",
            "AI_SEARCH_UNAVAILABLE",
        ),
    },
});
router.post("/", authenticate, validate({ body: startSearchBodySchema }), searchController.start);

registry.registerPath({
    method: "post",
    path: "/searches/{searchId}/continue",
    tags: ["Search"],
    summary: "AI 검색 이어서 찾기 (SEARCH-02)",
    description:
        "화면: A06 AI 검색의 '더 찾아보기'. 아직 확인하지 않은 문서를 한 묶음 더 AI가 읽는다(모델 비용 발생). 응답의 resultRevision이 1 커지고 결과 순서가 바뀔 수 있어서 1페이지부터 다시 보여 준다. " +
        "그 사이 문서가 수정·삭제·채택됐거나 더 최신 resultRevision이 있으면 409 SEARCH_OUTDATED(다시 검색).",
    security: bearerAuth,
    request: {
        params: searchIdParamsSchema,
        body: { content: { "application/json": { schema: continueSearchBodySchema } } },
    },
    responses: {
        200: { description: "갱신된 검색 결과", content: resultContent },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "WORKSPACE_NOT_FOUND",
            "SEARCH_NOT_FOUND",
            "SEARCH_OUTDATED",
            "AI_SEARCH_FAILED",
            "AI_SEARCH_UNAVAILABLE",
        ),
    },
});
router.post(
    "/:searchId/continue",
    authenticate,
    validate({ params: searchIdParamsSchema, body: continueSearchBodySchema }),
    searchController.continue,
);

registry.registerPath({
    method: "get",
    path: "/searches/{searchId}",
    tags: ["Search"],
    summary: "AI 검색 결과 페이지 이동 (SEARCH-03)",
    description:
        "화면: A06 AI 검색 결과의 페이지 이동. 이미 찾은 결과 안에서 페이지만 옮긴다(모델 호출 없음, 남은 문서를 더 찾지 않음). " +
        "가장 최근 resultRevision을 보내야 하고, 이어서 찾기로 갱신됐거나 문서가 바뀌었으면 409 SEARCH_OUTDATED.",
    security: bearerAuth,
    request: { params: searchIdParamsSchema, query: searchPageQuerySchema },
    responses: {
        200: { description: "요청한 페이지의 검색 결과", content: resultContent },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "WORKSPACE_NOT_FOUND",
            "SEARCH_NOT_FOUND",
            "SEARCH_OUTDATED",
            "AI_SEARCH_FAILED",
            "AI_SEARCH_UNAVAILABLE",
        ),
    },
});
router.get(
    "/:searchId",
    authenticate,
    validate({ params: searchIdParamsSchema, query: searchPageQuerySchema }),
    searchController.page,
);

export default router;
