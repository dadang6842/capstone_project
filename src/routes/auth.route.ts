import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { authController } from "../controllers/auth.controller.js";
import { loginBodySchema, loginResponseSchema } from "../schemas/auth.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/auth/login",
    tags: ["Auth"],
    summary: "로그인 (AUTH-03)",
    description:
        "탈퇴 유예 중이면 403 WITHDRAWAL_PENDING과 error.details.withdrawalRequestedAt(탈퇴 요청 일시)을 준다.",
    request: { body: { required: true, content: { "application/json": { schema: loginBodySchema } } } },
    responses: {
        200: {
            description: "로그인 성공",
            content: { "application/json": { schema: successResponse(loginResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_CREDENTIALS", "WITHDRAWAL_PENDING"),
    },
});
router.post("/login", validate({ body: loginBodySchema }), authController.login);

export default router;
