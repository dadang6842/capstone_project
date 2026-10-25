import type { Request, Response } from "express";
import { conversationService } from "../services/conversation.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { ListConversationsQuery } from "../schemas/conversation.schema.js";

export const conversationController = {
    async list(req: Request, res: Response) {
        const result = await conversationService.list(req.user.userId, req.query as unknown as ListConversationsQuery);
        sendSuccess(res, result);
    },

    async upload(req: Request, res: Response) {
        // upload 미들웨어가 저장할 파일이 1개 이상인지 확인했다
        const files = req.files as Express.Multer.File[];
        const result = await conversationService.upload(req.user.userId, files, req.failedFiles);
        const failedText = result.failed.length ? `, ${result.failed.length}개 실패` : "";
        logger.info(`대화 파일 ${result.conversations.length}개를 업로드하였습니다${failedText}.`);
        sendSuccess(res, result, 201);
    },
};
