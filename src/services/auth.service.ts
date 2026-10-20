import bcrypt from "bcrypt";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { AppError } from "../utils/appError.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import type { LoginBody, LoginResponse, RefreshTokenBody, TokenResponse } from "../schemas/auth.schema.js";

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

    async refresh({ refreshToken }: RefreshTokenBody): Promise<TokenResponse> {
        // 1) 서명·만료 확인
        try {
            verifyRefreshToken(refreshToken);
        } catch {
            throw new AppError("INVALID_TOKEN");
        }

        // 2) DB 확인: 저장된 토큰인지, 로그아웃(폐기)·만료되지 않았는지, 탈퇴 유예 중이 아닌지
        const saved = await refreshTokenRepository.findByTokenWithUser(refreshToken);
        if (!saved || saved.revokedAt || saved.expiresAt <= new Date() || saved.user.deletedAt) {
            throw new AppError("INVALID_TOKEN");
        }

        // 3) 토큰 회전: 기존 refresh 토큰은 폐기하고 새 토큰 쌍을 준다
        const userId = Number(saved.userId);
        const next = signRefreshToken(userId);
        const rotated = await refreshTokenRepository.rotate(refreshToken, {
            userId: saved.userId,
            token: next.token,
            expiresAt: next.expiresAt,
        });
        if (!rotated) throw new AppError("INVALID_TOKEN"); // 동시에 들어온 다른 요청이 먼저 썼음

        return { accessToken: signAccessToken({ userId, role: saved.user.role }), refreshToken: next.token };
    },

    // 현재 기기의 refresh 토큰만 폐기한다. 이미 폐기됐거나 없는 토큰이어도 성공으로 처리한다.
    async logout(userId: number, { refreshToken }: RefreshTokenBody) {
        await refreshTokenRepository.revoke(refreshToken, BigInt(userId));
    },
};
