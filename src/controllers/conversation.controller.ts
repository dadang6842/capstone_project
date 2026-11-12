import type { Request, Response } from "express";
import { conversationService } from "../services/conversation.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type {
    ConversationIdParams,
    CreateConversationBody,
    ListConversationsQuery,
} from "../schemas/conversation.schema.js";

export const conversationController = {
    async list(req: Request, res: Response) {
        const result = await conversationService.list(req.user.userId, req.query as unknown as ListConversationsQuery);
        sendSuccess(res, result);
    },

    async get(req: Request, res: Response) {
        const { conversationId } = req.params as unknown as ConversationIdParams;
        const result = await conversationService.get(req.user.userId, conversationId);
        sendSuccess(res, result);
    },

    async delete(req: Request, res: Response) {
        const { conversationId } = req.params as unknown as ConversationIdParams;
        await conversationService.delete(req.user.userId, conversationId);
        logger.info("대화를 삭제하였습니다.", { conversationId });
        sendSuccess(res, null);
    },

    async create(req: Request, res: Response) {
        const result = await conversationService.create(req.user.userId, req.body as CreateConversationBody);
        logger.info("공유 링크를 등록하였습니다.", { conversationId: result.conversationId });
        sendSuccess(res, result, 202);
    },
};
