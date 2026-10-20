import type { Request, Response } from "express";
import { userService } from "../services/user.service.js";
import { sendSuccess } from "../utils/response.js";

export const userController = {
    async getMe(req: Request, res: Response) {
        const result = await userService.getMe(req.user.userId);
        sendSuccess(res, result);
    },
};
