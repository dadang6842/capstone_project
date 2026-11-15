import type { Request, Response } from "express";
import { generationService } from "../services/generation.service.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import type { GenerationIdParams } from "../schemas/generation.schema.js";

export const generationController = {
  async get(req: Request, res: Response) {
    const { generationId } = req.params as unknown as GenerationIdParams;
    const result = await generationService.get(req.user.userId, generationId);
    sendSuccess(res, result);
  },

  async retry(req: Request, res: Response) {
    const { generationId } = req.params as unknown as GenerationIdParams;
    const result = await generationService.retry(req.user.userId, generationId);
    logger.info("지식 문서 생성을 다시 요청하였습니다.", { failedGenerationId: generationId, generationId: result.generationId });
    sendSuccess(res, result, 202);
  },
};
