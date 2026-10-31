import type { Request, Response } from "express";
import { draftService } from "../services/draft.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { DraftIdParams } from "../schemas/draft.schema.js";

export const draftController = {
    async get(req: Request, res: Response) {
        const { draftId } = req.params as unknown as DraftIdParams;
        const result = await draftService.get(req.user.userId, draftId);
        sendSuccess(res, result);
    },

    async retry(req: Request, res: Response) {
        const { draftId } = req.params as unknown as DraftIdParams;
        const result = await draftService.retry(req.user.userId, draftId);
        logger.info("초안 생성을 다시 요청하였습니다.", { failedDraftId: draftId, draftId: result.draftId });
        sendSuccess(res, result, 201);
    },
};
