import express, { Router } from "express";
import { oauthController } from "../controllers/oauth.controller.js";

// ChatGPT 커넥터(MCP) 연결용 OAuth 인가 서버.
// 응답이 공통 응답 형식이 아니라 OAuth 표준 형식이어서 /api/v1 밖(도메인 루트)에 두고, 스웨거에도 넣지 않는다.
// Nginx에서 /oauth/와 /.well-known/oauth-authorization-server를 이 서버(3000)로 넘겨야 한다.
const router = Router();

// 로그인 폼과 토큰 요청은 application/x-www-form-urlencoded로 온다.
// router.use로 걸면 이 라우터를 지나가는 모든 요청에 붙어서, 필요한 경로에만 건다
const form = express.urlencoded({ extended: false, limit: "16kb" });

// issuer가 "https://ai-archive.shop/"(끝에 /)라 클라이언트에 따라 끝에 /를 붙여 부를 수도 있다 (Express 5는 둘 다 받음)
router.get("/.well-known/oauth-authorization-server", oauthController.metadata);
router.get("/oauth/authorize", oauthController.showLogin);
router.post("/oauth/authorize", form, oauthController.login);
// 구글로 로그인 (ID 토큰이 1~2KB라 폼 크기 제한 16kb 안에 들어감)
router.post("/oauth/authorize/google", form, oauthController.loginWithGoogle);
router.post("/oauth/token", form, oauthController.token);

export default router;
