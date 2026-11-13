import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { versionController } from "../controllers/version.controller.js";
import { draftIdParamsSchema } from "../schemas/draft.schema.js";
import { documentIdParamsSchema } from "../schemas/document.schema.js";
import { listVersionsResponseSchema, versionDetailSchema, versionIdParamsSchema } from "../schemas/version.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

// 저장 이력은 회차(/drafts/{id}/versions)·지식 문서(/documents/{id}/versions)·버전(/versions/{id}) 경로를 같이 쓰므로
// 경로 전체를 이 파일에 적고 routes/index.ts에서 "/"에 붙인다
const router = Router();

registry.registerPath({
    method: "get",
    path: "/drafts/{draftId}/versions",
    tags: ["Version"],
    summary: "회차 저장 이력 (HIST-01)",
    description:
        "화면: A05 'N회차의 저장 이력 · N개 버전', 내용 이력. 한 회차(초안)에 쌓인 버전을 최신순으로 준다. " +
        "AI가 만든 원본(AI_GENERATED, 회차의 1번)·직접 저장(MANUAL_SAVE)·복원(RESTORE). 본문은 빠지고 열어 볼 때 HIST-03. " +
        "문서를 볼 수 있으면 누구나 볼 수 있다(팀은 팀원 전부). 볼 수 없는·삭제한 문서의 초안은 404.",
    security: bearerAuth,
    request: { params: draftIdParamsSchema },
    responses: {
        200: {
            description: "회차 저장 이력",
            content: { "application/json": { schema: successResponse(listVersionsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "DRAFT_NOT_FOUND"),
    },
});
router.get(
    "/drafts/:draftId/versions",
    authenticate,
    validate({ params: draftIdParamsSchema }),
    versionController.listByDraft,
);

registry.registerPath({
    method: "get",
    path: "/documents/{documentId}/versions",
    tags: ["Version"],
    summary: "지식 문서 저장 이력 (HIST-02)",
    description:
        "화면: A07 지식 문서 상세의 내용 이력. 최종 채택 뒤에 쌓인 버전을 최신순으로 준다. " +
        "최초 채택(ACCEPTED, 1번)·직접 저장(MANUAL_SAVE, DOC-03)·복원(RESTORE). 채택 전 문서는 빈 목록. 볼 수 없는·삭제한 문서는 404.",
    security: bearerAuth,
    request: { params: documentIdParamsSchema },
    responses: {
        200: {
            description: "지식 문서 저장 이력",
            content: { "application/json": { schema: successResponse(listVersionsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "DOCUMENT_NOT_FOUND"),
    },
});
router.get(
    "/documents/:documentId/versions",
    authenticate,
    validate({ params: documentIdParamsSchema }),
    versionController.listByDocument,
);

registry.registerPath({
    method: "get",
    path: "/versions/{versionId}",
    tags: ["Version"],
    summary: "저장 이력 버전 보기 (HIST-03)",
    description:
        "화면: A05·A07 내용 이력에서 버전 하나 열어 보기·현재 내용과 비교. 그 시점의 제목·요약·지식 유형·키워드·본문을 준다. " +
        "draftId가 있으면 회차 버전, null이면 지식 문서 버전. 볼 수 없는·삭제한 문서의 버전은 404 VERSION_NOT_FOUND.",
    security: bearerAuth,
    request: { params: versionIdParamsSchema },
    responses: {
        200: {
            description: "버전 내용",
            content: { "application/json": { schema: successResponse(versionDetailSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "VERSION_NOT_FOUND"),
    },
});
router.get("/versions/:versionId", authenticate, validate({ params: versionIdParamsSchema }), versionController.get);

registry.registerPath({
    method: "post",
    path: "/versions/{versionId}/restore",
    tags: ["Version"],
    summary: "이 버전으로 복원 (HIST-04)",
    description:
        "화면: A05·A07 내용 이력의 '이 버전으로 복원'. 현재 내용을 그 버전으로 되돌리고, 이전 버전은 지우지 않고 RESTORE 버전을 새로 쌓는다(응답이 새 버전). " +
        "회차 버전은 제목·본문을 되돌리며 초안 직접 수정과 조건이 같다: 팀은 소유자·관리자·최초 생성 요청자만(아니면 403), 채택했거나 생성 완료 전이면 409 INVALID_DRAFT_STATUS, AI 보완 중이면 409 REVISION_IN_PROGRESS. " +
        "지식 문서 버전은 제목·본문·키워드를 되돌리며 팀원 누구나 할 수 있다. 복원한 회원이 최근 수정자가 된다.",
    security: bearerAuth,
    request: { params: versionIdParamsSchema },
    responses: {
        200: {
            description: "복원 완료 (새로 쌓인 RESTORE 버전)",
            content: { "application/json": { schema: successResponse(versionDetailSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "VERSION_NOT_FOUND",
            "INVALID_DRAFT_STATUS",
            "REVISION_IN_PROGRESS",
            "DOCUMENT_NOT_FINALIZED",
        ),
    },
});
router.post(
    "/versions/:versionId/restore",
    authenticate,
    validate({ params: versionIdParamsSchema }),
    versionController.restore,
);

export default router;
