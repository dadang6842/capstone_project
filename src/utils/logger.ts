import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { env } from "../config/env.js";
import { ERRORS, INTERNAL_ERRORS, type ErrorCode, type InternalErrorCode } from "./errors.js";

// 설계서 8.3 로그 파일 설계
//  - app-YYYY-MM-DD.log: error·warn·info 전체, 14일 보관
//  - error-YYYY-MM-DD.log: error만, 30일 보관
//  - 하루 지난 파일은 gzip 압축, debug는 개발 환경 콘솔에만 출력
//  - 형식: YYYY.MM.DD.HH:mm:ss.SS [레벨] 코드 : 메시지, 상세내용 (요청정보)
// 비밀번호, 토큰, API 키, 대화 파일·문서 본문은 로그에 남기지 않는다.

// 요청마다 req를 담아 두면 서비스 코드에서도 요청 정보(메서드, 경로, userId, reqId)를 자동으로 붙일 수 있다
export const requestStore = new AsyncLocalStorage<Request>();

const lineFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY.MM.DD.HH:mm:ss.SS" }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`),
);

const fileOptions = { dirname: env.LOG_DIR, datePattern: "YYYY-MM-DD", zippedArchive: true, format: lineFormat };

const winstonLogger = winston.createLogger({
    level: env.NODE_ENV === "production" ? "info" : "debug",
    transports: [
        new winston.transports.Console({ format: lineFormat }),
        new DailyRotateFile({ ...fileOptions, filename: "app-%DATE%.log", level: "info", maxFiles: "14d" }),
        new DailyRotateFile({ ...fileOptions, filename: "error-%DATE%.log", level: "error", maxFiles: "30d" }),
    ],
});

type LogContext = Record<string, string | number | bigint | null | undefined>;

// 로그 끝의 요청 정보 e.g. "(POST /api/v1/auth/login, userId=12, reqId=a1f3)"를 만든다.
// userId는 로그인한 요청이면 req.user에서 자동으로 꺼내고, 직접 넘긴 값이 있으면 그 값을 쓴다.
function contextText(ctx: LogContext = {}) {
    const req = requestStore.getStore();
    const parts: string[] = [];
    if (req) parts.push(`${req.method} ${req.originalUrl.split("?")[0]}`);
    const merged: LogContext = { userId: req?.user?.userId, ...ctx, reqId: req?.id };
    for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined && value !== null) parts.push(`${key}=${value}`);
    }
    return parts.length ? ` (${parts.join(", ")})` : "";
}

function errorInfo(code: ErrorCode | InternalErrorCode) {
    return code in ERRORS ? ERRORS[code as ErrorCode] : INTERNAL_ERRORS[code as InternalErrorCode];
}

function errorLine(code: ErrorCode | InternalErrorCode, detail: string | undefined, ctx?: LogContext) {
    const { no, title } = errorInfo(code);
    return `${no} : ${title}${detail ? `, ${detail}` : ""}${contextText(ctx)}`;
}

export const logger = {
    // 정상 처리: logger.info("로그인에 성공하였습니다.", { userId })
    info(message: string, ctx?: LogContext) {
        winstonLogger.info(`200 : 정상 처리, ${message}${contextText(ctx)}`);
    },

    // 클라이언트 요청 오류: logger.warn("UNSUPPORTED_FILE_TYPE", "'chat-export.zip'")
    warn(code: ErrorCode, detail?: string, ctx?: LogContext) {
        winstonLogger.warn(errorLine(code, detail, ctx));
    },

    // 서버 내부 오류: logger.error("GPT_REQUEST_FAILED", "OpenAI API 응답 시간 초과", { documentId, draftId })
    // stack을 넘기면 다음 줄부터 함께 기록한다
    error(code: ErrorCode | InternalErrorCode, detail?: string, ctx?: LogContext, stack?: string) {
        winstonLogger.error(errorLine(code, detail, ctx) + (stack ? `\n${stack}` : ""));
    },

    // 개발 확인용 (운영 파일에는 기록 안 됨)
    debug(message: string) {
        winstonLogger.debug(message);
    },
};
