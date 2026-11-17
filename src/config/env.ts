import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(1),
    JWT_REFRESH_SECRET: z.string().min(1),
    LOG_DIR: z.string().default("logs"),
    // 공유 대화 수집 모듈(collector/collect.py)을 실행할 Python. Docker 이미지 안에서는 PATH의 venv python3를 쓴다
    //  - 로컬(맥·리눅스): collector/.venv/bin/python, 윈도우: collector\\.venv\\Scripts\\python.exe
    COLLECTOR_PYTHON: z.string().default("python3"),
    COLLECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
    // 동시에 띄우는 Chromium 수. 하나에 메모리 200~500MB라 작은 EC2에서는 1
    COLLECTOR_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    // AI 서버 주소와 서버 간 인증 키. 아직 정해지지 않아서 비워 둘 수 있다 (비어 있으면 문서 생성이 바로 실패 처리됨)
    AI_SERVER_URL: z.string().default(""),
    INTERNAL_API_KEY: z.string().default(""),
    // AI 서버가 GPT로 초안을 만들어 응답할 때까지 기다리는 최대 시간 (기본 5분)
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    // 문서 생성 요청(DRAFT-01) 한 번에 보낼 수 있는 발화 글자 수 합계. AI 서버의 출력 토큰 상한(요청 전체 16,000)을 넘지 않게 막는다
    // 기본 100,000자. AI 담당자와 시험하면서 조정
    AI_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(100_000),
    // 지식 문서 AI 검색 (2026-11-17). AI 서버 ai.env의 AI_ENABLE_SEARCH=true와 같이 켠다. 꺼져 있으면 검색 API는 503, 색인 동기화도 안 보낸다
    AI_SEARCH_ENABLED: z.stringbool().default(false),
    // AI 검색 요청 하나를 기다리는 최대 시간. AI 서버가 모델 호출에 280초 예산을 쓰므로 기본 5분 (Nginx proxy_read_timeout도 이보다 길게)
    AI_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    // 문서 수정·삭제·채택 뒤 색인 동기화를 미뤘다 보내는 시간. 연달아 고치면 마지막 한 번만 보낸다
    AI_SEARCH_SYNC_DELAY_MS: z.coerce.number().int().min(0).default(3_000),
    // 문서 관계도 (2026-11-17). AI 서버 ai.env의 AI_ENABLE_RELATIONS=true와 같이 켠다. 꺼져 있으면 관계도 API는 503, 관계도 동기화도 안 보낸다
    AI_RELATIONS_ENABLED: z.stringbool().default(false),
    // 관계도 요청 하나를 기다리는 최대 시간. 처음 계산(임베딩)은 AI 서버가 280초 예산을 쓰므로 기본 5분
    AI_RELATIONS_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    // 문서 수정·삭제·채택 뒤 관계도 동기화를 미뤘다 보내는 시간. 연달아 고치면 마지막 한 번만 보낸다
    AI_RELATIONS_SYNC_DELAY_MS: z.coerce.number().int().min(0).default(3_000),
});

export const env = envSchema.parse(process.env);
