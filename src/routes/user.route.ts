import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { userController } from "../controllers/user.controller.js";
import { userSchema } from "../schemas/auth.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "get",
    path: "/users/me",
    tags: ["User"],
    summary: "내 정보 조회 (USER-01)",
    description: "로그인한 회원의 정보. 계정 정보 화면(A08)의 이메일·닉네임·가입일에 쓴다.",
    security: bearerAuth,
    responses: {
        200: { description: "조회 성공", content: { "application/json": { schema: successResponse(userSchema) } } },
        ...errorResponses("UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get("/me", authenticate, userController.getMe);

export default router;
