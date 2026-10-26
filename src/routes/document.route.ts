import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { documentController } from "../controllers/document.controller.js";
import { createDocumentBodySchema, createDocumentResponseSchema } from "../schemas/document.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/documents",
    tags: ["Document"],
    summary: "문서 생성 요청 (DRAFT-01)",
    description:
        "대화 목록에서 고른 대화로 문서 생성을 요청한다. 문서·1회차 초안을 GENERATING으로 만들고 바로 응답한 뒤, 뒤에서 AI 서버로 분석을 요청한다(AI-01). " +
        "다른 회원·삭제한·없는 대화가 섞이면 404(details.conversationIds), 생성 작업이 진행 중인 대화가 섞이면 409(details.documentIds).",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: createDocumentBodySchema } } } },
    responses: {
        201: {
            description: "생성 요청 접수",
            content: { "application/json": { schema: successResponse(createDocumentResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "CONVERSATION_NOT_FOUND",
            "CONVERSATION_IN_USE",
        ),
    },
});
router.post("/", authenticate, validate({ body: createDocumentBodySchema }), documentController.create);

export default router;
