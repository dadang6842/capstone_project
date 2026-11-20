import express, { Router } from "express";
import { mcpAuthenticate } from "../middlewares/mcpAuthenticate.js";
import { validate } from "../middlewares/validate.js";
import { mcpController } from "../controllers/mcp.controller.js";
import { saveCaptureBodySchema } from "../schemas/mcp.schema.js";

// MCP 서버(Python) → 백엔드 저장 API. 프론트는 쓰지 않아서 스웨거에 넣지 않는다.
// 인증은 ChatGPT가 MCP 서버에 붙여 보낸 access token을 MCP 서버가 그대로 넘긴 것 (mcpAuthenticate)
const router = Router();

// 긴 대화는 발화가 수백 개라 기본 JSON 크기 제한(100kb)을 넘는다. 그래서 app.ts의 express.json()보다 먼저 연결하고 여기서 크게 받는다
router.post(
    "/captures",
    express.json({ limit: "20mb" }),
    mcpAuthenticate,
    validate({ body: saveCaptureBodySchema }),
    mcpController.saveCapture,
);

export default router;
