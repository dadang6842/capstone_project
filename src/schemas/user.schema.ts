import { z } from "zod";
import { nicknameField, passwordField } from "./auth.schema.js";

// 닉네임 수정
export const updateNicknameBodySchema = z.object({ nickname: nicknameField }).meta({ id: "UpdateNicknameRequest" });

// 비밀번호 변경
export const changePasswordBodySchema = z
    .object({
        currentPassword: z.string().min(1).meta({ description: "현재 비밀번호" }),
        newPassword: passwordField,
    })
    .meta({ id: "ChangePasswordRequest" });

// 회원 탈퇴
export const withdrawBodySchema = z
    .object({ password: z.string().min(1).meta({ description: "비밀번호 확인" }) })
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
