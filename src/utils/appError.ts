import { ERRORS, type ErrorCode } from "./errors.js";

// throw new AppError("DOCUMENT_NOT_FOUND")
// 메시지를 바꾸거나 추가 정보를 줄 때만 두 번째 인자를 넘긴다
// e.g. 탈퇴 일시 넘길 때(withdrawalRequestedAt)
export class AppError extends Error {
    readonly status: number;
    readonly details?: Record<string, unknown>;

    constructor(
        readonly code: ErrorCode,
        options: { message?: string; details?: Record<string, unknown> } = {},
    ) {
        super(options.message ?? ERRORS[code].message);
        this.status = ERRORS[code].status;
        this.details = options.details;
    }
}
