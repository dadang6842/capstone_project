import express from "express";
import routes from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { swaggerDocs } from "./docs/openapi.js";
import { AppError } from "./utils/appError.js";

export const app = express();

app.use(express.json());
app.use("/api-docs", ...swaggerDocs());
app.use("/api/v1", routes);
// 위에서 처리하지 못한 주소는 404 NOT_FOUND
app.use((_req, _res, next) => next(new AppError("NOT_FOUND")));
app.use(errorHandler);
