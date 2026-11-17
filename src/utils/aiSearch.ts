import { z } from "zod";
import { env } from "../config/env.js";

// 지식 문서 AI 검색 연동 (2026-11-17, AI 서버 knowledge_search 모듈)
// 생성(aiServer.ts)과 달리 검색은 사용자가 응답을 기다리는 동기 요청이고, AI 서버의 409·404를 그대로 구분해야 해서 따로 둔다.
// AI 서버는 백엔드를 콜백하지 않는다. ownerId는 백엔드가 확정한 검색 범위(개인·팀)이고, 사용자 권한 확인은 백엔드가 먼저 한다

// AI 서버 검색 요청 실패. status는 AI 서버 HTTP 상태 (연결 실패·시간 초과·주소 미설정이면 null)
//  - 401 내부 키 불일치, 404 검색 기록 없음, 409 같은 범위 작업 중·지난 스냅샷·지난 resultRevision·색인 미완료,
//    413 동기화 요청 8MB 초과, 422 입력 형식, 502 색인 생성(임베딩) 실패
export class AiSearchError extends Error {
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "AiSearchError";
  }
}

// 색인 동기화에 보내는 문서 1편 (AI 서버 API_CONTRACT 1번). 채택(FINALIZED)·휴지통 밖 문서만 보낸다
export type SearchIndexDocument = {
  artifactId: string; // 백엔드 documents.document_id를 문자열로
  version: number;
  status: "adopted";
  title: string;
  content: string;
  contentHash: string;
  category: string | null;
  metadataStatus: "current" | "stale"; // stale이면 AI가 요약·키워드를 빼고 제목·본문만으로 검색한다
  metadata: null;
  summary: string | null;
  keywords: string[];
  sourceLinks: never[];
  sourceLinksStatus: "not_provided";
  sourceWarnings: never[];
};

const syncResultSchema = z.looseObject({
  indexStatus: z.literal("ready"),
  indexRevision: z.number().int(),
  snapshotId: z.string().min(1),
  searchableDocuments: z.number().int(),
  reused: z.boolean(),
});

// 검색·추가 탐색·페이지 이동 공통 응답. 백엔드가 쓰는 필드만 검사하고 나머지는 무시한다
const searchResultSchema = z.looseObject({
  searchId: z.string().min(1),
  resultRevision: z.number().int(),
  status: z.enum(["matches", "no_match", "no_documents", "in_progress", "incomplete"]),
  complete: z.boolean(),
  processedDocuments: z.number().int(),
  totalDocuments: z.number().int(),
  knownMatches: z.number().int(),
  totalMatches: z.number().int().nullable(),
  hasMoreCandidates: z.boolean(),
  page: z.number().int(),
  pageSize: z.number().int(),
  hasMore: z.boolean(),
  results: z.array(
    z.looseObject({
      artifactId: z.string(),
      title: z.string(),
      reason: z.string(),
      evidence: z.string(),
      evidenceStart: z.number().int(),
      strength: z.number().int(),
    }),
  ),
  errors: z.array(z.looseObject({ type: z.string(), message: z.string().optional() })).optional(),
});

export type AiSearchResult = z.infer<typeof searchResultSchema>;

// AI 서버에 POST로 보내고 200 본문을 검사해서 돌려준다. 실패는 AiSearchError로 던진다
async function post<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
  if (!env.AI_SERVER_URL) throw new AiSearchError(null, "AI_SERVER_URL이 설정되지 않았습니다.");

  let res: Response;
  try {
    res = await fetch(`${env.AI_SERVER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Api-Key": env.INTERNAL_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.AI_SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new AiSearchError(null, `${env.AI_SEARCH_TIMEOUT_MS}ms 안에 응답이 없음`);
    throw new AiSearchError(null, err instanceof Error ? err.message : String(err));
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (res.status !== 200) {
    // FastAPI 에러는 { detail } (422는 배열일 때도 있음)
    const detail = (json as { detail?: unknown } | undefined)?.detail;
    const message = typeof detail === "string" ? detail : detail !== undefined ? JSON.stringify(detail) : text;
    throw new AiSearchError(res.status, `${path} 응답 ${res.status}: ${message.slice(0, 500)}`);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AiSearchError(200, `${path} 응답 형식 오류: ${parsed.error.message.slice(0, 500)}`);
  return parsed.data;
}

// 검색 범위의 전체 문서 스냅샷을 보낸다. revision은 범위별로 커지는 번호 (같은 내용이면 같은 번호를 다시 쓰지 않게 호출하는 쪽에서 관리)
export function syncSearchIndex(ownerId: string, revision: number, documents: SearchIndexDocument[]) {
  return post("/v2/search-index/sync", { ownerId, revision, documents }, syncResultSchema);
}

// 새 검색. 앞 후보부터 maxNewBatches 배치만 LLM이 판단하고, 남은 후보는 continueSearch로 이어서 본다
export function startSearch(ownerId: string, snapshotId: string, query: string, pageSize: number) {
  return post("/v2/searches", { ownerId, snapshotId, query, maxNewBatches: 1, pageSize }, searchResultSchema);
}

// 남은 후보를 이어서 판단한다 (모델 비용 발생). 응답의 resultRevision이 1 커진다
export function continueSearch(ownerId: string, searchId: string, resultRevision: number, pageSize: number) {
  return post("/v2/searches/continue", { ownerId, searchId, resultRevision, maxNewBatches: 1, pageSize }, searchResultSchema);
}

// 이미 찾은 결과의 페이지만 옮긴다 (모델 호출 없음)
export function pageSearch(ownerId: string, searchId: string, resultRevision: number, page: number, pageSize: number) {
  return post("/v2/searches/page", { ownerId, searchId, resultRevision, page, pageSize }, searchResultSchema);
}