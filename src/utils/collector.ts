import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";

// 공유 대화 수집 모듈(collector/collect.py, Python + Playwright)을 자식 프로세스로 실행한다.
// collect.py는 stdout에 JSON 한 줄만 쓴다. 성공이면 제목·발화 목록, 실패면 원인 코드.
// Chromium을 띄우는 무거운 작업이라 동시에 COLLECTOR_CONCURRENCY개까지만 돌리고 나머지는 차례를 기다린다.

const COLLECTOR_DIR = path.resolve("collector"); // 서버는 프로젝트 루트(/app)에서 실행한다
const MAX_OUTPUT = 50 * 1024 * 1024; // stdout 50MB 넘으면 중단 (비정상 출력 방지)
// COLLECTOR_PYTHON이 collector/.venv/bin/python 같은 상대 경로면 프로젝트 루트 기준 절대 경로로 바꾼다
// (Python은 cwd를 collector/로 두고 실행해서, 상대 경로를 그대로 쓰면 collector/collector/...를 찾게 됨)
// python3처럼 경로 구분자가 없는 이름은 PATH에서 찾도록 그대로 둔다
const PYTHON = /[\\/]/.test(env.COLLECTOR_PYTHON) ? path.resolve(env.COLLECTOR_PYTHON) : env.COLLECTOR_PYTHON;

const collectedSchema = z.object({
  ok: z.literal(true),
  captureId: z.string().min(1).max(80),
  title: z.string().nullable(),
  messages: z
    .array(
      z.object({
        sourceMessageId: z.string().min(1).max(100),
        role: z.enum(["USER", "ASSISTANT"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
});
const failedSchema = z.object({
  ok: z.literal(false),
  code: z.enum(["NOT_ACCESSIBLE", "UNSUPPORTED_CONTENT", "TIMEOUT", "COLLECT_ERROR", "INVALID_URL"]),
  message: z.string(),
});

export type CollectedConversation = z.infer<typeof collectedSchema>;
export type CollectFailCode = "NOT_ACCESSIBLE" | "UNSUPPORTED_CONTENT" | "TIMEOUT" | "COLLECT_ERROR";

// 수집 실패. code는 conversations.collect_fail_reason에 저장하고, message는 로그에만 남긴다
export class CollectError extends Error {
  constructor(
    public readonly code: CollectFailCode,
    message: string,
  ) {
    super(message);
    this.name = "CollectError";
  }
}

// 간단한 동시 실행 제한 (서버 프로세스 1개 기준. 서버가 재시작되면 대기열은 사라진다)
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= env.COLLECTOR_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function runOnce(shareUrl: string): Promise<CollectedConversation> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["collect.py", shareUrl], {
      cwd: COLLECTOR_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      // 리눅스·맥에서는 새 프로세스 그룹으로 띄워서, 시간 초과 때 Python과 Chromium을 한 번에 끝낸다
      detached: process.platform !== "win32",
    });
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // 이미 끝난 프로세스
      }
    };

    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, env.COLLECTOR_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000); // 마지막 2000자만 (로그용)
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CollectError("COLLECT_ERROR", `Python 실행 실패 (${PYTHON}): ${err.message}`));
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) return reject(new CollectError("TIMEOUT", `${env.COLLECTOR_TIMEOUT_MS}ms 안에 끝나지 않음`));

      const lastLine = Buffer.concat(chunks).toString("utf8").trim().split("\n").pop() ?? "";
      let output: unknown;
      try {
        output = JSON.parse(lastLine);
      } catch {
        return reject(new CollectError("COLLECT_ERROR", `수집 결과를 읽지 못함 (exit ${exitCode}): ${stderr.trim()}`));
      }

      const collected = collectedSchema.safeParse(output);
      if (collected.success) return resolve(collected.data);

      const failed = failedSchema.safeParse(output);
      if (failed.success) {
        // INVALID_URL은 백엔드가 미리 검사해서 나오지 않아야 한다. 나오면 기타 오류로 본다
        const code = failed.data.code === "INVALID_URL" ? "COLLECT_ERROR" : failed.data.code;
        return reject(new CollectError(code, failed.data.message));
      }
      reject(new CollectError("COLLECT_ERROR", `수집 결과 형식이 맞지 않음: ${collected.error.message.slice(0, 300)}`));
    });
  });
}

export function collectSharedConversation(shareUrl: string) {
  return withSlot(() => runOnce(shareUrl));
}
