import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { uploadConversationFiles } from "../middlewares/upload.js";
import { conversationController } from "../controllers/conversation.controller.js";
import { uploadConversationsBodySchema, uploadConversationsResponseSchema } from "../schemas/conversation.schema.js";
import { successResponse } from "../schemas/common.schema.js";
import { registry, errorResponses, bearerAuth } from "../docs/openapi.js";

const router = Router();

registry.registerPath({
    method: "post",
    path: "/conversations",
    tags: ["Conversation"],
    summary: "대화 가져오기 (CONV-01)",
    description:
        "ChatGPT·Claude에서 내보낸 대화 JSON 파일을 올린다. 파일 1개가 대화 1개가 된다. JSON만(확장자로 확인), 요청당 1~20개, 파일당 50MB. " +
        "내용은 해석하지 않고 S3에 저장한 뒤 기록만 한다. 파일마다 따로 저장해서, JSON이 아니거나 저장에 실패한 파일은 failed로 알려 주고 나머지는 저장한다. " +
        "개수·크기 초과는 요청 전체를 거절한다. 하나도 저장하지 못하면 에러로 응답하고 details.failed에 파일별 이유를 준다.",
    security: bearerAuth,
    request: {
        body: { required: true, content: { "multipart/form-data": { schema: uploadConversationsBodySchema } } },
    },
    responses: {
        201: {
            description: "1개 이상 저장됨 (저장 못 한 파일은 failed)",
            content: { "application/json": { schema: successResponse(uploadConversationsResponseSchema) } },
        },
        ...errorResponses(
            "FILE_REQUIRED",
            "FILE_COUNT_EXCEEDED",
            "UNAUTHORIZED",
            "TOKEN_EXPIRED",
            "FILE_TOO_LARGE",
            "UNSUPPORTED_FILE_TYPE",
            "INTERNAL_SERVER_ERROR",
        ),
    },
});
// 로그인 확인을 먼저 해서, 로그인하지 않은 요청은 파일을 받기 전에 끊는다
router.post("/", authenticate, uploadConversationFiles, conversationController.upload);

export default router;
