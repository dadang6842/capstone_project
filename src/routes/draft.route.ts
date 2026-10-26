import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { draftController } from "../controllers/draft.controller.js";
import { draftDetailSchema, draftIdParamsSchema } from "../schemas/draft.schema.js";
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
        "FAILED면 생성 실패('다시 시도'). 다른 회원의 초안, 삭제한 문서의 초안은 404.",
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

export default router;
