import type { Request, Response } from "express";
import { userService } from "../services/user.service.js";
import { sendSuccess } from "../utils/response.js";
import type { ChangePasswordBody, UpdateNicknameBody } from "../schemas/user.schema.js";

export const userController = {
    async getMe(req: Request, res: Response) {
        const result = await userService.getMe(req.user.userId);
        sendSuccess(res, result);
    },

    async updateNickname(req: Request, res: Response) {
        const result = await userService.updateNickname(req.user.userId, req.body as UpdateNicknameBody);
        sendSuccess(res, result);
    },

    async changePassword(req: Request, res: Response) {
        const result = await userService.changePassword(req.user.userId, req.body as ChangePasswordBody);
        sendSuccess(res, result);
    },
};
