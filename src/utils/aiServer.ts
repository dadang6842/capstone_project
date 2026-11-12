import { z } from "zod";
import { env } from "../config/env.js";

// AI 서버 연동 (2026-11-12 구조 변경): AI 서버가 GPT에 전처리부터 초안 작성까지 맡기고, 결과를 HTTP 응답으로 바로 돌려준다.
// 콜백(AI-02·AI-04)은 없다. GPT 응답을 기다리느라 오래 걸려서 백엔드는 사용자 요청에는 먼저 응답하고 뒤에서 기다린다.

// AI 서버가 돌려주는 초안 (AI-01·AI-03 공용, 제목·유형·요약·키워드·본문)
const draftResultSchema = z.object({
    title: z.string().trim().min(1).max(255),
    category: z.enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]),
    summary: z.string().trim().max(512),
    keywords: z
        .array(z.string().trim().min(1).max(50))
        .max(10)
        // DB UNIQUE(대소문자 무시)와 부딪히지 않게 같은 키워드는 하나만 (DOC-03과 같은 규칙)
        .transform((keywords) =>
            keywords.filter((k, i) => keywords.findIndex((o) => o.toLowerCase() === k.toLowerCase()) === i),
        ),
    content: z.string().min(1),
});
const responseSchema = z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), result: draftResultSchema }),
    z.object({ success: z.literal(false), errorMessage: z.string().nullish() }),
]);

export type DraftResult = z.infer<typeof draftResultSchema>;

// AI 서버 요청이 실패한 이유. 초안 fail_reason과 로그에 쓴다
//  - REQUEST_FAILED: 주소 미설정, 연결 실패, HTTP 에러 응답
//  - TIMEOUT: AI_TIMEOUT_MS 안에 응답이 없음
//  - GENERATION_FAILED: AI 서버가 success: false로 응답 (GPT 오류 등)
//  - INVALID_RESPONSE: 응답 JSON 형식이 맞지 않음
export class AiServerError extends Error {
    constructor(
        public readonly kind: "REQUEST_FAILED" | "TIMEOUT" | "GENERATION_FAILED" | "INVALID_RESPONSE",
        message: string,
    ) {
        super(message);
        this.name = "AiServerError";
    }
}

async function post(path: string, body: unknown): Promise<DraftResult> {
    if (!env.AI_SERVER_URL) throw new AiServerError("REQUEST_FAILED", "AI_SERVER_URL이 설정되지 않았습니다.");

    let res: Response;
    try {
        res = await fetch(`${env.AI_SERVER_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Api-Key": env.INTERNAL_API_KEY },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
        });
    } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
            throw new AiServerError("TIMEOUT", `${env.AI_TIMEOUT_MS}ms 안에 응답이 없음`);
        }
        throw new AiServerError("REQUEST_FAILED", err instanceof Error ? err.message : String(err));
    }
    const text = await res.text();
    if (!res.ok) throw new AiServerError("REQUEST_FAILED", `AI 서버 응답 ${res.status}: ${text.slice(0, 200)}`);

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new AiServerError("INVALID_RESPONSE", `JSON이 아닌 응답: ${text.slice(0, 200)}`);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new AiServerError("INVALID_RESPONSE", parsed.error.message.slice(0, 500));
    if (!parsed.data.success)
        throw new AiServerError("GENERATION_FAILED", parsed.data.errorMessage ?? "AI 서버가 실패로 응답");
    return parsed.data.result;
}

// 분석할 대화 본문을 요청에 직접 담아 보낸다 (AI 서버는 DB에 접근하지 않음)
// messages는 수집 모듈의 to_source_blocks 형식(source_id, role, text)을 camelCase로 맞춘 것
export type AnalysisConversation = {
    conversationId: number;
    title: string | null;
    messages: { sourceId: string; role: "USER" | "ASSISTANT"; text: string }[];
};

// AI-01: 첫 초안 생성. 응답으로 초안을 받는다
export function requestAnalysis(documentId: number, conversations: AnalysisConversation[]) {
    return post("/analyses", { documentId, conversations });
}

export type RevisionBase = {
    title: string | null;
    category: string | null;
    summary: string | null;
    keywords: string[];
    content: string | null;
};

// AI-03: AI 보완(새 회차) 생성. 기준 회차 내용과 보완 항목, 남아 있는 원본 대화를 보내고 응답으로 새 초안을 받는다
export function requestRevision(
    draftId: number,
    previousDraft: RevisionBase,
    reasons: string[],
    conversations: AnalysisConversation[],
) {
    return post("/revisions", { draftId, previousDraft, reasons, conversations });
}

// 대화 + 발화를 AI 서버 요청 형식으로 바꾼다 (AI-01·AI-03 공용)
export function toAnalysisConversation(conversation: {
    conversationId: bigint;
    title: string | null;
    messages: { sourceMessageId: string; role: "USER" | "ASSISTANT"; content: string }[];
}): AnalysisConversation {
    return {
        conversationId: Number(conversation.conversationId),
        title: conversation.title,
        messages: conversation.messages.map(({ sourceMessageId, role, content }) => ({
            sourceId: sourceMessageId,
            role,
            text: content,
        })),
    };
}
