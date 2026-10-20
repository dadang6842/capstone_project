import type { AccessPayload } from "../utils/jwt.js";

// authenticate 미들웨어가 넣어 주는 로그인 사용자 정보를 req.user로 쓸 수 있게 타입을 추가한다.
// authenticate를 거친 라우트에서만 값이 들어 있다.
declare global {
    namespace Express {
        interface Request {
            user: AccessPayload;
        }
    }
}

export {};
