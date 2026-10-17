import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { loginBodySchema, loginResponseSchema } from "../schemas/auth.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses } from "../docs/openapi.js";
import { AppError } from "../utils/appError.js";

const router = Router();

// 문서 등록과 라우트를 나란히 둔다. 검증과 문서가 같은 loginBodySchema를 씀
registry.registerPath({
    method: "post",
    path: "/auth/login",
    tags: ["Auth"],
    summary: "로그인 (AUTH-03)",
    request: { body: { required: true, content: { "application/json": { schema: loginBodySchema } } } },
    responses: {
        200: {
            description: "로그인 성공",
            content: { "application/json": { schema: successResponse(loginResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_CREDENTIALS", "WITHDRAWAL_PENDING"),
    },
});
// 예시 코드: 실제 로그인은 controllers/services로 옮겨 구현
router.post("/login", validate({ body: loginBodySchema }), (_req, _res) => {
    throw new AppError("INVALID_CREDENTIALS");
});

export default router;
