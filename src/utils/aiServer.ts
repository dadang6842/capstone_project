import { env } from "../config/env.js";

const TIMEOUT_MS = 10_000;

// AI 서버로 보내는 요청. 결과는 나중에 콜백(AI-02)으로 준다
async function post(path: string, body: unknown) {
    if (!env.AI_SERVER_URL) throw new Error("AI_SERVER_URL이 설정되지 않았습니다.");

    const res = await fetch(`${env.AI_SERVER_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Api-Key": env.INTERNAL_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`AI 서버 응답 ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export type AnalysisConversation = {
    conversationId: number;
    url: string;
    filename: string;
    contentType: string | null;
};

// AI-01: 첫 초안용 대화 분석 요청
export function requestAnalysis(documentId: number, conversations: AnalysisConversation[]) {
    return post("/analyses", { documentId, conversations });
}
