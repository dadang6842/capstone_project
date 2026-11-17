import type { Request, Response } from "express";
import { relationService } from "../services/relation.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { RelationGraphQuery } from "../schemas/relation.schema.js";

export const relationController = {
    async getGraph(req: Request, res: Response) {
        const query = req.query as unknown as RelationGraphQuery;
        const result = await relationService.getGraph(req.user.userId, query);
        logger.info("문서 관계도를 조회하였습니다.", {
            workspaceId: query.workspaceId,
            documents: result.counts.documents,
            edges: result.counts.edges,
        });
        sendSuccess(res, result);
    },
};
