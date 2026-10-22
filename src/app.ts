import express from "express";
import routes from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { swaggerDocs } from "./docs/openapi.js";
import { AppError } from "./utils/appError.js";
import { requestContext } from "./middlewares/requestContext.js";
import cors from "cors";

export const app = express();

// Prisma가 BIGINT 컬럼(ID)을 BigInt로 주는데 JSON에는 BigInt가 안 들어가서 숫자로 바꿔 보낸다
app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? Number(value) : value));
app.use(requestContext);
app.use(cors()); // 일단 모든 출처 허용 (프론트 주소 정해지면 origin 지정)
app.use(express.json());
app.use("/api-docs", ...swaggerDocs());
app.use("/api/v1", routes);
// 위에서 처리하지 못한 주소는 404 NOT_FOUND
app.use((_req, _res, next) => next(new AppError("NOT_FOUND")));
app.use(errorHandler);
