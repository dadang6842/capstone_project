import type { Request, Response } from "express";
import { draftService } from "../services/draft.service.js";
import { sendSuccess } from "../utils/response.js";
import type { DraftIdParams } from "../schemas/draft.schema.js";

export const draftController = {
    async get(req: Request, res: Response) {
        const { draftId } = req.params as unknown as DraftIdParams;
        const result = await draftService.get(req.user.userId, draftId);
        sendSuccess(res, result);
    },
};
