import type { Request, Response } from "express";
import { authService } from "../services/auth.service.js";
import { sendSuccess } from "../utils/response.js";
import type { LoginBody, RefreshTokenBody } from "../schemas/auth.schema.js";

export const authController = {
    async login(req: Request, res: Response) {
        const result = await authService.login(req.body as LoginBody);
        sendSuccess(res, result);
    },

    async refresh(req: Request, res: Response) {
        const result = await authService.refresh(req.body as RefreshTokenBody);
        sendSuccess(res, result);
    },

    async logout(req: Request, res: Response) {
        await authService.logout(req.user.userId, req.body as RefreshTokenBody);
        sendSuccess(res, null);
    },
};
