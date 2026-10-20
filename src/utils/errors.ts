// 에러 코드 목록
// 서비스는 throw new AppError("INVALID_CREDENTIALS")처럼 이름만 쓰고,
// 상태 코드와 기본 메시지는 여기서 가져온다. 스웨거 문서의 에러 응답도 이 목록으로 만든다.
export const ERRORS = {
    // 공통
    VALIDATION_ERROR: { status: 400, message: "요청 값이 올바르지 않습니다." },
    UNAUTHORIZED: { status: 401, message: "로그인이 필요합니다." },
    TOKEN_EXPIRED: { status: 401, message: "Access Token이 만료되었습니다." },
    FORBIDDEN: { status: 403, message: "권한이 없습니다." },
    NOT_FOUND: { status: 404, message: "요청한 주소를 찾을 수 없습니다." },
    INTERNAL_SERVER_ERROR: { status: 500, message: "서버 오류가 발생했습니다." },

    // 인증
    EMAIL_DUPLICATED: { status: 409, message: "이미 사용 중인 이메일입니다." },
    INVALID_CREDENTIALS: { status: 401, message: "이메일 또는 비밀번호가 올바르지 않습니다." },
    INVALID_TOKEN: { status: 401, message: "유효하지 않은 토큰입니다." },
    WITHDRAWAL_PENDING: { status: 403, message: "탈퇴 처리 중인 계정입니다." },
    WITHDRAWAL_NOT_REQUESTED: { status: 409, message: "탈퇴 요청 상태가 아닌 계정입니다." },

    // 회원
    INVALID_PASSWORD: { status: 400, message: "현재 비밀번호가 올바르지 않습니다." },

    // 대화
    CONVERSATION_NOT_FOUND: { status: 404, message: "대화를 찾을 수 없습니다." },
    CONVERSATION_IN_USE: { status: 409, message: "문서 생성에 사용 중인 대화입니다." },

    // 파일
    FILE_REQUIRED: { status: 400, message: "파일을 첨부해 주세요." },
    FILE_TOO_LARGE: { status: 413, message: "파일은 50MB까지 올릴 수 있습니다." },
    FILE_COUNT_EXCEEDED: { status: 400, message: "한 번에 20개까지 올릴 수 있습니다." },
    UNSUPPORTED_FILE_TYPE: { status: 415, message: "PDF, MD, TXT 파일만 올릴 수 있습니다." },

    // 문서
    DOCUMENT_NOT_FOUND: { status: 404, message: "문서를 찾을 수 없습니다." },
    DOCUMENT_NOT_FINALIZED: { status: 409, message: "최종 채택 전인 문서는 편집할 수 없습니다." },

    // 초안
    DRAFT_NOT_FOUND: { status: 404, message: "초안을 찾을 수 없습니다." },
    INVALID_DRAFT_STATUS: { status: 409, message: "지금 상태에서는 할 수 없는 요청입니다." },
    REVISION_IN_PROGRESS: { status: 409, message: "AI 보완이 진행 중입니다." },
    SOURCES_DELETED: { status: 409, message: "원본 대화가 모두 삭제되어 누락 내용을 보완할 수 없습니다." },

    // AI 서버 연동
    INVALID_INTERNAL_KEY: { status: 401, message: "AI 서버 인증 키가 올바르지 않습니다." },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERRORS;
