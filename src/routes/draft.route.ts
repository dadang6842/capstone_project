import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { draftController } from "../controllers/draft.controller.js";
import {
    acceptDraftResponseSchema,
    acceptDraftsBodySchema,
    acceptDraftsResponseSchema,
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

// /:draftId 라우트보다 먼저 둔다 ("accept"가 초안 아이디로 읽히지 않게)
registry.registerPath({
    method: "post",
    path: "/drafts/accept",
    tags: ["Draft"],
    summary: "여러 초안 한 번에 채택 (DRAFT-09)",
    description:
        "화면: A05 같은 입력에서 나온 초안 여러 편을 골라 '선택 저장'. 고른 초안을 한 트랜잭션으로 모두 지식 문서로 확정한다(각 초안은 DRAFT-03과 같은 처리). " +
        "개별 채택(DRAFT-03)이 기본이고 이 API는 여러 개를 한 번에 누르는 편의 기능이다. 고르지 않은 초안은 미채택 문서(DRAFT-08)로 남는다. " +
        "모든 초안을 먼저 확인해서 하나라도 채택할 수 없으면 아무것도 채택하지 않고 실패한다. 이때 응답 코드는 404 DRAFT_NOT_FOUND → 403 FORBIDDEN → " +
        "409 INVALID_DRAFT_STATUS·REVISION_IN_PROGRESS 순으로 하나이고, details.draftIds·failures[{ draftId, code }]에 걸린 초안을 모두 준다. " +
        "한 문서의 회차 두 개를 같이 보내면 409 INVALID_DRAFT_STATUS.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: acceptDraftsBodySchema } } } },
    responses: {
        200: {
            description: "모두 채택 완료",
            content: { "application/json": { schema: successResponse(acceptDraftsResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "DRAFT_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "REVISION_IN_PROGRESS",
        ),
    },
});
router.post("/accept", authenticate, validate({ body: acceptDraftsBodySchema }), draftController.acceptMany);

registry.registerPath({
    method: "get",
    path: "/drafts/{draftId}",
    tags: ["Draft"],
    summary: "초안 조회 (DRAFT-02)",
    description:
        "화면: A05 ③ 초안 보기, A05-2 보완 폴링. 초안 하나(회차의 시도 하나)의 상태와 내용을 준다. (첫 생성 진행 확인은 GEN-01) " +
        "status가 GENERATING이면 몇 초 뒤 다시 조회, GENERATED·ACCEPTED(채택한 회차)면 내용 표시, FAILED면 실패 안내. " +
        "팀 화면용으로 최초 생성 요청자(requester)·최근 수정(lastEditor)·이번 회차 생성·보완 요청자(draftRequester)와 내가 고칠 수 있는지(canEdit)를 준다." +
        " AI가 만든 1회차에는 AI 자동 검토 의견(review: 지적한 구절 passage·이유·제안·근거 원문), 출처 발화(sourceLinks), 확신하지 못한 점(uncertainties)이 있다. " +
        "AI 보완 회차에는 출처 발화(sourceLinks)만 있고 자동 검토 의견은 없다(review null, 기준 회차의 의견을 이어받지 않음). " +
        "출처·근거의 sourceId는 원본 대화 열람(CONV-03) messages[].sourceId와 같다. reviewOutdated가 true면 이 회차를 직접 수정·복원해서 검토 의견이 수정 전 내용 기준이다." +
        " 팀 문서를 보려면 그 팀의 팀원이어야 한다(아니면 404).",
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
    summary: "AI 보완 재시도 (DRAFT-05)",
    description:
        "화면: A05-2 보완 실패의 '다시 시도'(2회차 이상). 실패한 초안은 남기고 같은 회차의 새 초안을 GENERATING으로 만들어 바로 응답한다. " +
        "같은 기준 회차·보완 항목으로 AI 보완(AI-03)을 다시 보낸다. 프론트는 응답의 draftId로 DRAFT-02를 폴링한다. " +
        "첫 생성 실패의 다시 시도는 생성 다시 시도(GEN-02)로 옮겼다. 1회차 초안이면 409 INVALID_DRAFT_STATUS. " +
        "팀 문서는 소유자·관리자는 모두, 일반 구성원은 본인이 최초 생성 요청한 문서만 할 수 있다(아니면 403 FORBIDDEN).",
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
            "FORBIDDEN",
            "DRAFT_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "REVISION_IN_PROGRESS",
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
        "프론트는 A05-2 'AI 보완 중'을 띄우고 응답의 draftId로 DRAFT-02를 폴링한다. " +
        "TOO_LONG = 분량 줄이기, MISSING_CONTENT = 누락 내용 보완(원문이 모두 삭제됐으면 409 SOURCES_DELETED). " +
        "둘 다 고르면 한 번의 AI 요청으로 두 항목을 함께 반영한 보완본 한 편이 새 회차가 된다. 기준 회차는 그대로 남는다. " +
        "팀 문서는 소유자·관리자는 모두, 일반 구성원은 본인이 최초 생성 요청한 문서만 할 수 있다(아니면 403 FORBIDDEN).",
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
            "FORBIDDEN",
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
        "AI 보완이 진행 중이면 409 REVISION_IN_PROGRESS. 성공하면 프론트는 지식 문서 상세로 이동한다. " +
        "팀 문서는 소유자·관리자는 모두, 일반 구성원은 본인이 최초 생성 요청한 문서만 할 수 있다(아니면 403 FORBIDDEN).",
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
            "FORBIDDEN",
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
        "저장한 내용은 이후 최종 채택과 AI 보완 요청의 기준이 된다. " +
        "팀 문서는 소유자·관리자는 모두, 일반 구성원은 본인이 최초 생성 요청한 문서만 할 수 있다(아니면 403 FORBIDDEN).",
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
            "FORBIDDEN",
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
