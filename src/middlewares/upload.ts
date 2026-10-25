import path from "node:path";
import type { RequestHandler } from "express";
import multer from "multer";
import { AppError } from "../utils/appError.js";
import type { ErrorCode } from "../utils/errors.js";

// JSON만 받는다. 내용은 보지 않고 확장자로만 판단한다
export const CONVERSATION_FILE_EXT = ".json";
const MAX_FILE_COUNT = 20;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// 저장하지 않고 건너뛴 파일 (응답의 failed에 들어감)
export type FailedFile = { filename: string; code: ErrorCode; message: string };

// 메모리에 받으면 요청 하나가 최대 1GB(20개 × 50MB)를 쓸 수 있어서, OS 임시 폴더에 받는다.
// 중간에 에러가 나면 multer가 받아 둔 임시 파일을 지우고, 정상 처리 후에는 서비스가 지운다.
const conversationUpload = multer({
    storage: multer.diskStorage({}),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILE_COUNT },
    // 한글 파일명이 깨지지 않게 (기본값 latin1)
    defParamCharset: "utf8",
    // 조건에 안 맞는 파일은 요청 전체를 막지 않고 그 파일만 건너뛴다
    fileFilter: (req, file, cb) => {
        const skip = (code: ErrorCode, message?: string) => {
            req.failedFiles.push({ filename: file.originalname, code, message: message ?? new AppError(code).message });
            cb(null, false);
        };
        if (path.extname(file.originalname).toLowerCase() !== CONVERSATION_FILE_EXT)
            return skip("UNSUPPORTED_FILE_TYPE");
        // conversations.filename이 VARCHAR(255)
        if (file.originalname.length > 255) return skip("VALIDATION_ERROR", "파일명은 255자까지 가능합니다.");
        cb(null, true);
    },
}).array("files");

const MULTER_ERRORS: Partial<Record<multer.MulterError["code"], ErrorCode>> = {
    LIMIT_FILE_SIZE: "FILE_TOO_LARGE",
    LIMIT_FILE_COUNT: "FILE_COUNT_EXCEEDED",
};

export const uploadConversationFiles: RequestHandler = (req, res, next) => {
    req.failedFiles = [];
    conversationUpload(req, res, (err: unknown) => {
        // 개수 초과·크기 초과는 multer가 받는 도중에 멈추므로 요청 전체를 거절한다
        if (err instanceof multer.MulterError) {
            // files가 아닌 이름으로 파일을 보낸 경우 등은 400 VALIDATION_ERROR
            const code = MULTER_ERRORS[err.code] ?? "VALIDATION_ERROR";
            return next(
                new AppError(code, code === "VALIDATION_ERROR" ? { message: `${err.message} (${err.field})` } : {}),
            );
        }
        if (err) return next(err);
        if (!Array.isArray(req.files) || req.files.length === 0) {
            if (req.failedFiles.length === 0) return next(new AppError("FILE_REQUIRED"));
            // 보낸 파일이 전부 건너뛰어졌으면 첫 번째 이유로 응답한다 (예: 전부 JSON이 아니면 415)
            return next(new AppError(req.failedFiles[0].code, { details: { failed: req.failedFiles } }));
        }
        next();
    });
};
