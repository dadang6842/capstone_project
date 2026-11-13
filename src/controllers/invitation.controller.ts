import type { Request, Response } from "express";
import { invitationService } from "../services/invitation.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { WorkspaceIdParams } from "../schemas/workspace.schema.js";
import type {
    CreateInvitationBody,
    InvitationIdParams,
    ListReceivedInvitationsQuery,
    WorkspaceInvitationParams,
} from "../schemas/invitation.schema.js";

export const invitationController = {
    async create(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        const result = await invitationService.create(req.user.userId, workspaceId, req.body as CreateInvitationBody);
        logger.info("팀 초대를 보냈습니다.", { workspaceId, invitationId: result.invitationId });
        sendSuccess(res, result, 201);
    },

    async listSent(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        const result = await invitationService.listSent(req.user.userId, workspaceId);
        sendSuccess(res, result);
    },

    async cancel(req: Request, res: Response) {
        const { workspaceId, invitationId } = req.params as unknown as WorkspaceInvitationParams;
        await invitationService.cancel(req.user.userId, workspaceId, invitationId);
        logger.info("팀 초대를 취소하였습니다.", { workspaceId, invitationId });
        sendSuccess(res, null);
    },

    async listReceived(req: Request, res: Response) {
        const result = await invitationService.listReceived(
            req.user.userId,
            req.query as unknown as ListReceivedInvitationsQuery,
        );
        sendSuccess(res, result);
    },

    async accept(req: Request, res: Response) {
        const { invitationId } = req.params as unknown as InvitationIdParams;
        const result = await invitationService.accept(req.user.userId, invitationId);
        logger.info("팀 초대를 수락하였습니다.", { invitationId, workspaceId: result.workspaceId });
        sendSuccess(res, result);
    },

    async decline(req: Request, res: Response) {
        const { invitationId } = req.params as unknown as InvitationIdParams;
        await invitationService.decline(req.user.userId, invitationId);
        logger.info("팀 초대를 거절하였습니다.", { invitationId });
        sendSuccess(res, null);
    },
};
