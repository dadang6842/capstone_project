import { Router } from "express";
import healthRouter from "./health.route.js";
import authRouter from "./auth.route.js";
import userRouter from "./user.route.js";
import conversationRouter from "./conversation.route.js";
import documentRouter from "./document.route.js";
import draftRouter from "./draft.route.js";
import workspaceRouter from "./workspace.route.js";
import invitationRouter from "./invitation.route.js";
import versionRouter from "./version.route.js";

const router = Router();
router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/users", userRouter);
router.use("/conversations", conversationRouter);
router.use("/documents", documentRouter);
router.use("/drafts", draftRouter);
router.use("/workspaces", workspaceRouter);
// 초대는 /workspaces/{id}/invitations와 /invitations 두 경로를 쓰므로 경로 전체를 라우트 파일에 적었다
router.use(invitationRouter);
// 저장 이력도 /drafts·/documents·/versions 세 경로를 써서 같은 방식
router.use(versionRouter);

export default router;
