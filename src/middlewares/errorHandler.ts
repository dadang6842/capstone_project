import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/appError.js";
import { ERRORS } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

type InternalLogCode = "INTERNAL_SERVER_ERROR" | "DATABASE_ERROR";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
        // 입력값 자체는 비밀번호일 수 있어서 어느 필드가 틀렸는지만 남긴다
        logger.warn("VALIDATION_ERROR", err.issues.map((issue) => issue.path.join(".") || "body").join(", "));
        return res.status(ERRORS.VALIDATION_ERROR.status).json({
            success: false,
            error: { code: "VALIDATION_ERROR", message: ERRORS.VALIDATION_ERROR.message, details: err.issues },
        });
    }
    // express.json()이 깨진 JSON 본문을 받은 경우
    if (err.type === "entity.parse.failed") {
        logger.warn("VALIDATION_ERROR", "JSON 형식 오류");
        const { status, message } = ERRORS.VALIDATION_ERROR;
        return res.status(status).json({ success: false, error: { code: "VALIDATION_ERROR", message } });
    }
    if (err instanceof AppError) {
        // 기본 메시지와 다르게 던진 경우에만 상세 내용으로 남긴다
        const detail = err.message !== ERRORS[err.code].message ? err.message : undefined;
        if (err.status >= 500) logger.error(err.code, detail);
        else logger.warn(err.code, detail);
        return res
            .status(err.status)
            .json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
    }
    // Prisma 오류는 8001 DATABASE_ERROR로 기록하고, 클라이언트에는 1006으로 응답한다
    const { code, detail, stack } = describeUnknownError(err);
    logger.error(code, detail, undefined, stack);
    const { status, message: clientMessage } = ERRORS.INTERNAL_SERVER_ERROR;
    return res
        .status(status)
        .json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message: clientMessage } });
};

// 예상하지 못한 오류를 로그용 코드·상세·호출 위치로 정리한다.
// Prisma 검증 오류 메시지에는 쿼리 값(이메일, 비밀번호 해시 등)이 들어갈 수 있어서 이름만 남기고,
// 스택도 메시지 부분은 빼고 "at ..." 줄만 남긴다.
function describeUnknownError(err: unknown): { code: InternalLogCode; detail: string; stack?: string } {
    if (!(err instanceof Error)) return { code: "INTERNAL_SERVER_ERROR", detail: String(err) };
    const frames = err.stack
        ?.split("\n")
        .filter((line) => line.trim().startsWith("at "))
        .join("\n");
    if (!err.name.startsWith("PrismaClient"))
        return { code: "INTERNAL_SERVER_ERROR", detail: err.message, stack: frames };
    const detail =
        err.name === "PrismaClientValidationError"
            ? err.name
            : err.message
                  .replace(/Invalid `.*?` invocation:/, "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 300);
    return { code: "DATABASE_ERROR", detail, stack: frames };
}
