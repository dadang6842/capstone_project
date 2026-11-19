import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { userController } from "../controllers/user.controller.js";
import { userSchema, tokenResponseSchema } from "../schemas/auth.schema.js";
import {
    updateNicknameBodySchema,
    changePasswordBodySchema,
    withdrawBodySchema,
    withdrawResponseSchema,
} from "../schemas/user.schema.js";
import {
    googleConnectionSchema,
    googleLinkChallengeBodySchema,
    googleLinkChallengeSchema,
    googleLinkBodySchema,
    googleUnlinkBodySchema,
} from "../schemas/googleAccount.schema.js";
import { googleAccountController } from "../controllers/googleAccount.controller.js";
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
        "화면: A08 → P06. 다른 기기의 로그인은 모두 끊고(refresh 토큰 전부 폐기), 지금 기기용 새 토큰을 준다. 구글로만 가입한 계정(hasPassword false)은 409 PASSWORD_NOT_SET이라 프론트는 메뉴를 숨긴다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: changePasswordBodySchema } } } },
    responses: {
        200: {
            description: "변경 성공, 새 토큰",
            content: { "application/json": { schema: successResponse(tokenResponseSchema) } },
        },
        ...errorResponses("VALIDATION_ERROR", "INVALID_PASSWORD", "PASSWORD_NOT_SET", "UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.patch("/me/password", authenticate, validate({ body: changePasswordBodySchema }), userController.changePassword);

registry.registerPath({
    method: "delete",
    path: "/users/me",
    tags: ["User"],
    summary: "회원 탈퇴 (USER-04)",
    description:
        "화면: A08 → P07 → A01. deleted_at을 채우고 모든 기기 로그인을 끊는다. 본인 확인은 password, 구글로만 가입한 계정(hasPassword false)은 구글 버튼으로 다시 받은 googleIdToken. 7일 안에 로그인하면 AUTH-06·AUTH-08로 취소 가능.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: withdrawBodySchema } } } },
    responses: {
        200: {
            description: "탈퇴 요청 완료",
            content: { "application/json": { schema: successResponse(withdrawResponseSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "INVALID_PASSWORD",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "INVALID_GOOGLE_TOKEN",
            "PASSWORD_NOT_SET",
            "GOOGLE_ACCOUNT_MISMATCH",
            "GOOGLE_LOGIN_UNAVAILABLE",
        ),
    },
});
router.delete("/me", authenticate, validate({ body: withdrawBodySchema }), userController.withdraw);

// 구글 계정 연동·해제 (2026-11-19). 계정 정보 A08의 구글 영역 (설계서 추가 기능, 프론트 v1.1.9 화면)
registry.registerPath({
    method: "get",
    path: "/users/me/google",
    tags: ["User"],
    summary: "구글 연결 상태 조회 (USER-05)",
    description:
        "화면: A08 계정 정보의 구글 영역. 연결된 구글 계정의 이메일·이름·연결일과 해제 가능 여부를 준다. version은 해제(USER-08)의 expectedVersion으로 쓴다.",
    security: bearerAuth,
    responses: {
        200: {
            description: "연결 상태",
            content: { "application/json": { schema: successResponse(googleConnectionSchema) } },
        },
        ...errorResponses("UNAUTHORIZED", "TOKEN_EXPIRED"),
    },
});
router.get("/me/google", authenticate, googleAccountController.getConnection);

registry.registerPath({
    method: "post",
    path: "/users/me/google/link-challenge",
    tags: ["User"],
    summary: "구글 연결 시작 (USER-06)",
    description:
        "화면: A08 '구글 연결' → 비밀번호 확인 팝업 → 구글 계정 선택. 비밀번호를 확인하고 2분짜리 연결 시도(challengeId·clientId·nonce)를 준다. 프론트는 clientId·nonce로 구글 버튼을 띄우고, 고른 계정의 credential을 USER-07로 보낸다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: googleLinkChallengeBodySchema } } } },
    responses: {
        200: {
            description: "연결 시도",
            content: { "application/json": { schema: successResponse(googleLinkChallengeSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "INVALID_PASSWORD",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "GOOGLE_ACCOUNT_ALREADY_LINKED",
            "PASSWORD_NOT_SET",
            "GOOGLE_LOGIN_UNAVAILABLE",
        ),
    },
});
router.post(
    "/me/google/link-challenge",
    authenticate,
    validate({ body: googleLinkChallengeBodySchema }),
    googleAccountController.startLink,
);

registry.registerPath({
    method: "post",
    path: "/users/me/google/link",
    tags: ["User"],
    summary: "구글 연결 완료 (USER-07)",
    description:
        "화면: A08 구글 계정 선택 → '연결됨'. 연결 시도와 구글 ID 토큰(nonce 포함)을 확인하고 이 계정에 구글을 연결한다. 이후 이 구글 계정으로 AUTH-07 로그인이 된다. 같은 요청을 다시 보내도 중복 연결되지 않는다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: googleLinkBodySchema } } } },
    responses: {
        200: {
            description: "연결된 상태",
            content: { "application/json": { schema: successResponse(googleConnectionSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "GOOGLE_AUTH_EXPIRED",
            "INVALID_GOOGLE_TOKEN",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "GOOGLE_EMAIL_NOT_VERIFIED",
            "GOOGLE_ACCOUNT_ALREADY_LINKED",
            "GOOGLE_ACCOUNT_IN_USE",
            "GOOGLE_LINK_CHANGED",
            "GOOGLE_LOGIN_UNAVAILABLE",
        ),
    },
});
router.post(
    "/me/google/link",
    authenticate,
    validate({ body: googleLinkBodySchema }),
    googleAccountController.completeLink,
);

registry.registerPath({
    method: "delete",
    path: "/users/me/google",
    tags: ["User"],
    summary: "구글 연결 해제 (USER-08)",
    description:
        "화면: A08 '연결 해제' → 비밀번호 확인 팝업. 비밀번호와 화면의 version을 확인하고 연결을 끊는다. 구글로만 가입한 계정은 409 GOOGLE_LAST_LOGIN_METHOD. 로그인 중인 기기는 그대로 유지된다.",
    security: bearerAuth,
    request: { body: { required: true, content: { "application/json": { schema: googleUnlinkBodySchema } } } },
    responses: {
        200: {
            description: "해제된 상태",
            content: { "application/json": { schema: successResponse(googleConnectionSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "INVALID_PASSWORD",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "GOOGLE_LAST_LOGIN_METHOD",
            "GOOGLE_LINK_CHANGED",
        ),
    },
});
router.delete("/me/google", authenticate, validate({ body: googleUnlinkBodySchema }), googleAccountController.unlink);

export default router;
