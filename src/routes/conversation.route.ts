import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate.js";
import { conversationController } from "../controllers/conversation.controller.js";
import { validate } from "../middlewares/validate.js";
import {
    conversationDetailSchema,
    conversationIdParamsSchema,
    listConversationsQuerySchema,
    createConversationBodySchema,
    createConversationResponseSchema,
    listConversationsResponseSchema,
} from "../schemas/conversation.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/conversations",
    tags: ["Conversation"],
    summary: "대화 가져오기 - 공유 링크 등록 (CONV-01)",
    description:
        "화면: A03 → P01 대화 등록. ChatGPT 공유 링크(문장 속 링크도 가능)를 받아 대화를 COLLECTING으로 만들고 바로 202로 응답한다. " +
        "수집은 서버가 뒤에서 하며, 프론트는 받은 conversationId로 원본 대화 열람(CONV-03)을 폴링해 COLLECTED·FAILED를 확인한다. " +
        "이미 수집한 대화와 내용이 같으면(capture_id) FAILED·collectFailReason DUPLICATED가 된다(같은 공간 안에서만 비교). " +
        "팀 화면에서는 body에 workspaceId를 넣는다(팀원이면 역할과 관계없이 등록 가능, 팀원이 아니면 404 WORKSPACE_NOT_FOUND).",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: createConversationBodySchema } } } },
    responses: {
        202: {
            description: "등록됨, 수집 시작",
            content: { "application/json": { schema: successResponse(createConversationResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "INVALID_SHARE_URL",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "WORKSPACE_NOT_FOUND",
        ),
    },
});
router.post("/", authenticate, validate({ body: createConversationBodySchema }), conversationController.create);

registry.registerPath({
    method: "get",
    path: "/conversations",
    tags: ["Conversation"],
    summary: "대화 목록 조회 (CONV-02)",
    description:
        "화면: A03 대화 목록, A04 분석 대상 선택. 등록일 최신순이며 수집 중·실패한 대화도 status와 함께 준다(A04에서는 COLLECTED만 고를 수 있게). 대화마다 이 대화로 만든 문서의 생성 결과(generation)를 같이 준다. " +
        "pendingDocuments는 미채택 문서 목록으로, 1개면 바로 초안 검토(A05)로, 여러 개면 펼쳐서 고른다. " +
        "workspaceId를 넣으면 그 팀의 대화 전부(팀 화면 A03, 등록자 registrant 표시), 생략하면 내 개인 대화만(팀에 올린 대화는 빠짐).",
    security: bearerAuth,
    request: { query: listConversationsQuerySchema },
    responses: {
        200: {
            description: "대화 목록",
            content: { "application/json": { schema: successResponse(listConversationsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "WORKSPACE_NOT_FOUND"),
    },
});
router.get("/", authenticate, validate({ query: listConversationsQuerySchema }), conversationController.list);

registry.registerPath({
    method: "get",
    path: "/conversations/{conversationId}",
    tags: ["Conversation"],
    summary: "원본 대화 열람 (CONV-03)",
    description:
        "화면: P02 원문 패널, A05 원본 대조. 대화 정보와 수집한 발화(messages)를 순서대로 준다. 대화 등록(CONV-01) 뒤 수집 상태 폴링에도 이 API를 쓴다(COLLECTING이면 messages는 빈 배열). " +
        "이 대화로 만든 문서 목록도 같이 준다. 다른 회원의 개인 대화, 내가 팀원이 아닌 팀의 대화, 삭제한 대화는 404.",
    security: bearerAuth,
    request: { params: conversationIdParamsSchema },
    responses: {
        200: {
            description: "대화 정보와 발화",
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
        "화면: P03 대화 삭제. 소프트 삭제하며, 이 대화로 만든 문서는 남고 연결된 대화에 deleted: true로 표시된다. " +
        "이 대화를 쓰는 문서가 생성 중(첫 초안·AI 보완·재시도)이면 409 CONVERSATION_IN_USE(details.documentIds). 생성 실패 문서는 막지 않는다. " +
        "팀 대화는 소유자·관리자는 전부, 일반 구성원은 본인이 등록했고 어떤 문서(휴지통 포함)도 쓰지 않는 대화만 지울 수 있다(아니면 403 FORBIDDEN).",
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
            "FORBIDDEN",
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
