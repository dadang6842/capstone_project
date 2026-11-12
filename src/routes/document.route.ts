import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { documentController } from "../controllers/document.controller.js";
import {
    createDocumentBodySchema,
    createDocumentResponseSchema,
    documentDetailSchema,
    documentIdParamsSchema,
    draftHistoryResponseSchema,
    listDocumentsQuerySchema,
    listDocumentsResponseSchema,
    pendingDocumentsResponseSchema,
    updateDocumentBodySchema,
    updateDocumentResponseSchema,
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
        "대화 목록에서 고른 대화로 문서 생성을 요청한다. 문서·1회차 초안을 GENERATING으로 만들고 바로 응답한 뒤, 뒤에서 AI 서버에 첫 초안 생성을 요청한다(AI-01, 응답으로 초안을 받음). " +
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

registry.registerPath({
    method: "get",
    path: "/documents",
    tags: ["Document"],
    summary: "지식 문서 목록 조회 (DOC-01)",
    description:
        "화면: A06 지식 문서 목록 → A07 상세. 최종 채택한 내 문서를 제목·본문 검색어(q)와 지식 유형(category)으로 거르고, 수정일(기본) 또는 생성일 최신순으로 20개씩 준다. " +
        "검색해도 정렬은 고른 기준을 따르고, totalCount는 조건에 맞는 문서 수다. 검토 중인 초안은 여기 나오지 않는다(미채택 문서 목록 DRAFT-08).",
    security: bearerAuth,
    request: { query: listDocumentsQuerySchema },
    responses: {
        200: {
            description: "지식 문서 목록",
            content: { "application/json": { schema: successResponse(listDocumentsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get("/", authenticate, validate({ query: listDocumentsQuerySchema }), documentController.list);

// /:documentId 라우트보다 먼저 둔다 ("pending"이 문서 아이디로 읽히지 않게)
registry.registerPath({
    method: "get",
    path: "/documents/pending",
    tags: ["Document"],
    summary: "미채택 문서 목록 (DRAFT-08)",
    description:
        "초안 검토 화면의 '초안 문서 선택'에 쓰는 목록. 검토할 초안이 있는(DRAFT_GENERATED) 내 문서를 원문 대화의 삭제 여부와 관계없이 " +
        "최근 생성순으로 준다(삭제한 문서 제외). 첫 초안 생성 중·실패 문서는 빠진다. title은 생성이 끝난 최신 회차 것이다. " +
        "어떤 회차를 보여 줄지·보완 중인 회차는 문서를 고른 뒤 DRAFT-06으로 조회한다.",
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
        "초안 검토 화면의 회차 선택에 쓴다. 생성이 끝난(GENERATED·ACCEPTED) 회차의 아이디·번호만 준다. latestDraftId는 처음 보여 줄 회차, " +
        "revision은 마지막 AI 보완이 생성 중(GENERATING, 버튼을 막고 DRAFT-02로 폴링)이거나 실패(FAILED, 실패 안내와 다시 시도)일 때만 주고 아니면 null. " +
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

registry.registerPath({
    method: "get",
    path: "/documents/{documentId}",
    tags: ["Document"],
    summary: "지식 문서 상세 조회 (DOC-02)",
    description:
        "화면: A06·A05(최종 채택 후) → A07 지식 문서 상세. 최종 채택한 문서의 본문·키워드와 연결된 원문 대화를 준다. " +
        "원문 열람은 conversations[]의 아이디로 원본 대화 열람(CONV-03), 삭제된 원문은 deleted: true. 채택 전 문서, 다른 회원·삭제한 문서는 404.",
    security: bearerAuth,
    request: { params: documentIdParamsSchema },
    responses: {
        200: {
            description: "지식 문서 상세",
            content: { "application/json": { schema: successResponse(documentDetailSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "DOCUMENT_NOT_FOUND"),
    },
});
router.get("/:documentId", authenticate, validate({ params: documentIdParamsSchema }), documentController.get);

registry.registerPath({
    method: "patch",
    path: "/documents/{documentId}",
    tags: ["Document"],
    summary: "지식 문서 직접 수정 (DOC-03)",
    description:
        "화면: A07-1 지식 문서 직접 수정 → A07. 최종 채택한 문서의 제목·본문·키워드 중 보낸 것만 저장하고 수정일을 갱신한다(이전 내용은 보관하지 않음). " +
        "키워드를 보내면 그 목록으로 통째로 바뀐다. 지식 유형·요약은 수정할 수 없다. 채택 전 문서는 409 DOCUMENT_NOT_FINALIZED.",
    security: bearerAuth,
    request: {
        params: documentIdParamsSchema,
        body: { required: true, content: { "application/json": { schema: updateDocumentBodySchema } } },
    },
    responses: {
        200: {
            description: "수정 완료",
            content: { "application/json": { schema: successResponse(updateDocumentResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "DOCUMENT_NOT_FOUND",
            "DOCUMENT_NOT_FINALIZED",
        ),
    },
});
router.patch(
    "/:documentId",
    authenticate,
    validate({ params: documentIdParamsSchema, body: updateDocumentBodySchema }),
    documentController.update,
);

registry.registerPath({
    method: "delete",
    path: "/documents/{documentId}",
    tags: ["Document"],
    summary: "지식 문서 삭제 (DOC-04)",
    description:
        "화면: A07 ⑤ 문서 삭제 → P03 삭제 확인 → A06. 최종 채택한 문서를 소프트 삭제해 목록·통계에서 뺀다(휴지통·복구 없음). " +
        "연결된 원본 대화는 지우지 않는다. 채택 전 문서, 다른 회원·이미 삭제한 문서는 404.",
    security: bearerAuth,
    request: { params: documentIdParamsSchema },
    responses: {
        200: {
            description: "삭제 완료 (data: null)",
            content: { "application/json": { schema: successResponse(z.null()) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "DOCUMENT_NOT_FOUND"),
    },
});
router.delete("/:documentId", authenticate, validate({ params: documentIdParamsSchema }), documentController.delete);

export default router;
