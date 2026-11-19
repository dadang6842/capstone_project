import bcrypt from "bcrypt";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { BCRYPT_ROUNDS, issueTokens, passwordMatches, toUserResponse } from "./auth.service.js";
import { AppError } from "../utils/appError.js";
import { verifyGoogleIdToken } from "../utils/googleAuth.js";
import type { TokenResponse, UserResponse } from "../schemas/auth.schema.js";
import type { ChangePasswordBody, UpdateNicknameBody, WithdrawBody, WithdrawResponse } from "../schemas/user.schema.js";

const WITHDRAWAL_GRACE_DAYS = 7;

// 토큰은 유효해도 그사이 탈퇴 요청을 했으면(access 토큰은 최대 30분 남아 있음) 로그인이 끊긴 것으로 본다
async function findActiveUser(userId: number) {
    const user = await userRepository.findById(BigInt(userId));
    if (!user || user.deletedAt) throw new AppError("UNAUTHORIZED");
    return user;
}

export const userService = {
    async getMe(userId: number): Promise<UserResponse> {
        return toUserResponse(await findActiveUser(userId));
    },

    async updateNickname(userId: number, { nickname }: UpdateNicknameBody): Promise<UserResponse> {
        const user = await findActiveUser(userId);
        return toUserResponse(await userRepository.update(user.userId, { nickname }));
    },

    // 다른 기기 로그인은 모두 끊고, 지금 기기에는 새 토큰을 줘서 로그인을 유지한다
    async changePassword(userId: number, { currentPassword, newPassword }: ChangePasswordBody): Promise<TokenResponse> {
        const user = await findActiveUser(userId);
        // 구글로만 가입한 계정은 바꿀 비밀번호가 없다
        if (user.password === null) throw new AppError("PASSWORD_NOT_SET");
        if (!(await passwordMatches(user, currentPassword))) throw new AppError("INVALID_PASSWORD");

        await userRepository.update(user.userId, { password: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
        await refreshTokenRepository.revokeAllByUser(user.userId);
        const { accessToken, refreshToken } = await issueTokens(user);
        return { accessToken, refreshToken };
    },

    // 바로 지우지 않고 deleted_at만 채운다. 7일 안에 로그인하면 탈퇴 취소(AUTH-06·AUTH-08) 가능
    // 본인 확인: password가 오면 비밀번호, 아니면 googleIdToken(이 계정에 연결된 구글 계정이어야 함)
    async withdraw(userId: number, { password, googleIdToken }: WithdrawBody): Promise<WithdrawResponse> {
        const user = await findActiveUser(userId);
        if (password !== undefined) {
            if (user.password === null) throw new AppError("PASSWORD_NOT_SET");
            if (!(await passwordMatches(user, password))) throw new AppError("INVALID_PASSWORD");
        } else {
            const google = await verifyGoogleIdToken(googleIdToken!);
            if (user.googleSub !== google.sub) throw new AppError("GOOGLE_ACCOUNT_MISMATCH");
        }

        const { deletedAt } = await userRepository.update(user.userId, { deletedAt: new Date() });
        await refreshTokenRepository.revokeAllByUser(user.userId);

        const permanentDeleteAt = new Date(deletedAt!.getTime() + WITHDRAWAL_GRACE_DAYS * 24 * 60 * 60 * 1000);
        return { deletedAt: deletedAt!, permanentDeleteAt };
    },
};
