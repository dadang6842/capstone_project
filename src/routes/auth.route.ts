import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authController } from "../controllers/auth.controller.js";
import {
    signupBodySchema,
    loginBodySchema,
    loginResponseSchema,
    refreshTokenBodySchema,
    tokenResponseSchema,
    googleLoginBodySchema,
    googleLoginResponseSchema,
} from "../schemas/auth.schema.js";
import { z } from "zod";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/auth/signup",
    tags: ["Auth"],
    summary: "회원가입 (AUTH-02)",
    description:
        "이메일 중복 검사도 여기서 한다(별도 API 없음). 탈퇴 유예 중인 계정의 이메일도 409 EMAIL_DUPLICATED. 가입하면 바로 로그인 상태가 되도록 토큰을 함께 준다.",
    request: { body: { required: true, content: { "application/json": { schema: signupBodySchema } } } },
    responses: {
        201: {
            description: "가입 성공",
            content: { "application/json": { schema: successResponse(loginResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "EMAIL_DUPLICATED"),
    },
});
router.post("/signup", validate({ body: signupBodySchema }), authController.signup);

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

registry.registerPath({
    method: "post",
    path: "/auth/withdrawal/cancel",
    tags: ["Auth"],
    summary: "탈퇴 취소 (AUTH-06)",
    description:
        "탈퇴 유예 중 로그인해서 403 WITHDRAWAL_PENDING을 받은 사용자가 취소를 확인하면 호출한다. deleted_at을 되돌리고 로그인처럼 토큰을 준다.",
    request: { body: { required: true, content: { "application/json": { schema: loginBodySchema } } } },
    responses: {
        200: {
            description: "탈퇴 취소 + 로그인 성공",
            content: { "application/json": { schema: successResponse(loginResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_CREDENTIALS", "WITHDRAWAL_NOT_REQUESTED"),
    },
});
router.post("/withdrawal/cancel", validate({ body: loginBodySchema }), authController.cancelWithdrawal);

registry.registerPath({
    method: "post",
    path: "/auth/google",
    tags: ["Auth"],
    summary: "구글 로그인 (AUTH-07)",
    description:
        "화면: A01 'Google로 로그인' 버튼 (설계서 추가 기능) → A03. 프론트가 Google 버튼 callback으로 받은 credential을 idToken으로 보낸다. 처음이면 가입(isNewUser true), 같은 이메일로 가입한 계정이 있으면 구글을 자동 연결하고 로그인한다. 탈퇴 유예 중이면 403 WITHDRAWAL_PENDING → AUTH-08.",
    request: { body: { required: true, content: { "application/json": { schema: googleLoginBodySchema } } } },
    responses: {
        200: {
            description: "로그인(또는 가입) 성공",
            content: { "application/json": { schema: successResponse(googleLoginResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "INVALID_GOOGLE_TOKEN",
            "GOOGLE_EMAIL_NOT_VERIFIED",
            "WITHDRAWAL_PENDING",
            "GOOGLE_ACCOUNT_MISMATCH",
            "GOOGLE_LOGIN_UNAVAILABLE",
        ),
    },
});
router.post("/google", validate({ body: googleLoginBodySchema }), authController.googleLogin);

registry.registerPath({
    method: "post",
    path: "/auth/google/withdrawal/cancel",
    tags: ["Auth"],
    summary: "구글 계정 탈퇴 취소 (AUTH-08)",
    description:
        "화면: A01 탈퇴 처리 중 안내 → A03. AUTH-07에서 403 WITHDRAWAL_PENDING을 받고 사용자가 취소를 확인하면, 같은 idToken으로 호출한다(구글 ID 토큰은 1시간 유효). AUTH-06의 구글 버전.",
    request: { body: { required: true, content: { "application/json": { schema: googleLoginBodySchema } } } },
    responses: {
        200: {
            description: "탈퇴 취소 + 로그인 성공",
            content: { "application/json": { schema: successResponse(loginResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "INVALID_GOOGLE_TOKEN",
            "GOOGLE_EMAIL_NOT_VERIFIED",
            "WITHDRAWAL_NOT_REQUESTED",
            "GOOGLE_ACCOUNT_MISMATCH",
            "GOOGLE_LOGIN_UNAVAILABLE",
        ),
    },
});
router.post(
    "/google/withdrawal/cancel",
    validate({ body: googleLoginBodySchema }),
    authController.cancelWithdrawalWithGoogle,
);

registry.registerPath({
    method: "post",
    path: "/auth/refresh",
    tags: ["Auth"],
    summary: "토큰 재발급 (AUTH-04)",
    description:
        "Access Token이 만료(401 TOKEN_EXPIRED)되면 Refresh Token으로 새 토큰 쌍을 받는다. 기존 Refresh Token은 폐기된다(토큰 회전). INVALID_TOKEN이면 다시 로그인해야 한다.",
    request: { body: { required: true, content: { "application/json": { schema: refreshTokenBodySchema } } } },
    responses: {
        200: {
            description: "재발급 성공",
            content: { "application/json": { schema: successResponse(tokenResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_TOKEN"),
    },
});
router.post("/refresh", validate({ body: refreshTokenBodySchema }), authController.refresh);

registry.registerPath({
    method: "post",
    path: "/auth/logout",
    tags: ["Auth"],
    summary: "로그아웃 (AUTH-05)",
    description:
        "현재 기기의 Refresh Token을 폐기한다. Access Token은 프론트가 삭제한다. 다른 기기의 로그인은 유지된다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: refreshTokenBodySchema } } } },
    responses: {
        200: { description: "로그아웃 성공", content: { "application/json": { schema: successResponse(z.null()) } } },
        ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.post("/logout", authenticate, validate({ body: refreshTokenBodySchema }), authController.logout);

export default router;
