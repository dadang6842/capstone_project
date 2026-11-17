import { z } from "zod";
import { env } from "../config/env.js";

// 문서 관계도 연동 (2026-11-17, AI 서버 knowledge_relations 모듈)
// 검색(aiSearch.ts)처럼 사용자가 응답을 기다리는 동기 요청이다. AI 서버는 백엔드를 콜백하지 않는다.
// ownerId는 백엔드가 확정한 공간(개인·팀)이고, 사용자 권한 확인은 백엔드가 먼저 한다

// AI 서버 관계도 요청 실패. status는 AI 서버 HTTP 상태 (연결 실패·시간 초과·주소 미설정이면 null), code는 AI 서버 detail.code
//  - 401 내부 키 불일치, 404 RELATION_INDEX_NOT_FOUND(동기화 전), 409 OWNER_BUSY·STALE_REVISION·REVISION_CONFLICT·
//    DOCUMENT_VERSION_ROLLBACK·DOCUMENT_VERSION_CONFLICT·RELATION_INDEX_NOT_READY·STALE_SNAPSHOT,
//    413 SNAPSHOT_TOO_LARGE·TOO_MANY_DOCUMENTS·TOO_MANY_CHUNKS, 422 입력 형식, 502 RELATION_SYNC_FAILED(임베딩 실패)
export class AiRelationsError extends Error {
    constructor(
        public readonly status: number | null,
        public readonly code: string | null,
        message: string,
    ) {
        super(message);
        this.name = "AiRelationsError";
    }
}

// 관계도 동기화에 보내는 문서 1편 (AI 서버 API_CONTRACT 1번). 채택(FINALIZED)·휴지통 밖 문서만 보낸다
export type RelationIndexDocument = {
    artifactId: string; // 백엔드 documents.document_id를 문자열로
    version: number; // 제목·본문이 바뀔 때마다 커지는 번호 (지식 문서 저장 이력 번호로 만든다)
    status: "adopted";
    title: string;
    content: string;
};

const syncResultSchema = z.looseObject({
    indexStatus: z.literal("ready"),
    indexRevision: z.number().int(),
    snapshotId: z.string().min(1),
    reused: z.boolean(),
});

// 관계도 응답. 백엔드가 쓰는 필드만 검사하고 나머지는 무시한다
const graphSchema = z.looseObject({
    snapshotId: z.string(),
    counts: z.object({
        documents: z.number().int(),
        edges: z.number().int(),
        groups: z.number().int(),
        isolates: z.number().int(),
    }),
    nodes: z.array(
        z.looseObject({
            artifactId: z.string(),
            version: z.number().int(),
            title: z.string(),
            groupId: z.string().nullable(),
            degree: z.number().int(),
        }),
    ),
    edges: z.array(
        z.looseObject({
            sourceId: z.string(),
            targetId: z.string(),
            similarity: z.number(),
            passageSimilarity: z.number(),
            similarPassages: z.array(z.looseObject({ artifactId: z.string(), text: z.string() })),
        }),
    ),
});

export type AiRelationGraph = z.infer<typeof graphSchema>;

// AI 서버에 POST로 보내고 200 본문을 검사해서 돌려준다. 실패는 AiRelationsError로 던진다
async function post<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
    if (!env.AI_SERVER_URL) throw new AiRelationsError(null, null, "AI_SERVER_URL이 설정되지 않았습니다.");

    let res: Response;
    try {
        res = await fetch(`${env.AI_SERVER_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Api-Key": env.INTERNAL_API_KEY },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(env.AI_RELATIONS_TIMEOUT_MS),
        });
    } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError")
            throw new AiRelationsError(null, null, `${env.AI_RELATIONS_TIMEOUT_MS}ms 안에 응답이 없음`);
        throw new AiRelationsError(null, null, err instanceof Error ? err.message : String(err));
    }

    const text = await res.text();
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    if (res.status !== 200) {
        // 모듈 오류는 { detail: { code, message } }, FastAPI 입력 검증 422는 { detail: [...] }
        const detail = (json as { detail?: unknown } | undefined)?.detail;
        const code =
            detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string"
                ? detail.code
                : null;
        const message = typeof detail === "string" ? detail : detail !== undefined ? JSON.stringify(detail) : text;
        throw new AiRelationsError(res.status, code, `${path} 응답 ${res.status}: ${message.slice(0, 500)}`);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success)
        throw new AiRelationsError(200, null, `${path} 응답 형식 오류: ${parsed.error.message.slice(0, 500)}`);
    return parsed.data;
}

// 공간의 전체 문서 목록을 보낸다 (부분 갱신 아님). revision은 공간별로 커지는 번호
export function syncRelationIndex(ownerId: string, revision: number, documents: RelationIndexDocument[]) {
    return post("/v2/relation-index/sync", { ownerId, revision, documents }, syncResultSchema);
}

// 동기화 응답의 snapshotId로 완성된 관계도를 받는다 (모델 호출 없음)
export function fetchRelationGraph(ownerId: string, snapshotId: string) {
    return post("/v2/relations", { ownerId, snapshotId }, graphSchema);
}
