import type { Request, Response } from "express";
import { authService } from "../services/auth.service.js";
import { sendSuccess } from "../utils/response.js";
import type { SignupBody, LoginBody, RefreshTokenBody } from "../schemas/auth.schema.js";

export const authController = {
    async signup(req: Request, res: Response) {
        const result = await authService.signup(req.body as SignupBody);
        sendSuccess(res, result, 201);
    },

    async login(req: Request, res: Response) {
        const result = await authService.login(req.body as LoginBody);
        sendSuccess(res, result);
    },

    async cancelWithdrawal(req: Request, res: Response) {
        const result = await authService.cancelWithdrawal(req.body as LoginBody);
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
