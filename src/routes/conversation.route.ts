import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate.js";
import { uploadConversationFiles } from "../middlewares/upload.js";
import { conversationController } from "../controllers/conversation.controller.js";
import { validate } from "../middlewares/validate.js";
import {
    conversationDetailSchema,
    conversationIdParamsSchema,
    listConversationsQuerySchema,
    listConversationsResponseSchema,
    uploadConversationsBodySchema,
    uploadConversationsResponseSchema,
} from "../schemas/conversation.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/conversations",
    tags: ["Conversation"],
    summary: "대화 가져오기 (CONV-01)",
    description:
        "ChatGPT·Claude에서 내보낸 대화 JSON 파일을 올린다. 파일 1개가 대화 1개가 된다. JSON만(확장자로 확인), 요청당 1~20개, 파일당 50MB. " +
        "내용은 해석하지 않고 S3에 저장한 뒤 기록만 한다. 파일마다 따로 저장해서, JSON이 아니거나 저장에 실패한 파일은 failed로 알려 주고 나머지는 저장한다. " +
        "개수·크기 초과는 요청 전체를 거절한다. 하나도 저장하지 못하면 에러로 응답하고 details.failed에 파일별 이유를 준다.",
    security: bearerAuth,
    request: {
        body: { required: true, content: { "multipart/form-data": { schema: uploadConversationsBodySchema } } },
    },
    responses: {
        201: {
            description: "1개 이상 저장됨 (저장 못 한 파일은 failed)",
            content: { "application/json": { schema: successResponse(uploadConversationsResponseSchema) } },
        },
        ...errorResponses(
            "FILE_REQUIRED",
            "FILE_COUNT_EXCEEDED",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FILE_TOO_LARGE",
            "UNSUPPORTED_FILE_TYPE",
            "INTERNAL_SERVER_ERROR",
        ),
    },
});
// 로그인 확인을 먼저 해서, 로그인하지 않은 요청은 파일을 받기 전에 끊는다
router.post("/", authenticate, uploadConversationFiles, conversationController.upload);

registry.registerPath({
    method: "get",
    path: "/conversations",
    tags: ["Conversation"],
    summary: "대화 목록 조회 (CONV-02)",
    description:
        "대화 목록(A03)과 문서 생성의 분석 대상 선택(A04)에 쓴다. 등록일 최신순. 대화마다 이 대화로 만든 문서의 생성 결과(generation)를 같이 준다. " +
        "pendingDocuments는 미채택 문서 목록으로, 1개면 바로 초안 검토(A05)로, 여러 개면 펼쳐서 고른다.",
    security: bearerAuth,
    request: { query: listConversationsQuerySchema },
    responses: {
        200: {
            description: "대화 목록",
            content: { "application/json": { schema: successResponse(listConversationsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get("/", authenticate, validate({ query: listConversationsQuerySchema }), conversationController.list);

registry.registerPath({
    method: "get",
    path: "/conversations/{conversationId}",
    tags: ["Conversation"],
    summary: "원본 대화 열람 (CONV-03)",
    description:
        "대화 정보와 원본 파일 Presigned URL(10분 유효, inline)을 준다. 프론트는 viewUrl을 iframe이나 새 탭으로 띄운다. " +
        "원본 대화 열람, 초안 검토 중 원본 대조, 문서에 연결된 원문 열람에 모두 이 API를 쓴다. 이 대화로 만든 문서 목록도 같이 준다. " +
        "다른 회원의 대화, 삭제한 대화는 404.",
    security: bearerAuth,
    request: { params: conversationIdParamsSchema },
    responses: {
        200: {
            description: "대화 정보와 원본 URL",
            content: { "application/json": { schema: successResponse(conversationDetailSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "CONVERSATION_NOT_FOUND"),
    },
});
router.get(
    "/:conversationId",
    authenticate,
    validate({ params: conversationIdParamsSchema }),
    conversationController.get,
);

registry.registerPath({
    method: "delete",
    path: "/conversations/{conversationId}",
    tags: ["Conversation"],
    summary: "대화 삭제 (CONV-04)",
    description:
        "대화를 소프트 삭제한다. 이 대화로 만든 문서는 지우지 않고, 문서 상세의 연결된 대화에 deleted: true로 표시된다. S3 파일은 배치로 정리한다. " +
        "이 대화를 쓰는 문서가 생성 중(첫 초안·AI 보완·재시도)이거나, 분석에 실패해 재시도를 기다리는 중이면 409 CONVERSATION_IN_USE(details.documentIds).",
    security: bearerAuth,
    request: { params: conversationIdParamsSchema },
    responses: {
        200: {
            description: "삭제 완료 (data: null)",
            content: { "application/json": { schema: successResponse(z.null()) } },
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
router.delete(
    "/:conversationId",
    authenticate,
    validate({ params: conversationIdParamsSchema }),
    conversationController.delete,
);

export default router;
