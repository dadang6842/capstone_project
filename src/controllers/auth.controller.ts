import type { Request, Response } from "express";
import { authService } from "../services/auth.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { SignupBody, LoginBody, RefreshTokenBody } from "../schemas/auth.schema.js";

export const authController = {
    async signup(req: Request, res: Response) {
        const result = await authService.signup(req.body as SignupBody);
        logger.info("회원가입에 성공하였습니다.", { userId: result.user.userId });
        sendSuccess(res, result, 201);
    },

    async login(req: Request, res: Response) {
        const result = await authService.login(req.body as LoginBody);
        logger.info("로그인에 성공하였습니다.", { userId: result.user.userId });
        sendSuccess(res, result);
    },

    async cancelWithdrawal(req: Request, res: Response) {
        const result = await authService.cancelWithdrawal(req.body as LoginBody);
        logger.info("회원 탈퇴를 취소하였습니다.", { userId: result.user.userId });
        sendSuccess(res, result);
    },

    async refresh(req: Request, res: Response) {
        const result = await authService.refresh(req.body as RefreshTokenBody);
        logger.info("토큰을 재발급하였습니다.");
        sendSuccess(res, result);
    },

    async logout(req: Request, res: Response) {
        await authService.logout(req.user.userId, req.body as RefreshTokenBody);
        logger.info("로그아웃하였습니다.");
        sendSuccess(res, null);
    },
};
