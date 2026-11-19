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
    importConversationBodySchema,
    importConversationResponseSchema,
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
        "화면: A03 → P01 대화 등록. ChatGPT(/share/, /s/, chat.openai.com)·Gemini(g.co 단축, gemini.google.com, u/N)·Claude 공유 링크(문장 속 링크도 가능)를 받아 " +
        "대화를 COLLECTING으로 만들고 바로 202로 응답한다. 지원 형식의 링크가 없으면 400 INVALID_SHARE_URL, 서로 다른 링크가 여러 개면 400 INVALID_SHARE_URL(details.candidates). " +
        "수집은 서버가 뒤에서 하며(리디렉션은 단계마다 서비스 도메인인지 확인), 프론트는 받은 conversationId로 원본 대화 열람(CONV-03)을 폴링해 COLLECTED·FAILED를 확인한다. " +
        "리디렉션 뒤 최종 주소와 내용이 이미 수집한 대화와 같으면(capture_id) FAILED·collectFailReason DUPLICATED가 된다(같은 공간 안에서만 비교). " +
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
    method: "post",
    path: "/conversations/import",
    tags: ["Conversation"],
    summary: "비공개 대화 가져오기 (CONV-05)",
    description:
        "화면: P01 대화 등록 > 서비스 작은 창의 가져오기·선택해서 가져오기. 확장 프로그램이 읽은 ChatGPT·Gemini·Claude 대화 원문을 바로 COLLECTED로 저장한다(수집 단계 없음, shareUrl null). " +
        "같은 공간(개인=나, 팀=그 팀)에 서비스·대화 ID·원문(서버가 정규화해 다시 계산한 해시)이 같은 대화가 있으면 새로 만들지 않고 200 + duplicate: true + 기존 conversationId. " +
        "새로 저장하면 201 + duplicate: false. 대화를 삭제한 뒤에는 다시 가져올 수 있다. 발화가 늘어난 대화는 새 대화로 저장된다. " +
        "contentHash는 형식(64자리 16진수)만 확인한다. 팀 화면에서는 workspaceId를 넣는다(팀원이면 역할과 관계없이 가능, 아니면 404 WORKSPACE_NOT_FOUND). 요청 본문은 20MB까지.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: importConversationBodySchema } } } },
    responses: {
        201: {
            description: "새로 저장함",
            content: { "application/json": { schema: successResponse(importConversationResponseSchema) } },
        },
        200: {
            description: "이미 저장된 같은 원문 (duplicate: true)",
            content: { "application/json": { schema: successResponse(importConversationResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "WORKSPACE_NOT_FOUND"),
    },
});
router.post(
    "/import",
    authenticate,
    validate({ body: importConversationBodySchema }),
    conversationController.importConversation,
);

registry.registerPath({
    method: "get",
    path: "/conversations",
    tags: ["Conversation"],
    summary: "대화 목록 조회 (CONV-02)",
    description:
        "화면: A03 대화 목록, A04 분석 대상 선택. 등록일 최신순이며 수집 중·실패한 대화도 status와 함께 준다(A04에서는 COLLECTED만 고를 수 있게). 대화마다 이 대화로 만든 문서의 생성 결과(generation)를 같이 준다. " +
        "pendingDocuments는 미채택 문서 목록으로, 1개면 바로 초안 검토(A05)로, 여러 개면 펼쳐서 고른다. " +
        "generations는 아직 문서가 없는 생성 요청(생성 중, 최근 7일 안의 실패·남길 내용 없음)으로, 생성 중이면 A04에서 GEN-01 폴링, 실패면 GEN-02 다시 시도. " +
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
        "발화의 sourceId는 초안 조회(DRAFT-02)의 sourceLinks·검토 근거가 가리키는 발화 아이디라, 원본 대조에서 해당 발화를 찾아 강조할 때 쓴다. " +
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
        "이 대화로 지식 문서 생성 요청이 진행 중이거나, 이 대화를 쓰는 문서가 AI 보완·재시도 중이면 409 CONVERSATION_IN_USE(details.generationIds·documentIds). 생성 실패는 막지 않는다. " +
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
