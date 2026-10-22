// 에러 코드 목록 (API 명세서 에러 코드 표 기준)
// 서비스는 throw new AppError("INVALID_CREDENTIALS")처럼 이름만 쓰고,
// 상태 코드와 기본 메시지는 여기서 가져온다. 스웨거 문서의 에러 응답도 이 목록으로 만든다.
// no·title은 설계서 에러 코드 정의 표의 번호·이름으로, 로그에만 쓴다 (응답에는 code 문자열만 나감).
export const ERRORS = {
    // 공통
    VALIDATION_ERROR: { no: 1001, title: "요청 값 형식 오류", status: 400, message: "요청 값이 올바르지 않습니다." },
    UNAUTHORIZED: { no: 1002, title: "Access Token 없음/위조", status: 401, message: "로그인이 필요합니다." },
    TOKEN_EXPIRED: { no: 1003, title: "Access Token 만료", status: 401, message: "Access Token이 만료되었습니다." },
    FORBIDDEN: { no: 1004, title: "접근 권한 없음", status: 403, message: "권한이 없습니다." },
    NOT_FOUND: { no: 1005, title: "존재하지 않는 URL", status: 404, message: "요청한 주소를 찾을 수 없습니다." },
    INTERNAL_SERVER_ERROR: {
        no: 1006,
        title: "예상하지 못한 서버 오류",
        status: 500,
        message: "서버 오류가 발생했습니다.",
    },

    // 인증·회원
    EMAIL_DUPLICATED: { no: 2001, title: "이메일 중복", status: 409, message: "이미 사용 중인 이메일입니다." },
    INVALID_CREDENTIALS: {
        no: 2002,
        title: "이메일 또는 비밀번호 불일치",
        status: 401,
        message: "이메일 또는 비밀번호가 올바르지 않습니다.",
    },
    INVALID_TOKEN: { no: 2003, title: "Refresh Token 무효", status: 401, message: "유효하지 않은 토큰입니다." },
    WITHDRAWAL_PENDING: { no: 2004, title: "탈퇴 유예 중인 계정", status: 403, message: "탈퇴 처리 중인 계정입니다." },
    WITHDRAWAL_NOT_REQUESTED: {
        no: 2005,
        title: "취소할 탈퇴 요청 없음",
        status: 409,
        message: "탈퇴 요청 상태가 아닌 계정입니다.",
    },
    INVALID_PASSWORD: {
        no: 2006,
        title: "현재 비밀번호 불일치",
        status: 400,
        message: "현재 비밀번호가 올바르지 않습니다.",
    },

    // 대화·파일
    FILE_REQUIRED: { no: 3001, title: "파일 미첨부", status: 400, message: "파일을 첨부해 주세요." },
    FILE_TOO_LARGE: {
        no: 3002,
        title: "파일 크기 초과 (파일당 50MB)",
        status: 413,
        message: "파일은 50MB까지 올릴 수 있습니다.",
    },
    FILE_COUNT_EXCEEDED: {
        no: 3003,
        title: "업로드 개수 초과 (요청당 20개)",
        status: 400,
        message: "한 번에 20개까지 올릴 수 있습니다.",
    },
    UNSUPPORTED_FILE_TYPE: {
        no: 3004,
        title: "지원하지 않는 파일 형식",
        status: 415,
        message: "PDF, MD, TXT 파일만 올릴 수 있습니다.",
    },
    CONVERSATION_NOT_FOUND: { no: 3006, title: "대화 없음", status: 404, message: "대화를 찾을 수 없습니다." },
    CONVERSATION_IN_USE: {
        no: 3007,
        title: "분석 중인 대화 삭제 불가",
        status: 409,
        message: "문서 생성에 사용 중인 대화입니다.",
    },

    // 초안
    DRAFT_NOT_FOUND: { no: 4001, title: "초안 없음", status: 404, message: "초안을 찾을 수 없습니다." },
    INVALID_DRAFT_STATUS: {
        no: 4002,
        title: "현재 초안 상태에서 불가능한 요청",
        status: 409,
        message: "지금 상태에서는 할 수 없는 요청입니다.",
    },
    REVISION_IN_PROGRESS: { no: 4003, title: "AI 보완 진행 중", status: 409, message: "AI 보완이 진행 중입니다." },
    SOURCES_DELETED: {
        no: 4004,
        title: "원본 대화 모두 삭제",
        status: 409,
        message: "원본 대화가 모두 삭제되어 누락 내용을 보완할 수 없습니다.",
    },

    // 문서
    DOCUMENT_NOT_FOUND: { no: 5001, title: "문서 없음", status: 404, message: "문서를 찾을 수 없습니다." },
    DOCUMENT_NOT_FINALIZED: {
        no: 5002,
        title: "완성되지 않은 문서",
        status: 409,
        message: "최종 채택 전인 문서는 편집할 수 없습니다.",
    },

    // AI 서버 연동
    INVALID_INTERNAL_KEY: {
        no: 7001,
        title: "서버 간 인증 키 불일치",
        status: 401,
        message: "AI 서버 인증 키가 올바르지 않습니다.",
    },
} as const satisfies Record<string, { no: number; title: string; status: number; message: string }>;

export type ErrorCode = keyof typeof ERRORS;

// 클라이언트 응답으로는 나가지 않고 로그에만 남기는 서버 내부 오류
export const INTERNAL_ERRORS = {
    FILE_UPLOAD_FAILED: { no: 3005, title: "S3 파일 저장 실패" },
    AI_SERVER_REQUEST_FAILED: { no: 7002, title: "AI 서버 요청 전송 실패" },
    AI_ANALYSIS_FAILED: { no: 7003, title: "AI 서버 대화 분석 실패" },
    GPT_REQUEST_FAILED: { no: 7004, title: "GPT 호출 실패" },
    GPT_INVALID_RESPONSE: { no: 7005, title: "GPT 응답 형식 불일치" },
    AI_REVISION_FAILED: { no: 7006, title: "AI 서버 수정본 생성 실패" },
    DATABASE_ERROR: { no: 8001, title: "DB 처리 실패" },
    WITHDRAWAL_PURGE_FAILED: { no: 8002, title: "탈퇴 회원 영구 삭제 실패" },
} as const satisfies Record<string, { no: number; title: string }>;

export type InternalErrorCode = keyof typeof INTERNAL_ERRORS;
