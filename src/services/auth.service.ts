import bcrypt from "bcrypt";
import { Prisma, type User } from "../generated/prisma/client.js";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { AppError } from "../utils/appError.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import type { SignupBody, LoginBody, LoginResponse, RefreshTokenBody, TokenResponse } from "../schemas/auth.schema.js";

const BCRYPT_ROUNDS = 10;

// 로그인·회원가입 공통: 토큰을 발급하고 refresh 토큰을 저장한 뒤 응답 형태로 만든다
async function issueTokens(user: User): Promise<LoginResponse> {
    const userId = Number(user.userId);
    const accessToken = signAccessToken({ userId, role: user.role });
    const refresh = signRefreshToken(userId);
    await refreshTokenRepository.create({ userId: user.userId, token: refresh.token, expiresAt: refresh.expiresAt });

    return {
        user: { userId, email: user.email, nickname: user.nickname, role: user.role, createdAt: user.createdAt },
        accessToken,
        refreshToken: refresh.token,
    };
}

export const authService = {
    async signup({ email, password, nickname }: SignupBody): Promise<LoginResponse> {
        // 탈퇴 유예 중인 계정도 행이 남아 있으므로 여기서 같이 걸린다
        if (await userRepository.findByEmail(email)) throw new AppError("EMAIL_DUPLICATED");

        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        try {
            const user = await userRepository.create({ email, password: hashed, nickname });
            return await issueTokens(user);
        } catch (err) {
            // 같은 이메일로 동시에 가입하면 위 확인을 둘 다 통과할 수 있어서, DB UNIQUE 위반(P2002)도 중복으로 처리
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw new AppError("EMAIL_DUPLICATED");
            }
            throw err;
        }
    },

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

        return issueTokens(user);
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
