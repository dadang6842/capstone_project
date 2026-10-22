import type { Request, Response } from "express";
import { userService } from "../services/user.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { ChangePasswordBody, UpdateNicknameBody, WithdrawBody } from "../schemas/user.schema.js";

export const userController = {
    async getMe(req: Request, res: Response) {
        const result = await userService.getMe(req.user.userId);
        sendSuccess(res, result);
    },

    async updateNickname(req: Request, res: Response) {
        const result = await userService.updateNickname(req.user.userId, req.body as UpdateNicknameBody);
        logger.info("닉네임을 변경하였습니다.");
        sendSuccess(res, result);
    },

    async changePassword(req: Request, res: Response) {
        const result = await userService.changePassword(req.user.userId, req.body as ChangePasswordBody);
        logger.info("비밀번호를 변경하였습니다.");
        sendSuccess(res, result);
    },

    async withdraw(req: Request, res: Response) {
        const result = await userService.withdraw(req.user.userId, req.body as WithdrawBody);
        logger.info("회원 탈퇴를 요청하였습니다.");
        sendSuccess(res, result);
    },
};
