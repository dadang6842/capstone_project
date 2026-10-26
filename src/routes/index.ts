import { Router } from "express";
import healthRouter from "./health.route.js";
import authRouter from "./auth.route.js";
import userRouter from "./user.route.js";
import conversationRouter from "./conversation.route.js";
import documentRouter from "./document.route.js";

const router = Router();
router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/conversations", conversationRouter);
router.use("/documents", documentRouter);

export default router;
