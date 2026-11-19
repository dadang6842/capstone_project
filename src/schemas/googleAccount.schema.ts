import { z } from "zod";

// 구글 계정 연동·해제 (2026-11-19, 계정 정보 A08). 프론트 v1.1.9 GOOGLE-ACCOUNT-API.md 제안 형식에 맞춤

// 연결 상태 (USER-05·07·08 응답)
export const googleConnectionSchema = z
    .object({
        version: z
            .number()
            .int()
            .meta({
                example: 1,
                description: "연결 상태 버전. 연결·해제할 때마다 +1. 해제 요청의 expectedVersion으로 그대로 보냄",
            }),
        account: z
            .object({
                email: z.string().meta({ example: "dahyun@gmail.com", description: "연결한 구글 계정 이메일" }),
                name: z.string().nullable().meta({ example: "강다현", description: "구글 계정 이름 (없으면 null)" }),
                linkedAt: z.date().meta({ description: "연결 일시" }),
            })
            .nullable()
            .meta({ description: "연결 안 됐으면 null" }),
        canUnlink: z.boolean().meta({ description: "해제 가능 여부. 미연결이면 false" }),
        unlinkBlockedReason: z
            .enum(["LAST_LOGIN_METHOD"])
            .nullable()
            .meta({ description: "해제할 수 없는 이유. 구글로만 가입해 비밀번호가 없으면 LAST_LOGIN_METHOD" }),
    })
    .meta({ id: "GoogleConnection" });

// 연결 시작 (USER-06)
export const googleLinkChallengeBodySchema = z
    .object({ password: z.string().min(1).meta({ description: "현재 비밀번호 확인" }) })
    .meta({ id: "GoogleLinkChallengeRequest" });

export const googleLinkChallengeSchema = z
    .object({
        challengeId: z.string().meta({ description: "연결 시도 식별값. 연결 완료(USER-07)에 그대로 보냄" }),
        clientId: z
            .string()
            .meta({ example: "xxxx.apps.googleusercontent.com", description: "구글 버튼 initialize의 client_id" }),
        nonce: z.string().meta({ description: "구글 버튼 initialize의 nonce로 넘김 (일회용)" }),
        expiresAt: z.date().meta({ description: "이 시각(2분 뒤)까지 연결 완료를 보내야 함" }),
    })
    .meta({ id: "GoogleLinkChallenge" });

// 연결 완료 (USER-07)
export const googleLinkBodySchema = z
    .object({
        challengeId: z.string().min(1).meta({ description: "USER-06에서 받은 값" }),
        credential: z.string().min(1).meta({ description: "구글 버튼 callback의 credential (구글 ID 토큰)" }),
    })
    .meta({ id: "GoogleLinkRequest" });

// 연결 해제 (USER-08)
export const googleUnlinkBodySchema = z
    .object({
        password: z.string().min(1).meta({ description: "현재 비밀번호 확인" }),
        expectedVersion: z.number().int().min(0).meta({ example: 1, description: "화면에 보이는 연결 상태의 version" }),
    })
    .meta({ id: "GoogleUnlinkRequest" });

export type GoogleConnection = z.infer<typeof googleConnectionSchema>;
export type GoogleLinkChallenge = z.infer<typeof googleLinkChallengeSchema>;
export type GoogleLinkChallengeBody = z.infer<typeof googleLinkChallengeBodySchema>;
export type GoogleLinkBody = z.infer<typeof googleLinkBodySchema>;
export type GoogleUnlinkBody = z.infer<typeof googleUnlinkBodySchema>;
