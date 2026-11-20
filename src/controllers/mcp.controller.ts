import type { RequestHandler } from "express";
import { mcpService } from "../services/mcp.service.js";
import { sendSuccess } from "../utils/response.js";
import type { SaveCaptureBody } from "../schemas/mcp.schema.js";

export const mcpController = {
    saveCapture: (async (req, res) => {
        const result = await mcpService.saveCapture(res.locals.userId as number, req.body as SaveCaptureBody);
        sendSuccess(res, result, 201);
    }) satisfies RequestHandler,
};
