import type { Request, Response } from "express";
import { documentService } from "../services/document.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type {
    CreateDocumentBody,
    DocumentIdParams,
    ListDocumentsQuery,
    UpdateDocumentBody,
} from "../schemas/document.schema.js";

export const documentController = {
    async create(req: Request, res: Response) {
        const result = await documentService.create(req.user.userId, req.body as CreateDocumentBody);
        logger.info("문서 생성을 요청하였습니다.", { documentId: result.documentId, draftId: result.draftId });
        sendSuccess(res, result, 201);
    },

    async list(req: Request, res: Response) {
        const result = await documentService.list(req.user.userId, req.query as unknown as ListDocumentsQuery);
        sendSuccess(res, result);
    },

    async get(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        const result = await documentService.get(req.user.userId, documentId);
        sendSuccess(res, result);
    },

    async update(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        const result = await documentService.update(req.user.userId, documentId, req.body as UpdateDocumentBody);
        logger.info("지식 문서를 수정하였습니다.", { documentId });
        sendSuccess(res, result);
    },

    async delete(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        await documentService.delete(req.user.userId, documentId);
        logger.info("지식 문서를 삭제하였습니다.", { documentId });
        sendSuccess(res, null);
    },

    async listDrafts(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        const result = await documentService.listDrafts(req.user.userId, documentId);
        sendSuccess(res, result);
    },

    async listPending(req: Request, res: Response) {
        const result = await documentService.listPending(req.user.userId);
        sendSuccess(res, result);
    },
};
