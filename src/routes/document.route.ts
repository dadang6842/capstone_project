import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { documentController } from "../controllers/document.controller.js";
import {
    createDocumentBodySchema,
    createDocumentResponseSchema,
    documentIdParamsSchema,
    draftHistoryResponseSchema,
    pendingDocumentsResponseSchema,
} from "../schemas/document.schema.js";
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
        "프론트는 응답의 draftId로 초안 조회(DRAFT-02)를 폴링한다. AI 서버에 요청을 보내지 못하면 초안이 FAILED가 되고 다시 시도(DRAFT-05)할 수 있다. " +
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

// /:documentId 라우트보다 먼저 둔다 ("pending"이 문서 아이디로 읽히지 않게)
registry.registerPath({
    method: "get",
    path: "/documents/pending",
    tags: ["Document"],
    summary: "미채택 문서 목록 (DRAFT-08)",
    description:
        "초안 검토 화면의 '초안 문서 선택'에 쓰는 목록. 검토할 초안이 있는 내 문서를 원문 대화의 삭제 여부와 관계없이 " +
        "최근 생성순으로 준다(삭제한 문서 제외). 첫 초안 생성 중·실패 문서는 빠진다. title은 생성이 끝난 최신 회차 것이다. " +
        "초안 회차 선택은 문서를 고른 뒤 DRAFT-06으로 조회한다.",
    security: bearerAuth,
    responses: {
        200: {
            description: "미채택 문서 목록",
            content: { "application/json": { schema: successResponse(pendingDocumentsResponseSchema) } },
        },
        ...errorResponses("UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get("/pending", authenticate, documentController.listPending);

registry.registerPath({
    method: "get",
    path: "/documents/{documentId}/drafts",
    tags: ["Document"],
    summary: "문서의 초안 이력 조회 (DRAFT-06)",
    description:
        "한 문서의 초안 회차 목록을 조회한다(본문 제외). 초안 검토 화면의 회차 선택에 쓴다. 회차 선택에는 GENERATED·ACCEPTED만 보여 주고, " +
        "GENERATING(보완 중)·FAILED(실패) 행은 상태 표시와 재시도에만 쓴다. 재시도한 회차는 같은 versionNo로 FAILED 행과 성공한 행이 함께 있을 수 있다. " +
        "다른 회원의 문서, 삭제한 문서는 404.",
    security: bearerAuth,
    request: { params: documentIdParamsSchema },
    responses: {
        200: {
            description: "초안 회차 목록",
            content: { "application/json": { schema: successResponse(draftHistoryResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "DOCUMENT_NOT_FOUND"),
    },
});
router.get(
    "/:documentId/drafts",
    authenticate,
    validate({ params: documentIdParamsSchema }),
    documentController.listDrafts,
);

export default router;
