import express from "express";
import routes from "./routes/index.js";
import oauthRoutes from "./routes/oauth.route.js";
import mcpRoutes from "./routes/mcp.route.js";
import { mcpConfig } from "./config/mcp.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { swaggerDocs } from "./docs/openapi.js";
import { AppError } from "./utils/appError.js";
import { requestContext } from "./middlewares/requestContext.js";

export const app = express();

// Prisma가 BIGINT 컬럼(ID)을 BigInt로 주는데 JSON에는 BigInt가 안 들어가서 숫자로 바꿔 보낸다
app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? Number(value) : value));
app.use(requestContext);
// 비공개 대화 가져오기(CONV-05)는 긴 대화 원문을 한 번에 받아서 기본 크기 제한(100kb)보다 크게 받는다.
// 아래 express.json()보다 먼저 연결해야 한다 (이미 읽은 body는 다시 읽지 않음). EC2 Nginx client_max_body_size도 20m 이상이어야 함
app.use("/api/v1/conversations/import", express.json({ limit: "20mb" }));
// ChatGPT 커넥터(MCP)용. .env에 MCP_ 값이 모두 있을 때만 켠다 (로컬 개발에서는 없어도 됨)
//  - /oauth/*, /.well-known/oauth-authorization-server: 로그인·토큰 발급 (OAuth 표준 형식으로 응답해서 /api/v1 밖)
//  - /api/v1/mcp: MCP 서버가 수집 결과를 저장하는 API (큰 JSON을 받아서 아래 express.json()보다 먼저 연결)
if (mcpConfig.enabled) {
    app.use(oauthRoutes);
    app.use("/api/v1/mcp", mcpRoutes);
}
app.use(express.json());
app.use("/api-docs", ...swaggerDocs());
app.use("/api/v1", routes);
// 위에서 처리하지 못한 주소는 404 NOT_FOUND
app.use((_req, _res, next) => next(new AppError("NOT_FOUND")));
app.use(errorHandler);
