import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { searchRepository } from "../repositories/search.repository.js";
import { syncSearchIndex, type SearchIndexDocument } from "../utils/aiSearch.js";
import { logger } from "../utils/logger.js";
import type { SpaceFilter } from "./workspaceAccess.js";

// 지식 문서 AI 검색 색인 동기화 (2026-11-17)
//  - 검색 범위(ownerId)는 공간 단위: 개인 공간 "user:{회원 아이디}", 팀 공간 "workspace:{팀 아이디}". 팀 문서는 팀원 누구나 같은 색인으로 검색한다
//  - AI 서버에는 범위의 "전체" 최종 문서 스냅샷과 범위별로 커지는 revision을 보낸다 (부분 갱신 API가 아님)
//  - AI 서버는 같은 범위의 작업이 겹치면 409를 주므로, 한 범위의 동기화·검색은 이 프로세스 안에서 차례로 보낸다 (백엔드 컨테이너 1개 기준)
//  - 문서를 고친 뒤에는 잠깐 미뤘다가(AI_SEARCH_SYNC_DELAY_MS) 동기화하고, 검색 직전에도 한 번 더 확인해서 항상 최신 문서로 검색한다

export type SearchScope = { ownerId: string; filter: SpaceFilter };

export function toSearchScope(userId: number, workspaceId: bigint | null): SearchScope {
    return workspaceId === null
        ? { ownerId: `user:${userId}`, filter: { userId: BigInt(userId), workspaceId: null } }
        : { ownerId: `workspace:${workspaceId}`, filter: { workspaceId } };
}

// 범위별 마지막 동기화 상태 (메모리). 서버를 다시 켜면 비어서 첫 검색 때 새 revision으로 다시 동기화한다
// (같은 본문의 임베딩은 AI 서버가 재사용해서 비용은 거의 없고, 재시작 전 검색 기록은 다시 검색해야 한다)
const states = new Map<string, { revision: number; payloadHash: string | null; snapshotId: string | null }>();
const queues = new Map<string, Promise<unknown>>();
const timers = new Map<string, NodeJS.Timeout>();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// 같은 범위의 작업을 앞 작업이 끝난 뒤에 실행한다 (앞 작업이 실패해도 다음 작업은 실행)
export function runExclusive<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    const next = (queues.get(ownerId) ?? Promise.resolve()).catch(() => undefined).then(task);
    queues.set(ownerId, next);
    next.finally(() => {
        if (queues.get(ownerId) === next) queues.delete(ownerId);
    }).catch(() => undefined);
    return next;
}

// 범위의 현재 최종 문서를 AI 서버 색인 형식으로 바꾼다
async function buildSnapshot(filter: SpaceFilter): Promise<SearchIndexDocument[]> {
    const documents = await searchRepository.findSnapshot(filter);
    return (
        documents
            // AI 서버는 제목·본문이 빈 문서가 하나라도 있으면 동기화 전체를 거절해서(422) 본문 없는 문서는 뺀다
            .filter((document) => (document.content ?? "").trim().length > 0)
            .map((document) => {
                const content = document.content as string;
                // 채택 뒤 직접 수정·복원한 문서는 요약이 본문과 어긋날 수 있어서 stale로 보내 제목·본문만으로 검색하게 한다
                const edited = document.versions.some(({ source }) => source !== "ACCEPTED");
                return {
                    artifactId: String(document.documentId),
                    version: document.versions[0]?.versionNo ?? 1,
                    status: "adopted" as const,
                    title: document.title?.trim() || "제목 없음",
                    content,
                    contentHash: sha256(content),
                    category: document.category,
                    metadataStatus: edited ? ("stale" as const) : ("current" as const),
                    metadata: null,
                    summary: document.summary,
                    keywords: document.keywords.map(({ keyword }) => keyword),
                    sourceLinks: [],
                    sourceLinksStatus: "not_provided" as const,
                    sourceWarnings: [],
                };
            })
    );
}

// 범위의 색인을 최신 문서로 맞추고 snapshotId를 돌려준다. 바뀐 게 없으면 AI 서버를 부르지 않는다.
// 반드시 runExclusive 안에서 부른다
export async function syncLocked(scope: SearchScope): Promise<string> {
    const documents = await buildSnapshot(scope.filter);
    const payloadHash = sha256(JSON.stringify(documents));
    const state = states.get(scope.ownerId);
    if (state?.payloadHash === payloadHash && state.snapshotId) return state.snapshotId;

    // revision은 커지기만 하면 된다. 별도 테이블 없이 현재 시각(ms)을 쓰고, 같은 ms에 두 번 보내면 +1
    const revision = Math.max(Date.now(), (state?.revision ?? 0) + 1);
    states.set(scope.ownerId, { revision, payloadHash: null, snapshotId: null });
    const result = await syncSearchIndex(scope.ownerId, revision, documents);
    states.set(scope.ownerId, { revision, payloadHash, snapshotId: result.snapshotId });
    return result.snapshotId;
}

function scheduleSync(scope: SearchScope) {
    clearTimeout(timers.get(scope.ownerId));
    const timer = setTimeout(() => {
        timers.delete(scope.ownerId);
        runExclusive(scope.ownerId, () => syncLocked(scope)).catch((err) => {
            // 실패해도 다음 검색 직전에 다시 동기화한다
            logger.error(
                "AI_SEARCH_REQUEST_FAILED",
                `색인 동기화 실패: ${err instanceof Error ? err.message : String(err)}`,
                { ownerId: scope.ownerId },
            );
        });
    }, env.AI_SEARCH_SYNC_DELAY_MS);
    timer.unref();
    timers.set(scope.ownerId, timer);
}

// 문서를 수정·삭제·채택·복원한 뒤 부른다 (await 하지 않음). 그 문서가 속한 공간의 색인 동기화를 예약한다
//  - 최종 문서가 아니게 됐거나(휴지통) 다시 최종 문서가 된 경우(복원)도 공간 전체 스냅샷을 다시 보내서 반영된다
//  - 사용자 응답과 상관없이 뒤에서 돌고, 실패는 로그만 남긴다
export async function touchSearchIndex(documentIds: bigint[]): Promise<void> {
    if (!env.AI_SEARCH_ENABLED || documentIds.length === 0) return;
    try {
        const spaces = await searchRepository.findSpaces(documentIds);
        const scopes = new Map<string, SearchScope>();
        for (const { userId, workspaceId } of spaces) {
            // 생성 요청자가 탈퇴로 영구 삭제된 개인 문서는 검색할 사람이 없다
            if (workspaceId === null && userId === null) continue;
            const scope = toSearchScope(Number(userId), workspaceId);
            scopes.set(scope.ownerId, scope);
        }
        scopes.forEach(scheduleSync);
    } catch (err) {
        logger.error(
            "AI_SEARCH_REQUEST_FAILED",
            `색인 동기화 예약 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
