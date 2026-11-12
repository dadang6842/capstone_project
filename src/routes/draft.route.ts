import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { draftController } from "../controllers/draft.controller.js";
import {
    acceptDraftResponseSchema,
    createRevisionBodySchema,
    createRevisionResponseSchema,
    draftDetailSchema,
    draftIdParamsSchema,
    retryDraftResponseSchema,
    updateDraftBodySchema,
    updateDraftResponseSchema,
} from "../schemas/draft.schema.js";
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
        "status가 GENERATING이면 몇 초 뒤 다시 조회, GENERATED·ACCEPTED(채택한 회차)면 내용 표시, FAILED면 실패 안내.",
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
        "화면: A04-1 생성 실패의 '다시 시도'(1회차), A05-2 보완 실패의 '다시 시도'(2회차 이상). 실패한 초안은 남기고 같은 회차의 새 초안을 GENERATING으로 만들어 바로 응답한다. " +
        -"1회차는 첫 초안 생성(AI-01), 2회차 이상은 같은 기준 회차·보완 항목으로 AI 보완(AI-03)을 다시 보낸다. 프론트는 응답의 draftId로 DRAFT-02를 폴링한다.",
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

registry.registerPath({
    method: "post",
    path: "/drafts/{draftId}/revisions",
    tags: ["Draft"],
    summary: "AI 보완 요청 (DRAFT-04)",
    description:
        "화면: A05 → P04 '보완 요청'. 보고 있는 회차를 기준으로 새 회차를 GENERATING으로 만들고 바로 응답한다(AI 서버 요청은 뒤에서). " +
        "프론트는 응답의 draftId로 DRAFT-02를 폴링한다. " +
        "TOO_LONG = 분량 줄이기, MISSING_CONTENT = 누락 내용 보완(원문이 모두 삭제됐으면 409 SOURCES_DELETED).",
    security: bearerAuth,
    request: {
        params: draftIdParamsSchema,
        body: { required: true, content: { "application/json": { schema: createRevisionBodySchema } } },
    },
    responses: {
        201: {
            description: "보완 요청 접수 (새 회차 생성 중)",
            content: { "application/json": { schema: successResponse(createRevisionResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "DRAFT_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "REVISION_IN_PROGRESS",
            "SOURCES_DELETED",
        ),
    },
});
router.post(
    "/:draftId/revisions",
    authenticate,
    validate({ params: draftIdParamsSchema, body: createRevisionBodySchema }),
    draftController.requestRevision,
);

registry.registerPath({
    method: "post",
    path: "/drafts/{draftId}/accept",
    tags: ["Draft"],
    summary: "초안 최종 채택 (DRAFT-03)",
    description:
        "고른 회차를 지식 문서로 확정한다. 최신 회차가 아니어도 된다. 초안의 제목·요약·지식 유형·본문을 문서로, 키워드를 문서 키워드로 복사하고 " +
        "문서를 FINALIZED로 바꾼다. 다른 회차는 그대로 둔다. 생성 완료(GENERATED) 회차만 가능하고, 이미 채택한 문서면 409 INVALID_DRAFT_STATUS, " +
        "AI 보완이 진행 중이면 409 REVISION_IN_PROGRESS. 성공하면 프론트는 지식 문서 상세로 이동한다.",
    security: bearerAuth,
    request: { params: draftIdParamsSchema },
    responses: {
        200: {
            description: "채택 완료",
            content: { "application/json": { schema: successResponse(acceptDraftResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "DRAFT_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "REVISION_IN_PROGRESS",
        ),
    },
});
router.post("/:draftId/accept", authenticate, validate({ params: draftIdParamsSchema }), draftController.accept);

registry.registerPath({
    method: "patch",
    path: "/drafts/{draftId}",
    tags: ["Draft"],
    summary: "초안 제목·본문 직접 수정 (DRAFT-07)",
    description:
        "선택한 회차(GENERATED)의 제목·본문을 덮어쓴다. AI 원본은 따로 보관하지 않고 새 회차도 만들지 않는다. 보낸 필드만 바꾸며 둘 중 하나는 보내야 하고, 보낸 값이 공백만 있으면 400. " +
        "생성 완료 전·실패한 회차, 이미 채택한 문서면 409 INVALID_DRAFT_STATUS, AI 보완이 진행 중이면 409 REVISION_IN_PROGRESS. " +
        "저장한 내용은 이후 최종 채택과 AI 보완 요청의 기준이 된다.",
    security: bearerAuth,
    request: {
        params: draftIdParamsSchema,
        body: { required: true, content: { "application/json": { schema: updateDraftBodySchema } } },
    },
    responses: {
        200: {
            description: "저장 완료",
            content: { "application/json": { schema: successResponse(updateDraftResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "DRAFT_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "REVISION_IN_PROGRESS",
        ),
    },
});
router.patch(
    "/:draftId",
    authenticate,
    validate({ params: draftIdParamsSchema, body: updateDraftBodySchema }),
    draftController.update,
);

export default router;
