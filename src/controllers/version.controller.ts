import type { Request, Response } from "express";
import { versionService } from "../services/version.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { DraftIdParams } from "../schemas/draft.schema.js";
import type { DocumentIdParams } from "../schemas/document.schema.js";
import type { VersionIdParams } from "../schemas/version.schema.js";

export const versionController = {
    async listByDraft(req: Request, res: Response) {
        const { draftId } = req.params as unknown as DraftIdParams;
        const result = await versionService.listByDraft(req.user.userId, draftId);
        sendSuccess(res, result);
    },

    async listByDocument(req: Request, res: Response) {
        const { documentId } = req.params as unknown as DocumentIdParams;
        const result = await versionService.listByDocument(req.user.userId, documentId);
        sendSuccess(res, result);
    },

    async get(req: Request, res: Response) {
        const { versionId } = req.params as unknown as VersionIdParams;
        const result = await versionService.get(req.user.userId, versionId);
        sendSuccess(res, result);
    },

    async restore(req: Request, res: Response) {
        const { versionId } = req.params as unknown as VersionIdParams;
        const result = await versionService.restore(req.user.userId, versionId);
        logger.info("저장 이력 버전으로 복원하였습니다.", {
            restoredFromVersionId: versionId,
            versionId: result.versionId,
            documentId: result.documentId,
        });
        sendSuccess(res, result);
    },
};
