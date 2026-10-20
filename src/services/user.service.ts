import { userRepository } from "../repositories/user.repository.js";
import { AppError } from "../utils/appError.js";
import type { UserResponse } from "../schemas/auth.schema.js";

export const userService = {
    async getMe(userId: number): Promise<UserResponse> {
        const user = await userRepository.findById(BigInt(userId));

        // 토큰은 유효해도 그사이 탈퇴 요청을 했으면(access 토큰은 최대 30분 남아 있음) 로그인이 끊긴 것으로 본다
        if (!user || user.deletedAt) throw new AppError("UNAUTHORIZED");

        return {
            userId: Number(user.userId),
            email: user.email,
            nickname: user.nickname,
            role: user.role,
            createdAt: user.createdAt,
        };
    },
};
