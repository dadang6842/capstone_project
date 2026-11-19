import type { RequestHandler } from "express";
import { AppError } from "../utils/appError.js";
import { userRepository } from "../repositories/user.repository.js";

// 관리자 API(/api/v1/admin/*)용. authenticate 다음에 붙인다.
// 토큰의 role은 발급 당시 값이라, 권한을 바꾼 직후에도 맞게 동작하도록 DB에서 다시 확인한다.
// 관리자가 아니거나 탈퇴 요청한 계정이면 403 FORBIDDEN.
export const requireAdmin: RequestHandler = async (req, _res, next) => {
    const user = await userRepository.findById(BigInt(req.user.userId));
    if (!user || user.role !== "ADMIN" || user.deletedAt) throw new AppError("FORBIDDEN");
    next();
};
