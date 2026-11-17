import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { relationController } from "../controllers/relation.controller.js";
import { relationGraphQuerySchema, relationGraphSchema } from "../schemas/relation.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

// 문서 관계도 (2026-11-17). 설계서에 없는 새 화면이라 A06 지식 문서 목록의 '관계도 보기'로 붙였다
const router = Router();

registry.registerPath({
    method: "get",
    path: "/relations",
    tags: ["Relation"],
    summary: "문서 관계도 조회 (REL-01)",
    description:
        "화면: A06 지식 문서 목록 → 관계도 보기(설계서에 없는 새 화면). 이 공간의 최종 문서를 점(nodes)으로, 본문 내용이 비슷한 문서끼리 선(edges)으로, 가까운 문서끼리 묶음(groupId)으로 준다. 선은 내용 유사성일 뿐 인과·선후 관계가 아니다. " +
        "점을 누르면 DOC-02로 문서를 연다. 문서가 바뀐 뒤 첫 조회는 다시 계산해서 수 초 이상 걸릴 수 있다. 팀 화면에서는 ?workspaceId=(팀원이 아니면 404).",
    security: bearerAuth,
    request: { query: relationGraphQuerySchema },
    responses: {
        200: {
            description: "문서 관계도",
            content: { "application/json": { schema: successResponse(relationGraphSchema) } },
        },
        ...errorResponses(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "WORKSPACE_NOT_FOUND",
            "RELATIONS_TOO_LARGE",
            "AI_RELATIONS_FAILED",
            "AI_RELATIONS_UNAVAILABLE",
        ),
    },
});
router.get("/", authenticate, validate({ query: relationGraphQuerySchema }), relationController.getGraph);

export default router;
