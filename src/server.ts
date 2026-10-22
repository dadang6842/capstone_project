import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";

app.listen(env.PORT, () => {
    logger.info("서버를 시작하였습니다.", { port: env.PORT });
});

// 어디서도 잡지 못한 오류도 error 로그에 남긴다
process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("INTERNAL_SERVER_ERROR", `unhandledRejection: ${err.message}`, undefined, err.stack);
});
