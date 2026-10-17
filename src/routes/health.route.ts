import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { sendSuccess } from "../utils/response.js";

const router = Router();

router.get("/", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    sendSuccess(res, { status: "ok" });
});

export default router;
