import { z } from "zod";

// 요청: validate 미들웨어와 스웨거 문서가 둘 다 이 스키마를 쓴다
export const loginBodySchema = z
    .object({
        email: z.email().max(100).meta({ example: "dahyun@example.com" }),
        password: z.string().min(8).max(20).meta({ example: "silo2026!" }),
    })
    .meta({ id: "LoginRequest" });

// 비밀번호·닉네임 규칙: 회원가입, 비밀번호 변경, 닉네임 수정에서 같이 쓴다
export const passwordField = z
    .string()
    .min(8)
    .max(20)
    .regex(/[A-Za-z]/, "영문을 1자 이상 포함해야 합니다.")
    .regex(/[0-9]/, "숫자를 1자 이상 포함해야 합니다.")
    .meta({ example: "silo2026!", description: "8~20자, 영문과 숫자 포함" });

// trim()으로 앞뒤 공백을 지운 뒤 길이를 검사하므로 공백만 있는 값은 min(1)에서 걸린다
export const nicknameField = z.string().trim().min(1).max(12).meta({ example: "다현", description: "1~12자" });

// 회원가입(AUTH-02) 요청
export const signupBodySchema = z
    .object({
        email: z.email().max(100).meta({ example: "dahyun@example.com" }),
        password: passwordField,
        nickname: nicknameField,
    })
    .meta({ id: "SignupRequest" });

// 응답
export const userSchema = z
    .object({
        userId: z.number().int().meta({ example: 1 }),
        email: z.string().meta({ example: "dahyun@example.com" }),
        nickname: z.string().meta({ example: "다현" }),
        role: z.enum(["USER", "ADMIN"]),
        createdAt: z.date().meta({ description: "가입 일시 (ISO 8601 UTC)" }),
        hasPassword: z.boolean().meta({
            description:
                "비밀번호가 있는 계정인지. false면 구글로만 가입한 계정이라 A08에서 비밀번호 변경을 숨기고, 탈퇴(P07)는 구글 재인증으로 받는다",
        }),
        googleLinked: z.boolean().meta({ description: "구글 계정이 연결됐는지" }),
    })
    .meta({ id: "User" });

export const loginResponseSchema = z
    .object({
        user: userSchema,
        accessToken: z.string().meta({ description: "유효기간 30분" }),
        refreshToken: z.string().meta({ description: "유효기간 14일" }),
    })
    .meta({ id: "LoginResponse" });

// 구글 로그인(AUTH-07), 구글 계정 탈퇴 취소(AUTH-08) 요청
export const googleLoginBodySchema = z
    .object({
        idToken: z.string().min(1).meta({
            description:
                "프론트의 Google 로그인 버튼(Google Identity Services)이 callback으로 준 credential 값 (구글 ID 토큰, JWT)",
            example: "eyJhbGciOiJSUzI1NiIsImtpZCI6...",
        }),
    })
    .meta({ id: "GoogleLoginRequest" });

export const googleLoginResponseSchema = loginResponseSchema
    .extend({
        isNewUser: z.boolean().meta({
            description:
                "이번 요청으로 새로 가입했으면 true. 닉네임은 구글 이름(12자까지)으로 정해지므로 필요하면 프론트가 환영·닉네임 수정 안내에 쓴다",
        }),
    })
    .meta({ id: "GoogleLoginResponse" });

// 토큰 재발급(AUTH-04), 로그아웃(AUTH-05) 요청
export const refreshTokenBodySchema = z
    .object({
        refreshToken: z.string().min(1).meta({ description: "보유 중인 Refresh Token" }),
    })
    .meta({ id: "RefreshTokenRequest" });

export const tokenResponseSchema = z
    .object({
        accessToken: z.string().meta({ description: "유효기간 30분" }),
        refreshToken: z.string().meta({ description: "새 Refresh Token (유효기간 14일). 기존 토큰은 폐기됨" }),
    })
    .meta({ id: "TokenResponse" });

export type SignupBody = z.infer<typeof signupBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type UserResponse = z.infer<typeof userSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type RefreshTokenBody = z.infer<typeof refreshTokenBodySchema>;
export type GoogleLoginBody = z.infer<typeof googleLoginBodySchema>;
export type GoogleLoginResponse = z.infer<typeof googleLoginResponseSchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
