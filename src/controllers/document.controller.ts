import type { Request, Response } from "express";
import { documentService } from "../services/document.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type {
    CreateDocumentBody,
    DocumentIdParams,
    ListDocumentsQuery,
    ListPendingDocumentsQuery,
    ListTrashQuery,
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
        logger.info("문서를 휴지통으로 옮겼습니다.", { documentId });
        sendSuccess(res, null);
    },

    async listDrafts(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        const result = await documentService.listDrafts(req.user.userId, documentId);
        sendSuccess(res, result);
    },

    async listPending(req: Request, res: Response) {
        const result = await documentService.listPending(
            req.user.userId,
            req.query as unknown as ListPendingDocumentsQuery,
        );
        sendSuccess(res, result);
    },

    async listTrash(req: Request, res: Response) {
        const result = await documentService.listTrash(req.user.userId, req.query as unknown as ListTrashQuery);
        sendSuccess(res, result);
    },

    async restore(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        const result = await documentService.restore(req.user.userId, documentId);
        logger.info("휴지통에서 문서를 복원하였습니다.", { documentId });
        sendSuccess(res, result);
    },

    async deletePermanently(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        await documentService.deletePermanently(req.user.userId, documentId);
        logger.info("문서를 영구 삭제하였습니다.", { documentId });
        sendSuccess(res, null);
    },
};
