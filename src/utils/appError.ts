import { ERRORS, type ErrorCode } from "./errors.js";

// throw new AppError("DOCUMENT_NOT_FOUND")
// 메시지를 바꾸고 싶을 때만 두 번째 인자를 넘긴다
export class AppError extends Error {
    readonly status: number;

    constructor(
        readonly code: ErrorCode,
        message?: string,
    ) {
        super(message ?? ERRORS[code].message);
        this.status = ERRORS[code].status;
    }
}
