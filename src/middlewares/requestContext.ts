import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { requestStore } from "../utils/logger.js";

// 요청마다 짧은 reqId를 붙이고, 이 요청에서 남기는 로그가 요청 정보를 알 수 있게 req를 저장해 둔다
export const requestContext: RequestHandler = (req, _res, next) => {
    req.id = randomUUID().slice(0, 8);
    requestStore.run(req, next);
};
