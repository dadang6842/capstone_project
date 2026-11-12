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
    COLLECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
    // 동시에 띄우는 Chromium 수. 하나에 메모리 200~500MB라 작은 EC2에서는 1
    COLLECTOR_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    // AI 서버 주소와 서버 간 인증 키. 아직 정해지지 않아서 비워 둘 수 있다 (비어 있으면 문서 생성이 바로 실패 처리됨)
    AI_SERVER_URL: z.string().default(""),
    INTERNAL_API_KEY: z.string().default(""),
    // AI 서버가 GPT로 초안을 만들어 응답할 때까지 기다리는 최대 시간 (기본 5분)
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
});

export const env = envSchema.parse(process.env);
