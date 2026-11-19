import { z } from "zod";
import { env } from "../config/env.js";

// AI 서버 연동 (2026-11-12 구조 변경): AI 서버가 GPT에 전처리부터 초안 작성까지 맡기고, 결과를 HTTP 응답으로 바로 돌려준다.
// 콜백(AI-02·AI-04)은 없다. GPT 응답을 기다리느라 오래 걸려서 백엔드는 사용자 요청에는 먼저 응답하고 뒤에서 기다린다.
// 성공·실패는 HTTP 상태 코드로 구분한다: 200 = 결과, 502 = GPT 생성 실패({ errorMessage }), 그 밖의 에러 = AI 서버 문제
// 2026-11-15 지식 분할 저장: 첫 생성(AI-01)은 /v2/analyses로 바뀌어 한 요청에서 문서 여러 편을 받는다.
// 2026-11-18 AI 보완(AI-03 /revisions): AI 담당의 revisions.py로 실제 구현됨. 응답에 contentHash·sourceLinks·sourceLinksStatus·reviewStatus가 붙는다

// 문서 1편의 기본 5개 필드 (AI-01 v2 문서·AI-03 보완 결과 공용, 제목·유형·요약·키워드·본문)
const draftFields = {
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
};

// AI-03이 돌려주는 보완본 1편: 기본 5개 필드만 검사하고, 추가 필드(contentHash·sourceLinks·sourceLinksStatus·reviewStatus)는
// AI-01 문서와 똑같이 검사하지 않고 받은 그대로 새 회차의 drafts.ai_detail에 저장한다 (DRAFT-02가 sourceLinks를 골라서 보여 준다)
const revisionResultSchema = z.looseObject(draftFields);

// AI-01(v2) 응답의 문서 1편: 기본 5개 필드 + artifactId만 검사하고, 나머지(review·sourceLinks·metadata·해시·상태 등)는
// 형식이 아직 바뀔 수 있어서 검사하지 않고 받은 그대로 drafts.ai_detail에 저장한다
const analysisDocumentSchema = z.looseObject({
    artifactId: z.string().min(1).max(64),
    ...draftFields,
});

// AI-01(v2) 응답 전체
const analysisResultSchema = z.looseObject({
    runId: z.string().min(1),
    status: z.enum(["drafts_stored", "no_content"]),
    noDocumentReason: z.string().nullish(),
    // pending = AI 서버가 검토 도중 멈춘 결과 (초안은 정상)
    reviewStatus: z.enum(["completed", "incomplete", "pending", "not_applicable"]),
    reviewError: z.looseObject({ message: z.string(), detail: z.string().nullish() }).nullish(),
    documents: z.array(analysisDocumentSchema),
});

export type RevisionResult = z.infer<typeof revisionResultSchema>;
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type AnalysisDocument = z.infer<typeof analysisDocumentSchema>;

// AI 서버 요청이 실패한 이유. 초안·생성 요청의 fail_reason과 로그에 쓴다
//  - REQUEST_FAILED: 주소 미설정, 연결 실패, 502가 아닌 HTTP 에러 응답 (AI 서버 자체 문제, 401·409·422 포함)
//  - TIMEOUT: AI_TIMEOUT_MS 안에 응답이 없음
//  - GENERATION_FAILED: AI 서버가 502로 응답 (GPT 오류 등)
//  - INVALID_RESPONSE: 200인데 본문 형식이 맞지 않음
export class AiServerError extends Error {
    constructor(
        public readonly kind: "REQUEST_FAILED" | "TIMEOUT" | "GENERATION_FAILED" | "INVALID_RESPONSE",
        message: string,
    ) {
        super(message);
        this.name = "AiServerError";
    }
}

// 에러 응답에서 사람이 읽을 메시지를 꺼낸다
//  - 502: { errorMessage }
//  - 401·409·422: { detail } (422는 문자열일 때도, FastAPI 검사 결과 배열일 때도 있음)
function errorText(json: unknown, text: string) {
    if (json && typeof json === "object") {
        const { errorMessage, detail } = json as { errorMessage?: unknown; detail?: unknown };
        if (typeof errorMessage === "string") return errorMessage;
        if (typeof detail === "string") return detail;
        if (detail !== undefined) return JSON.stringify(detail);
    }
    return text;
}

// AI 서버에 POST로 보내고 200 본문(JSON)을 돌려준다. 실패는 AiServerError로 던진다
async function post(path: string, body: unknown): Promise<unknown> {
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
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }

    // 502 + { errorMessage }만 GPT 실패로 본다. 본문이 다르면 프록시(Nginx 등)가 낸 502일 수 있어서 AI 서버 문제로 둔다
    const isGenerationFailure =
        res.status === 502 &&
        !!json &&
        typeof json === "object" &&
        typeof (json as { errorMessage?: unknown }).errorMessage === "string";
    if (isGenerationFailure) throw new AiServerError("GENERATION_FAILED", errorText(json, text));
    if (res.status !== 200) {
        throw new AiServerError("REQUEST_FAILED", `AI 서버 응답 ${res.status}: ${errorText(json, text).slice(0, 500)}`);
    }

    if (json === undefined) throw new AiServerError("INVALID_RESPONSE", `JSON이 아닌 응답: ${text.slice(0, 200)}`);
    return json;
}

function parse<T extends z.ZodType>(schema: T, json: unknown): z.infer<T> {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AiServerError("INVALID_RESPONSE", parsed.error.message.slice(0, 500));
    return parsed.data;
}

// AI-01(/v2/analyses)·AI-03(/revisions)에 보내는 대화 형식. 발화에 codeBlocks가 붙는다 (코드가 없으면 필드 자체를 뺀다. null을 보내면 AI가 422)
export type AnalysisConversationV2 = {
    conversationId: number;
    title: string | null;
    messages: { sourceId: string; role: "USER" | "ASSISTANT"; text: string; codeBlocks?: string[] }[];
};

// AI-01: 지식 문서 생성 (v2). 응답으로 문서 여러 편(또는 남길 내용 없음)을 받는다.
// documentId 자리에는 생성 요청 번호(재시도 묶음의 첫 generationId)를 보낸다 (문서는 응답을 받은 뒤 만들어서)
export async function requestAnalysis(
    documentId: number,
    conversations: AnalysisConversationV2[],
): Promise<AnalysisResult> {
    return parse(analysisResultSchema, await post("/v2/analyses", { documentId, conversations }));
}

export type RevisionBase = {
    title: string | null;
    category: string | null;
    summary: string | null;
    keywords: string[];
    content: string | null;
};

// AI-03: AI 보완(새 회차) 생성. 기준 회차 내용과 보완 항목, 남아 있는 원본 대화를 보내고 응답으로 보완본 한 편을 받는다.
// draftId는 이번 보완에 새로 만든 회차의 id다. 보완 항목을 둘 다 골라도 요청은 한 번, 결과도 한 편이다
export async function requestRevision(
    draftId: number,
    previousDraft: RevisionBase,
    reasons: string[],
    conversations: AnalysisConversationV2[],
): Promise<RevisionResult> {
    return parse(revisionResultSchema, await post("/revisions", { draftId, previousDraft, reasons, conversations }));
}

type MessageRow = { sourceMessageId: string; role: "USER" | "ASSISTANT"; content: string; codeBlocks?: unknown };
type ConversationRow = { conversationId: bigint; title: string | null; messages: MessageRow[] };

// 대화 + 발화를 AI-01(v2)·AI-03 요청 형식으로 바꾼다.
// AI 서버는 본문이 빈 발화나 발화가 0개인 대화가 있으면 422로 거절해서, 빈 발화는 빼고 남는 발화가 없는 대화도 뺀다
export function toAnalysisConversationsV2(conversations: ConversationRow[]): AnalysisConversationV2[] {
    return conversations
        .map((conversation) => ({
            conversationId: Number(conversation.conversationId),
            title: conversation.title,
            messages: conversation.messages
                .filter(({ content }) => content.trim().length > 0)
                .map(({ sourceMessageId, role, content, codeBlocks }) => {
                    const codes = Array.isArray(codeBlocks)
                        ? codeBlocks.filter(
                              (code): code is string => typeof code === "string" && code.trim().length > 0,
                          )
                        : [];
                    return {
                        sourceId: sourceMessageId,
                        role,
                        text: content,
                        ...(codes.length > 0 && { codeBlocks: codes }),
                    };
                }),
        }))
        .filter((conversation) => conversation.messages.length > 0);
}

// AI-01(v2) 입력 크기 (발화 본문 글자 수 합계). AI 서버의 출력 토큰 상한(요청 전체 16,000)을 넘지 않게 DRAFT-01에서 막는 데 쓴다
export function countInputChars(conversations: AnalysisConversationV2[]) {
    return conversations.reduce(
        (sum, { messages }) => sum + messages.reduce((acc, { text }) => acc + text.length, 0),
        0,
    );
}

// AI 서버 오류를 fail_reason과 로그 코드로 바꾼다 (AI-01·AI-03 공용)
export function describeAiError(err: unknown, generationFailReason: "GENERATION_FAILED" | "REVISION_FAILED") {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof AiServerError))
        return { failReason: generationFailReason, logCode: "AI_SERVER_REQUEST_FAILED" as const, message };
    switch (err.kind) {
        case "TIMEOUT":
            return { failReason: "TIMEOUT" as const, logCode: "AI_SERVER_REQUEST_FAILED" as const, message };
        case "INVALID_RESPONSE":
            return { failReason: "INVALID_RESPONSE" as const, logCode: "AI_INVALID_RESPONSE" as const, message };
        case "GENERATION_FAILED":
            return { failReason: generationFailReason, logCode: "AI_GENERATION_FAILED" as const, message };
        default:
            return { failReason: generationFailReason, logCode: "AI_SERVER_REQUEST_FAILED" as const, message };
    }
}
