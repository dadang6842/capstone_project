import type { Request, Response } from "express";
import { draftService } from "../services/draft.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { DraftIdParams, UpdateDraftBody } from "../schemas/draft.schema.js";

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

    async accept(req: Request, res: Response) {
        const { draftId } = req.params as unknown as DraftIdParams;
        const result = await draftService.accept(req.user.userId, draftId);
        logger.info("초안을 최종 채택하였습니다.", { documentId: result.documentId, draftId });
        sendSuccess(res, result);
    },

    async update(req: Request, res: Response) {
        const { draftId } = req.params as unknown as DraftIdParams;
        const result = await draftService.update(req.user.userId, draftId, req.body as UpdateDraftBody);
        logger.info("초안을 직접 수정하였습니다.", { draftId });
        sendSuccess(res, result);
    },
};
