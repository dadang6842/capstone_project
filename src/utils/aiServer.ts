import { env } from "../config/env.js";

const TIMEOUT_MS = 10_000;

// AI 서버로 보내는 요청. AI 서버는 접수만 하고 바로 응답하고, 결과는 나중에 콜백(AI-02·AI-04)으로 준다
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

export type RevisionBase = {
    title: string | null;
    category: string | null;
    summary: string | null;
    keywords: string[];
    content: string | null;
};

// AI-03: AI 보완(새 회차) 생성 요청. 기준 회차 내용과 보완 항목, 남아 있는 원본 대화를 보낸다
export function requestRevision(
    draftId: number,
    previousDraft: RevisionBase,
    reasons: string[],
    conversations: AnalysisConversation[],
) {
    return post("/revisions", { draftId, previousDraft, reasons, conversations });
}
