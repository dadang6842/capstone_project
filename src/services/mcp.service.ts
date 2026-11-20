import { conversationRepository } from "../repositories/conversation.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { parseShareLink } from "../utils/shareUrl.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type { SaveCaptureBody, SaveCaptureResponse } from "../schemas/mcp.schema.js";

export const mcpService = {
    // ChatGPT에서 보낸 공유 대화를 내 개인 공간에 저장한다 (수집은 MCP 서버가 이미 끝낸 상태).
    // 웹 등록(CONV-01)과 같은 저장 함수(saveCollected)를 써서 중복 규칙(dedup_key)도 같다. source는 SHARE_LINK 그대로.
    // 다만 중복이면 실패 대화를 목록에 남기지 않는다 (웹과 달리 사용자가 화면에서 보고 지울 기회가 없어서)
    async saveCapture(userId: number, { shareUrl, ...collected }: SaveCaptureBody): Promise<SaveCaptureResponse> {
        const user = await userRepository.findById(BigInt(userId));
        if (!user || user.deletedAt) throw new AppError("UNAUTHORIZED");

        const link = parseShareLink(shareUrl);
        if (!link) throw new AppError("INVALID_SHARE_URL");

        const conversation = await conversationRepository.create(BigInt(userId), null, link.url, link.provider);
        const conversationId = conversation.conversationId;

        let saved;
        try {
            // saveCollected는 collect.py 출력 모양(ok: true 포함)을 받는다
            saved = await conversationRepository.saveCollected(conversationId, { ok: true, ...collected });
        } catch (err) {
            // 저장에 실패하면 방금 만든 COLLECTING 대화가 목록에 남지 않게 지운다
            await conversationRepository.softDelete(conversationId).catch(() => undefined);
            throw err;
        }

        if (saved.result === "DUPLICATED") {
            await conversationRepository.softDelete(conversationId);
            logger.info(
                `ChatGPT에서 보낸 대화가 이미 저장된 대화와 같아 저장하지 않았습니다. (기존 conversationId=${saved.duplicateOf})`,
            );
            return {
                status: "duplicated",
                conversationId: Number(saved.duplicateOf),
                message: "이미 저장한 대화입니다.",
            };
        }
        if (saved.result === "SKIPPED") throw new Error("방금 만든 대화를 저장하지 못했습니다.");

        logger.info(`ChatGPT에서 보낸 공유 대화를 저장하였습니다. 발화 ${collected.messages.length}개`, {
            conversationId,
        });
        return {
            status: "saved",
            conversationId: Number(conversationId),
            message: "대화를 저장했습니다. AI Archive 웹의 대화 목록에서 문서를 만들 수 있습니다.",
        };
    },
};
