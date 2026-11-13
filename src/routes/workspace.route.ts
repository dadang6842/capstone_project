import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { workspaceController } from "../controllers/workspace.controller.js";
import {
    createWorkspaceBodySchema,
    listMembersResponseSchema,
    listWorkspacesResponseSchema,
    memberParamsSchema,
    memberSchema,
    transferOwnershipBodySchema,
    transferOwnershipResponseSchema,
    updateMemberRoleBodySchema,
    updateWorkspaceBodySchema,
    workspaceIdParamsSchema,
    workspaceSchema,
} from "../schemas/workspace.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/workspaces",
    tags: ["Workspace"],
    summary: "팀 워크스페이스 만들기 (WS-01)",
    description:
        "화면: 사이드바 '워크스페이스 추가' → 팀 워크스페이스 만들기 팝업. 팀 이름(1~60자, 같은 이름 허용)과 소개(선택)로 팀을 만들고, 만든 사람이 소유자(OWNER)가 된다. " +
        "개인 워크스페이스의 자료는 복사되지 않는다. 프론트는 받은 workspaceId로 그 팀 화면으로 이동하고, 이후 팀 공간의 목록·생성 요청에 workspaceId를 붙인다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: createWorkspaceBodySchema } } } },
    responses: {
        201: { description: "만든 팀", content: { "application/json": { schema: successResponse(workspaceSchema) } } },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.post("/", authenticate, validate({ body: createWorkspaceBodySchema }), workspaceController.create);

registry.registerPath({
    method: "get",
    path: "/workspaces",
    tags: ["Workspace"],
    summary: "내 팀 워크스페이스 목록 (WS-02)",
    description:
        "화면: 사이드바 워크스페이스 목록. 내가 속한 팀을 참여한 순서대로 내 역할·구성원 수와 함께 준다(삭제된 팀은 빠짐). " +
        "개인 워크스페이스는 목록에 없고 프론트가 맨 위에 따로 그린다. 팀이 없으면 빈 배열.",
    security: bearerAuth,
    responses: {
        200: {
            description: "내 팀 목록",
            content: { "application/json": { schema: successResponse(listWorkspacesResponseSchema) } },
        },
        ...errorResponses("UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get("/", authenticate, workspaceController.list);

registry.registerPath({
    method: "get",
    path: "/workspaces/{workspaceId}",
    tags: ["Workspace"],
    summary: "팀 정보 조회 (WS-03)",
    description:
        "화면: 팀 화면 헤더(팀 이름 + 내 역할 배지), W03 워크스페이스 관리 · 설정 탭(팀 이름·소개, '현재 정보 다시 불러오기'). " +
        "myRole로 관리 메뉴를 보일지 정한다(설정 탭은 소유자·관리자, 소유권 이전·팀 삭제는 소유자). 팀원이 아니거나 삭제된 팀이면 404.",
    security: bearerAuth,
    request: { params: workspaceIdParamsSchema },
    responses: {
        200: { description: "팀 정보", content: { "application/json": { schema: successResponse(workspaceSchema) } } },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "WORKSPACE_NOT_FOUND"),
    },
});
router.get("/:workspaceId", authenticate, validate({ params: workspaceIdParamsSchema }), workspaceController.get);

registry.registerPath({
    method: "patch",
    path: "/workspaces/{workspaceId}",
    tags: ["Workspace"],
    summary: "팀 정보 수정 (WS-04)",
    description:
        "화면: W03 설정 탭 '팀 정보 저장'. 소유자·관리자만. 이름(1~60자)·소개(0~500자) 중 보낸 값만 바꾸고 WS-03과 같은 형식으로 돌려준다. 일반 팀원이면 403.",
    security: bearerAuth,
    request: {
        params: workspaceIdParamsSchema,
        body: { required: true, content: { "application/json": { schema: updateWorkspaceBodySchema } } },
    },
    responses: {
        200: {
            description: "수정된 팀 정보",
            content: { "application/json": { schema: successResponse(workspaceSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "FORBIDDEN", "WORKSPACE_NOT_FOUND"),
    },
});
router.patch(
    "/:workspaceId",
    authenticate,
    validate({ params: workspaceIdParamsSchema, body: updateWorkspaceBodySchema }),
    workspaceController.update,
);

registry.registerPath({
    method: "delete",
    path: "/workspaces/{workspaceId}",
    tags: ["Workspace"],
    summary: "팀 삭제 (WS-05)",
    description:
        "화면: W03 설정 탭 '소유권과 팀 종료' → 팀 삭제. 소유자만. 복구할 수 없고, 진행 중이던 AI 생성 결과도 반영하지 않는다. " +
        "삭제 뒤 프론트는 개인 워크스페이스로 이동하고 사이드바 목록(WS-02)을 다시 불러온다.",
    security: bearerAuth,
    request: { params: workspaceIdParamsSchema },
    responses: {
        200: { description: "삭제됨", content: { "application/json": { schema: successResponse(z.null()) } } },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "FORBIDDEN", "WORKSPACE_NOT_FOUND"),
    },
});
router.delete("/:workspaceId", authenticate, validate({ params: workspaceIdParamsSchema }), workspaceController.delete);

registry.registerPath({
    method: "post",
    path: "/workspaces/{workspaceId}/owner",
    tags: ["Workspace"],
    summary: "소유권 이전 (WS-06)",
    description:
        "화면: W03 설정 탭 '새 소유자' 선택 → 소유권 이전. 소유자만. 고른 구성원이 소유자가 되고 내 역할은 관리자로 바뀐다. " +
        "새 소유자 선택 목록은 구성원 목록(WS-07)에서 나를 뺀 것. 구성원이 아니면 404 MEMBER_NOT_FOUND.",
    security: bearerAuth,
    request: {
        params: workspaceIdParamsSchema,
        body: { required: true, content: { "application/json": { schema: transferOwnershipBodySchema } } },
    },
    responses: {
        200: {
            description: "이전됨",
            content: { "application/json": { schema: successResponse(transferOwnershipResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "WORKSPACE_NOT_FOUND",
            "MEMBER_NOT_FOUND",
        ),
    },
});
router.post(
    "/:workspaceId/owner",
    authenticate,
    validate({ params: workspaceIdParamsSchema, body: transferOwnershipBodySchema }),
    workspaceController.transferOwnership,
);

registry.registerPath({
    method: "get",
    path: "/workspaces/{workspaceId}/members",
    tags: ["Workspace"],
    summary: "구성원 목록 (WS-07)",
    description:
        "화면: W03 구성원 탭의 구성원 표(사용자·역할·참여일·관리), 설정 탭의 새 소유자 선택. 팀원이면 누구나. 소유자 → 관리자 → 일반 순, 같으면 참여일 순. " +
        "isMe로 '나' 표시. 관리 버튼은 내 역할(WS-03 myRole)로 정한다: 소유자는 소유자 외 전부, 관리자는 일반 팀원만 내보내기.",
    security: bearerAuth,
    request: { params: workspaceIdParamsSchema },
    responses: {
        200: {
            description: "구성원 목록",
            content: { "application/json": { schema: successResponse(listMembersResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "WORKSPACE_NOT_FOUND"),
    },
});
router.get(
    "/:workspaceId/members",
    authenticate,
    validate({ params: workspaceIdParamsSchema }),
    workspaceController.listMembers,
);

registry.registerPath({
    method: "patch",
    path: "/workspaces/{workspaceId}/members/{userId}",
    tags: ["Workspace"],
    summary: "구성원 역할 변경 (WS-08)",
    description:
        "화면: W03 구성원 표 '관리'. 소유자만. 관리자 ↔ 일반으로 바꾼다. 소유자의 역할은 소유권 이전(WS-06)으로만 바뀐다(409 OWNER_CANNOT_LEAVE).",
    security: bearerAuth,
    request: {
        params: memberParamsSchema,
        body: { required: true, content: { "application/json": { schema: updateMemberRoleBodySchema } } },
    },
    responses: {
        200: { description: "바뀐 구성원", content: { "application/json": { schema: successResponse(memberSchema) } } },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "WORKSPACE_NOT_FOUND",
            "MEMBER_NOT_FOUND",
            "OWNER_CANNOT_LEAVE",
        ),
    },
});
router.patch(
    "/:workspaceId/members/:userId",
    authenticate,
    validate({ params: memberParamsSchema, body: updateMemberRoleBodySchema }),
    workspaceController.updateMemberRole,
);

registry.registerPath({
    method: "delete",
    path: "/workspaces/{workspaceId}/members/{userId}",
    tags: ["Workspace"],
    summary: "구성원 내보내기 · 팀 나가기 (WS-09)",
    description:
        "화면: W03 구성원 표 '관리'(내보내기), 팀 나가기. userId가 나면 나가기(소유자는 소유권 이전 뒤에 가능, 409 OWNER_CANNOT_LEAVE), " +
        "다른 사람이면 내보내기(소유자는 소유자 외 전부, 관리자는 일반 팀원만, 아니면 403). 나가거나 내보내도 그 사람이 만든 팀 자료는 남는다.",
    security: bearerAuth,
    request: { params: memberParamsSchema },
    responses: {
        200: { description: "나감 / 내보냄", content: { "application/json": { schema: successResponse(z.null()) } } },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "WORKSPACE_NOT_FOUND",
            "MEMBER_NOT_FOUND",
            "OWNER_CANNOT_LEAVE",
        ),
    },
});
router.delete(
    "/:workspaceId/members/:userId",
    authenticate,
    validate({ params: memberParamsSchema }),
    workspaceController.removeMember,
);

export default router;
