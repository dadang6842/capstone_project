import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { invitationController } from "../controllers/invitation.controller.js";
import { workspaceIdParamsSchema } from "../schemas/workspace.schema.js";
import {
    acceptInvitationResponseSchema,
    createInvitationBodySchema,
    invitationIdParamsSchema,
    listReceivedInvitationsQuerySchema,
    listReceivedInvitationsResponseSchema,
    listSentInvitationsResponseSchema,
    sentInvitationSchema,
    workspaceInvitationParamsSchema,
} from "../schemas/invitation.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

// 팀 쪽 초대(/workspaces/{id}/invitations)와 받은 초대(/invitations)를 한 파일에 둔다. routes/index.ts에서 "/"에 붙인다
const router = Router();

registry.registerPath({
    method: "post",
    path: "/workspaces/{workspaceId}/invitations",
    tags: ["Invitation"],
    summary: "팀 초대 보내기 (INV-01)",
    description:
        "화면: W03 구성원 탭 '일반 팀원 초대' → 초대 보내기. 소유자·관리자만. 가입한 회원의 이메일로만 초대하고, 항상 일반 팀원으로 들어온다. 이메일은 보내지 않으며 받은 사람은 '받은 초대'(INV-04)에서 확인한다. " +
        "이미 팀원이면 409 ALREADY_MEMBER, 대기 중인 초대가 있으면 409 INVITATION_ALREADY_PENDING.",
    security: bearerAuth,
    request: {
        params: workspaceIdParamsSchema,
        body: { required: true, content: { "application/json": { schema: createInvitationBodySchema } } },
    },
    responses: {
        201: {
            description: "보낸 초대",
            content: { "application/json": { schema: successResponse(sentInvitationSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "WORKSPACE_NOT_FOUND",
            "INVITEE_NOT_FOUND",
            "ALREADY_MEMBER",
            "INVITATION_ALREADY_PENDING",
        ),
    },
});
router.post(
    "/workspaces/:workspaceId/invitations",
    authenticate,
    validate({ params: workspaceIdParamsSchema, body: createInvitationBodySchema }),
    invitationController.create,
);

registry.registerPath({
    method: "get",
    path: "/workspaces/{workspaceId}/invitations",
    tags: ["Invitation"],
    summary: "팀의 대기 중인 초대 (INV-02)",
    description:
        "화면: W03 구성원 탭 '대기 중인 초대'. 소유자·관리자만. 응답을 기다리는 초대만 최근 보낸 순으로 준다(없으면 빈 배열 → '대기 중인 초대가 없어요').",
    security: bearerAuth,
    request: { params: workspaceIdParamsSchema },
    responses: {
        200: {
            description: "대기 중인 초대",
            content: { "application/json": { schema: successResponse(listSentInvitationsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED", "FORBIDDEN", "WORKSPACE_NOT_FOUND"),
    },
});
router.get(
    "/workspaces/:workspaceId/invitations",
    authenticate,
    validate({ params: workspaceIdParamsSchema }),
    invitationController.listSent,
);

registry.registerPath({
    method: "delete",
    path: "/workspaces/{workspaceId}/invitations/{invitationId}",
    tags: ["Invitation"],
    summary: "팀 초대 취소 (INV-03)",
    description:
        "화면: W03 대기 중인 초대 '초대 취소'. 소유자·관리자만. 받은 사람이 이미 수락·거절했으면 409 INVITATION_NOT_PENDING.",
    security: bearerAuth,
    request: { params: workspaceInvitationParamsSchema },
    responses: {
        200: { description: "취소됨", content: { "application/json": { schema: successResponse(z.null()) } } },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FORBIDDEN",
            "WORKSPACE_NOT_FOUND",
            "INVITATION_NOT_FOUND",
            "INVITATION_NOT_PENDING",
        ),
    },
});
router.delete(
    "/workspaces/:workspaceId/invitations/:invitationId",
    authenticate,
    validate({ params: workspaceInvitationParamsSchema }),
    invitationController.cancel,
);

registry.registerPath({
    method: "get",
    path: "/invitations",
    tags: ["Invitation"],
    summary: "받은 초대 목록 (INV-04)",
    description:
        "화면: 헤더 '받은 초대'(배지 개수), 프로필 메뉴 '전체 초대 내역'. status=PENDING이면 응답할 수 있는 초대만, 생략하면 전체 내역을 최근 받은 순으로 준다. 삭제된 팀의 초대는 빠진다. " +
        "수락은 INV-05, 거절은 INV-06.",
    security: bearerAuth,
    request: { query: listReceivedInvitationsQuerySchema },
    responses: {
        200: {
            description: "받은 초대",
            content: { "application/json": { schema: successResponse(listReceivedInvitationsResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get(
    "/invitations",
    authenticate,
    validate({ query: listReceivedInvitationsQuerySchema }),
    invitationController.listReceived,
);

registry.registerPath({
    method: "post",
    path: "/invitations/{invitationId}/accept",
    tags: ["Invitation"],
    summary: "초대 수락 (INV-05)",
    description:
        "화면: 받은 초대 '수락'. 일반 팀원으로 들어가고 팀의 기존 자료를 바로 볼 수 있다. 프론트는 받은 workspaceId로 그 팀 화면으로 이동하고 사이드바(WS-02)를 다시 불러온다. " +
        "이미 처리된 초대면 409 INVITATION_NOT_PENDING.",
    security: bearerAuth,
    request: { params: invitationIdParamsSchema },
    responses: {
        200: {
            description: "참여한 팀",
            content: { "application/json": { schema: successResponse(acceptInvitationResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "INVITATION_NOT_FOUND",
            "INVITATION_NOT_PENDING",
        ),
    },
});
router.post(
    "/invitations/:invitationId/accept",
    authenticate,
    validate({ params: invitationIdParamsSchema }),
    invitationController.accept,
);

registry.registerPath({
    method: "post",
    path: "/invitations/{invitationId}/decline",
    tags: ["Invitation"],
    summary: "초대 거절 (INV-06)",
    description:
        "화면: 받은 초대 '거절'. 거절한 뒤에도 팀에서 다시 초대할 수 있다. 이미 처리된 초대면 409 INVITATION_NOT_PENDING.",
    security: bearerAuth,
    request: { params: invitationIdParamsSchema },
    responses: {
        200: { description: "거절됨", content: { "application/json": { schema: successResponse(z.null()) } } },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "INVITATION_NOT_FOUND",
            "INVITATION_NOT_PENDING",
        ),
    },
});
router.post(
    "/invitations/:invitationId/decline",
    authenticate,
    validate({ params: invitationIdParamsSchema }),
    invitationController.decline,
);

export default router;
