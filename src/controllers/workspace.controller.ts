import type { Request, Response } from "express";
import { workspaceService } from "../services/workspace.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type {
    CreateWorkspaceBody,
    MemberParams,
    TransferOwnershipBody,
    UpdateMemberRoleBody,
    UpdateWorkspaceBody,
    WorkspaceIdParams,
} from "../schemas/workspace.schema.js";

export const workspaceController = {
    async create(req: Request, res: Response) {
        const result = await workspaceService.create(req.user.userId, req.body as CreateWorkspaceBody);
        logger.info("팀 워크스페이스를 만들었습니다.", { workspaceId: result.workspaceId });
        sendSuccess(res, result, 201);
    },

    async list(req: Request, res: Response) {
        const result = await workspaceService.list(req.user.userId);
        sendSuccess(res, result);
    },

    async get(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        const result = await workspaceService.get(req.user.userId, workspaceId);
        sendSuccess(res, result);
    },

    async update(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        const result = await workspaceService.update(req.user.userId, workspaceId, req.body as UpdateWorkspaceBody);
        logger.info("팀 정보를 수정하였습니다.", { workspaceId });
        sendSuccess(res, result);
    },

    async delete(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        await workspaceService.delete(req.user.userId, workspaceId);
        logger.info("팀 워크스페이스를 삭제하였습니다.", { workspaceId });
        sendSuccess(res, null);
    },

    async transferOwnership(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        const result = await workspaceService.transferOwnership(
            req.user.userId,
            workspaceId,
            req.body as TransferOwnershipBody,
        );
        logger.info("팀 소유권을 이전하였습니다.", { workspaceId, ownerUserId: result.ownerUserId });
        sendSuccess(res, result);
    },

    async listMembers(req: Request, res: Response) {
        const { workspaceId } = req.params as unknown as WorkspaceIdParams;
        const result = await workspaceService.listMembers(req.user.userId, workspaceId);
        sendSuccess(res, result);
    },

    async updateMemberRole(req: Request, res: Response) {
        const { workspaceId, userId } = req.params as unknown as MemberParams;
        const result = await workspaceService.updateMemberRole(
            req.user.userId,
            workspaceId,
            userId,
            req.body as UpdateMemberRoleBody,
        );
        logger.info("팀 구성원의 역할을 변경하였습니다.", { workspaceId, targetUserId: userId, role: result.role });
        sendSuccess(res, result);
    },

    async removeMember(req: Request, res: Response) {
        const { workspaceId, userId } = req.params as unknown as MemberParams;
        const result = await workspaceService.removeMember(req.user.userId, workspaceId, userId);
        logger.info(result === "LEFT" ? "팀에서 나갔습니다." : "팀 구성원을 내보냈습니다.", {
            workspaceId,
            targetUserId: userId,
        });
        sendSuccess(res, null);
    },
};
