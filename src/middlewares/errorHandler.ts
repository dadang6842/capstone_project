import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/appError.js";
import { ERRORS } from "../utils/errors.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
        return res.status(ERRORS.VALIDATION_ERROR.status).json({
            success: false,
            error: { code: "VALIDATION_ERROR", message: ERRORS.VALIDATION_ERROR.message, details: err.issues },
        });
    }
    if (err instanceof AppError) {
        return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
    }
    console.error(err);
    const { status, message } = ERRORS.INTERNAL_SERVER_ERROR;
    return res.status(status).json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message } });
};
