import { z } from "zod";
import { nicknameField, passwordField } from "./auth.schema.js";

// 닉네임 수정(USER-02)
export const updateNicknameBodySchema = z.object({ nickname: nicknameField }).meta({ id: "UpdateNicknameRequest" });

// 비밀번호 변경(USER-03)
export const changePasswordBodySchema = z
    .object({
        currentPassword: z.string().min(1).meta({ description: "현재 비밀번호" }),
        newPassword: passwordField,
    })
    .meta({ id: "ChangePasswordRequest" });

// 회원 탈퇴(USER-04)
// 비밀번호가 있는 계정은 password, 구글로만 가입한 계정(hasPassword false)은 googleIdToken(구글 버튼으로 다시 받은 ID 토큰)으로 본인 확인
export const withdrawBodySchema = z
    .object({
        password: z.string().min(1).optional().meta({ description: "비밀번호 확인 (비밀번호가 있는 계정)" }),
        googleIdToken: z.string().min(1).optional().meta({ description: "구글 재인증 ID 토큰 (구글로만 가입한 계정)" }),
    })
    .refine((body) => body.password !== undefined || body.googleIdToken !== undefined, {
        message: "password 또는 googleIdToken 중 하나는 필요합니다.",
    })
    .meta({ id: "WithdrawRequest" });

export const withdrawResponseSchema = z
    .object({
        deletedAt: z.date().meta({ description: "탈퇴 요청 일시" }),
        permanentDeleteAt: z.date().meta({ description: "영구 삭제 예정 일시 (탈퇴 요청 + 7일)" }),
    })
    .meta({ id: "WithdrawResponse" });

export type UpdateNicknameBody = z.infer<typeof updateNicknameBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type WithdrawBody = z.infer<typeof withdrawBodySchema>;
export type WithdrawResponse = z.infer<typeof withdrawResponseSchema>;
