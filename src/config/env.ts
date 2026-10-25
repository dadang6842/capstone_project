import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(1),
    JWT_REFRESH_SECRET: z.string().min(1),
    LOG_DIR: z.string().default("logs"),
    AWS_REGION: z.string().default("ap-northeast-2"),
    S3_BUCKET: z.string().min(1),
});

export const env = envSchema.parse(process.env);
