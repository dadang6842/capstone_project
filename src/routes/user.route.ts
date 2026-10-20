import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { userController } from "../controllers/user.controller.js";
import { userSchema, tokenResponseSchema } from "../schemas/auth.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";
import { validate } from "../middlewares/validate.js";
import {
    updateNicknameBodySchema,
    changePasswordBodySchema,
    withdrawBodySchema,
    withdrawResponseSchema,
} from "../schemas/user.schema.js";

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

registry.registerPath({
    method: "patch",
    path: "/users/me",
    tags: ["User"],
    summary: "닉네임 수정 (USER-02)",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: updateNicknameBodySchema } } } },
    responses: {
        200: {
            description: "수정된 회원 정보",
            content: { "application/json": { schema: successResponse(userSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.patch("/me", authenticate, validate({ body: updateNicknameBodySchema }), userController.updateNickname);

registry.registerPath({
    method: "patch",
    path: "/users/me/password",
    tags: ["User"],
    summary: "비밀번호 변경 (USER-03)",
    description:
        "다른 기기의 로그인은 모두 끊고(refresh 토큰 전부 폐기), 지금 기기용 새 토큰을 준다. 프론트는 받은 토큰으로 바꿔 저장한다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: changePasswordBodySchema } } } },
    responses: {
        200: {
            description: "변경 성공, 새 토큰",
            content: { "application/json": { schema: successResponse(tokenResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_PASSWORD", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.patch("/me/password", authenticate, validate({ body: changePasswordBodySchema }), userController.changePassword);

registry.registerPath({
    method: "delete",
    path: "/users/me",
    tags: ["User"],
    summary: "회원 탈퇴 (USER-04)",
    description:
        "deleted_at을 채우고 모든 기기 로그인을 끊는다. 7일 안에 로그인하면 탈퇴 취소(AUTH-06) 가능. 프론트는 성공하면 토큰을 지우고 로그아웃 처리한다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: withdrawBodySchema } } } },
    responses: {
        200: {
            description: "탈퇴 요청 완료",
            content: { "application/json": { schema: successResponse(withdrawResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_PASSWORD", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.delete("/me", authenticate, validate({ body: withdrawBodySchema }), userController.withdraw);

export default router;
