import bcrypt from "bcrypt";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { AppError } from "../utils/appError.js";
import { signAccessToken, signRefreshToken } from "../utils/jwt.js";
import type { LoginBody, LoginResponse } from "../schemas/auth.schema.js";

export const authService = {
    async login({ email, password }: LoginBody): Promise<LoginResponse> {
        const user = await userRepository.findByEmail(email);

        // 이메일이 없을 때와 비밀번호가 틀릴 때 같은 에러 (어느 쪽이 틀렸는지 알려 주지 않음)
        if (!user || !(await bcrypt.compare(password, user.password))) {
            throw new AppError("INVALID_CREDENTIALS");
        }

        // 탈퇴 유예 중 (deleted_at이 있으면 7일 유예 기간)
        if (user.deletedAt) {
            throw new AppError("WITHDRAWAL_PENDING", { details: { withdrawalRequestedAt: user.deletedAt } });
        }

        const userId = Number(user.userId);
        const accessToken = signAccessToken({ userId, role: user.role });
        const refresh = signRefreshToken(userId);
        await refreshTokenRepository.create({
            userId: user.userId,
            token: refresh.token,
            expiresAt: refresh.expiresAt,
        });

        return {
            user: { userId, email: user.email, nickname: user.nickname, role: user.role, createdAt: user.createdAt },
            accessToken,
            refreshToken: refresh.token,
        };
    },
};
