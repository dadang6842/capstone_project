import type { RequestHandler } from "express";
import type { ZodType } from "zod";

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

// 검증 실패 시 ZodError를 던지고, errorHandler가 400으로 응답한다.
export const validate =
    (schemas: Schemas): RequestHandler =>
    (req, _res, next) => {
        if (schemas.body) req.body = schemas.body.parse(req.body);
        if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
        // Express 5에서 req.query는 getter라 직접 대입이 안 되므로 덮어쓴다.
        if (schemas.query) {
            Object.defineProperty(req, "query", { value: schemas.query.parse(req.query) });
        }
        next();
    };
