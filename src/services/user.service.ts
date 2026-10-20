import bcrypt from "bcrypt";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { BCRYPT_ROUNDS, issueTokens } from "./auth.service.js";
import type { User } from "../generated/prisma/client.js";
import { userRepository } from "../repositories/user.repository.js";
import { AppError } from "../utils/appError.js";
import type { TokenResponse, UserResponse } from "../schemas/auth.schema.js";
import type { ChangePasswordBody, UpdateNicknameBody } from "../schemas/user.schema.js";

// 토큰은 유효해도 그사이 탈퇴 요청을 했으면(access 토큰은 최대 30분 남아 있음) 로그인이 끊긴 것으로 본다
async function findActiveUser(userId: number) {
    const user = await userRepository.findById(BigInt(userId));
    if (!user || user.deletedAt) throw new AppError("UNAUTHORIZED");
    return user;
}

function toUserResponse(user: User): UserResponse {
    return {
        userId: Number(user.userId),
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        createdAt: user.createdAt,
    };
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
        if (!(await bcrypt.compare(currentPassword, user.password))) throw new AppError("INVALID_PASSWORD");

        await userRepository.update(user.userId, { password: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
        await refreshTokenRepository.revokeAllByUser(user.userId);
        const { accessToken, refreshToken } = await issueTokens(user);
        return { accessToken, refreshToken };
    },
};
