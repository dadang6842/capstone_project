import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { generationController } from "../controllers/generation.controller.js";
import { generationDetailSchema, generationIdParamsSchema, retryGenerationResponseSchema } from "../schemas/generation.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

// 생성 요청 (2026-11-15 지식 분할 저장). 문서 생성 요청(DRAFT-01 POST /documents)이 만든 생성 요청의 진행 확인·다시 시도
const router = Router();

registry.registerPath({
  method: "get",
  path: "/generations/{generationId}",
  tags: ["Generation"],
  summary: "생성 요청 상태 조회 (GEN-01)",
  description:
    "화면: A04-1 생성 상태 폴링. status가 GENERATING이면 2~3초 뒤 다시 조회한다. " +
    "COMPLETED면 documents에 이번 입력에서 나온 지식 문서 초안 N편이 오고, 각 초안은 draftId로 초안 조회(DRAFT-02)·채택(DRAFT-03, 여러 개는 DRAFT-09)한다. " +
    "NO_CONTENT면 AI가 남길 지식이 없다고 답한 것(noContentReason 안내), FAILED면 실패 안내와 다시 시도(GEN-02). " +
    "reviewStatus가 COMPLETED가 아니면 AI 자동 검토 의견을 받지 못한 것이고 초안은 정상이다. " +
    "팀 생성 요청을 보려면 그 팀의 팀원이어야 한다(아니면 404).",
  security: bearerAuth,
  request: { params: generationIdParamsSchema },
  responses: {
    200: { description: "생성 요청 상태와 결과", content: { "application/json": { schema: successResponse(generationDetailSchema) } } },
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "GENERATION_NOT_FOUND"),
  },
});
router.get("/:generationId", authenticate, validate({ params: generationIdParamsSchema }), generationController.get);

registry.registerPath({
  method: "post",
  path: "/generations/{generationId}/retry",
  tags: ["Generation"],
  summary: "생성 다시 시도 (GEN-02)",
  description:
    "화면: A04-1 생성 실패의 '다시 시도'. 실패한 생성 요청은 남기고, 남아 있는 대화로 새 생성 요청을 GENERATING으로 만들어 바로 202로 응답한다. " +
    "프론트는 응답의 generationId로 GEN-01을 폴링한다. 실패(FAILED)한 요청이면서 가장 최근 시도일 때만 가능하다(아니면 409 INVALID_GENERATION_STATUS). " +
    "고른 대화가 모두 삭제됐으면 409 SOURCES_DELETED, 그 대화로 다른 생성·AI 보완이 진행 중이면 409 CONVERSATION_IN_USE. " +
    "팀 생성 요청은 소유자·관리자는 모두, 일반 구성원은 본인이 요청한 것만 할 수 있다(아니면 403 FORBIDDEN).",
  security: bearerAuth,
  request: { params: generationIdParamsSchema },
  responses: {
    202: { description: "다시 시도 접수", content: { "application/json": { schema: successResponse(retryGenerationResponseSchema) } } },
    ...errorResponses(
      "VALIDATION_ERROR",
      "INPUT_TOO_LARGE",
      "UNAUTHORIZED",
      "TOKEN_EXPIRED",
      "FORBIDDEN",
      "GENERATION_NOT_FOUND",
      "INVALID_GENERATION_STATUS",
      "SOURCES_DELETED",
      "CONVERSATION_IN_USE",
    ),
  },
});
router.post("/:generationId/retry", authenticate, validate({ params: generationIdParamsSchema }), generationController.retry);

export default router;
