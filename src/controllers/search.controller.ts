import type { Request, Response } from "express";
import { searchService } from "../services/search.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { ContinueSearchBody, SearchIdParams, SearchPageQuery, StartSearchBody } from "../schemas/search.schema.js";

export const searchController = {
    async start(req: Request, res: Response) {
        const body = req.body as StartSearchBody;
        const result = await searchService.start(req.user.userId, body);
        // 검색어는 개인 기록일 수 있어서 로그에 남기지 않는다
        logger.info("AI 검색을 시작하였습니다.", {
            workspaceId: body.workspaceId,
            status: result.status,
            knownMatches: result.knownMatches,
        });
        sendSuccess(res, result);
    },

    async continue(req: Request, res: Response) {
        const { searchId } = req.params as unknown as SearchIdParams;
        const body = req.body as ContinueSearchBody;
        const result = await searchService.continue(req.user.userId, searchId, body);
        logger.info("AI 검색을 이어서 진행하였습니다.", {
            workspaceId: body.workspaceId,
            status: result.status,
            knownMatches: result.knownMatches,
        });
        sendSuccess(res, result);
    },

    async page(req: Request, res: Response) {
        const { searchId } = req.params as unknown as SearchIdParams;
        const result = await searchService.page(req.user.userId, searchId, req.query as unknown as SearchPageQuery);
        sendSuccess(res, result);
    },
};
