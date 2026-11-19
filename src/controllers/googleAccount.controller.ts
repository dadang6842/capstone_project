import type { Request, Response } from "express";
import { googleAccountService } from "../services/googleAccount.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { GoogleLinkBody, GoogleLinkChallengeBody, GoogleUnlinkBody } from "../schemas/googleAccount.schema.js";

export const googleAccountController = {
    async getConnection(req: Request, res: Response) {
        const result = await googleAccountService.getConnection(req.user.userId);
        sendSuccess(res, result);
    },

    async startLink(req: Request, res: Response) {
        const result = await googleAccountService.startLink(req.user.userId, req.body as GoogleLinkChallengeBody);
        logger.info("구글 계정 연결을 시작하였습니다.");
        sendSuccess(res, result);
    },

    async completeLink(req: Request, res: Response) {
        const result = await googleAccountService.completeLink(req.user.userId, req.body as GoogleLinkBody);
        logger.info("구글 계정을 연결하였습니다.");
        sendSuccess(res, result);
    },

    async unlink(req: Request, res: Response) {
        const result = await googleAccountService.unlink(req.user.userId, req.body as GoogleUnlinkBody);
        logger.info("구글 계정 연결을 해제하였습니다.");
        sendSuccess(res, result);
    },
};
