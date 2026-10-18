import { z } from "zod";

// 요청: validate 미들웨어와 스웨거 문서가 둘 다 이 스키마를 쓴다
export const loginBodySchema = z
    .object({
        email: z.email().max(100).meta({ example: "dahyun@example.com" }),
        password: z.string().min(8).max(20).meta({ example: "silo2026!" }),
    })
    .meta({ id: "LoginRequest" });

// 응답
export const userSchema = z
    .object({
        userId: z.number().int().meta({ example: 1 }),
        email: z.string().meta({ example: "dahyun@example.com" }),
        nickname: z.string().meta({ example: "다현" }),
        role: z.enum(["USER", "ADMIN"]),
        createdAt: z.date().meta({ description: "가입 일시 (ISO 8601 UTC)" }),
    })
    .meta({ id: "User" });

export const loginResponseSchema = z
    .object({
        user: userSchema,
        accessToken: z.string().meta({ description: "유효기간 30분" }),
        refreshToken: z.string().meta({ description: "유효기간 14일" }),
    })
    .meta({ id: "LoginResponse" });

export type LoginBody = z.infer<typeof loginBodySchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
