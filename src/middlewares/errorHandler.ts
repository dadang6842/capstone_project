import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/appError.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
        return res.status(400).json({
            success: false,
            error: { code: "VALIDATION_ERROR", message: "요청 값이 올바르지 않습니다.", details: err.issues },
        });
    }
    if (err instanceof AppError) {
        return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
    }
    console.error(err);
    return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "서버 오류가 발생했습니다." } });
};
