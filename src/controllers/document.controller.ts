import type { Request, Response } from "express";
import { documentService } from "../services/document.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { CreateDocumentBody } from "../schemas/document.schema.js";

export const documentController = {
    async create(req: Request, res: Response) {
        const result = await documentService.create(req.user.userId, req.body as CreateDocumentBody);
        logger.info("문서 생성을 요청하였습니다.", { documentId: result.documentId, draftId: result.draftId });
        sendSuccess(res, result, 201);
    },
};
