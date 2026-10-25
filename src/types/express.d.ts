import type { AccessPayload } from "../utils/jwt.js";
import type { FailedFile } from "../middlewares/upload.js";

// authenticate 미들웨어가 넣어 주는 로그인 사용자 정보를 req.user로 쓸 수 있게 타입을 추가한다.
// authenticate를 거친 라우트에서만 값이 들어 있다.
declare global {
    namespace Express {
        interface Request {
            user: AccessPayload;
            id: string; // requestContext 미들웨어가 넣는 로그용 요청 아이디
            failedFiles: FailedFile[]; // 대화 업로드(CONV-01)에서 건너뛴 파일. upload 미들웨어가 채운다
        }
    }
}

export {};
