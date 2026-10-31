import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { draftController } from "../controllers/draft.controller.js";
import { draftDetailSchema, draftIdParamsSchema, retryDraftResponseSchema } from "../schemas/draft.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "get",
    path: "/drafts/{draftId}",
    tags: ["Draft"],
    summary: "초안 조회 (DRAFT-02)",
    description:
        "초안의 생성 상태와 내용을 조회한다. 문서 생성 요청(DRAFT-01) 뒤 프론트가 몇 초 간격으로 폴링한다. " +
        "상태는 초안의 status로 본다(1회차와 AI 보완 회차 모두): GENERATING이면 생성 중, GENERATED·ACCEPTED면 생성 완료(초안 내용을 보여 줌), " +
        "FAILED면 생성 실패('다시 시도'), NOT_KNOWLEDGE면 지식으로 정리할 내용이 없어 대화를 정리했다고 안내한다. 다른 회원의 초안, 삭제한 문서의 초안은 404.",
    security: bearerAuth,
    request: { params: draftIdParamsSchema },
    responses: {
        200: {
            description: "초안 상태와 내용",
            content: { "application/json": { schema: successResponse(draftDetailSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "DRAFT_NOT_FOUND"),
    },
});
router.get("/:draftId", authenticate, validate({ params: draftIdParamsSchema }), draftController.get);

registry.registerPath({
    method: "post",
    path: "/drafts/{draftId}/retry",
    tags: ["Draft"],
    summary: "초안 생성 재시도 (DRAFT-05)",
    description:
        "생성에 실패(FAILED)한 초안을 같은 조건으로 다시 요청한다. 실패한 초안은 그대로 두고 같은 회차의 새 초안(GENERATING)을 만들어 바로 응답한다. " +
        "프론트는 응답의 draftId로 초안 조회(DRAFT-02)를 폴링한다. 첫 초안은 AI 서버 분석 요청(AI-01)부터 다시 보낸다. " +
        "FAILED가 아니거나 이미 재시도한 초안이면 409 INVALID_DRAFT_STATUS. AI 보완 회차 재시도는 아직 지원하지 않는다(409).",
    security: bearerAuth,
    request: { params: draftIdParamsSchema },
    responses: {
        201: {
            description: "재시도 요청 접수",
            content: { "application/json": { schema: successResponse(retryDraftResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "DRAFT_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "SOURCES_DELETED",
        ),
    },
});
router.post("/:draftId/retry", authenticate, validate({ params: draftIdParamsSchema }), draftController.retry);

export default router;
