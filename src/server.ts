import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { conversationRepository } from "./repositories/conversation.repository.js";
import { draftRepository } from "./repositories/draft.repository.js";

app.listen(env.PORT, async () => {
    logger.info("서버를 시작하였습니다.", { port: env.PORT });
    // 이전 프로세스에서 수집하다 끊긴 대화는 이어 갈 수 없어서 실패로 바꾼다 (사용자가 삭제 후 다시 등록)
    const { count } = await conversationRepository.failInterruptedCollecting();
    if (count > 0) logger.info(`중단된 대화 수집 ${count}건을 실패 처리하였습니다.`);
    // AI 서버 응답을 기다리던 초안도 마찬가지 (사용자가 '다시 시도')
    const drafts = await draftRepository.failInterruptedGenerating();
    if (drafts > 0) logger.info(`중단된 초안 생성 ${drafts}건을 실패 처리하였습니다.`);
});

// 어디서도 잡지 못한 오류도 error 로그에 남긴다
process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("INTERNAL_SERVER_ERROR", `unhandledRejection: ${err.message}`, undefined, err.stack);
});
