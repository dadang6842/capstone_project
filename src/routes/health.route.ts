import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { sendSuccess } from "../utils/response.js";
import { registry } from "../docs/openapi.js";
import { successResponse } from "../schemas/common.schema.js";

const router = Router();

registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["Health"],
    summary: "서버·DB 상태 확인",
    responses: {
        200: {
            description: "정상",
            content: { "application/json": { schema: successResponse(z.object({ status: z.literal("ok") })) } },
        },
    },
});
router.get("/", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    sendSuccess(res, { status: "ok" });
});

export default router;
