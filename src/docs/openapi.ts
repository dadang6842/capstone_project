import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import swaggerUi from "swagger-ui-express";
import { errorResponseSchema } from "../schemas/common.schema.js";
import { ERRORS, type ErrorCode } from "../utils/errors.js";

// 각 라우트 파일에서 registry.registerPath(...)로 문서를 등록한다
export const registry = new OpenAPIRegistry();

// 로그인이 필요한 API는 registerPath에 security: bearerAuth 를 넣는다
const bearer = registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
});
export const bearerAuth = [{ [bearer.name]: [] }];

// errorResponses("VALIDATION_ERROR", "INVALID_CREDENTIALS") → { 400: {...}, 401: {...} }
export function errorResponses(...codes: ErrorCode[]) {
    const byStatus: Record<number, ErrorCode[]> = {};
    for (const code of codes) (byStatus[ERRORS[code].status] ??= []).push(code);

    return Object.fromEntries(
        Object.entries(byStatus).map(([status, list]) => [
            status,
            {
                description: list.map((c) => `${c}: ${ERRORS[c].message}`).join("\n\n"),
                content: { "application/json": { schema: errorResponseSchema } },
            },
        ]),
    );
}

// app.ts에서 라우트를 다 불러온 뒤 호출 → 등록된 문서로 Swagger UI를 만든다
export function swaggerDocs() {
    const document = new OpenApiGeneratorV3(registry.definitions).generateDocument({
        openapi: "3.0.3",
        info: { title: "졸업 프로젝트 API", version: "1.0.0" },
        servers: [{ url: "/api/v1" }],
    });
    return [swaggerUi.serve, swaggerUi.setup(document)];
}
