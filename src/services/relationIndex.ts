import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import type { Category } from "../generated/prisma/client.js";
import { searchRepository } from "../repositories/search.repository.js";
import { syncRelationIndex, type RelationIndexDocument } from "../utils/aiRelations.js";
import { logger } from "../utils/logger.js";
import { runExclusive, toSearchScope, type SearchScope } from "./searchIndex.js";

// 문서 관계도 동기화 (2026-11-17, AI 서버 knowledge_relations)
//  - 범위(ownerId)는 검색과 같은 공간 단위: 개인 공간 "user:{회원 아이디}", 팀 공간 "workspace:{팀 아이디}".
//    AI 담당 문서의 "사용자별 최신 전체 문서 목록"을 "공간별 최신 전체 문서 목록"으로 보낸다 (문서 목록·검색이 공간 단위라서)
//  - 대상 문서도 검색과 같다: 휴지통 밖 최종(FINALIZED) 문서, 본문 있는 것만. 그래서 검색 스냅샷 조회(searchRepository.findSnapshot)를 같이 쓴다
//  - 검색 색인과는 별개다. 상태·순서 큐·디바운스를 따로 두고, 한쪽 실패가 다른 쪽에 영향을 주지 않는다
//  - AI 서버는 같은 공간 작업이 겹치면 409(OWNER_BUSY)라서 이 프로세스 안에서 공간별로 차례로 보낸다 (백엔드 컨테이너 1개 기준).
//    큐 키는 "relations:{ownerId}"로 검색 큐와 나눠서, 관계도 계산이 검색을 기다리게 하지 않는다

export type RelationScope = SearchScope;
export const toRelationScope = toSearchScope;

// 공간별 마지막 동기화 상태 (메모리). 서버를 다시 켜면 비어서 첫 관계도 요청 때 새 revision으로 다시 보낸다
// (같은 제목·본문 조각의 임베딩은 AI 서버 캐시를 재사용해서 비용은 거의 없다)
const states = new Map<string, { revision: number; payloadHash: string | null; snapshotId: string | null }>();
const timers = new Map<string, NodeJS.Timeout>();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function runRelationExclusive<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    return runExclusive(`relations:${ownerId}`, task);
}

// 문서 version = 지식 문서 저장 이력(draft_id NULL)의 가장 큰 번호.
// 채택(ACCEPTED)이 1번이고, 직접 수정(MANUAL_SAVE)·버전 복원(RESTORE)마다 이력이 1줄씩 늘어서 제목·본문이 바뀌면 항상 커진다.
// 저장 이력이 생기기 전(2026-11-13 이전)에 채택한 문서는 ACCEPTED 줄이 없어서 이력이 없으면 1, 첫 수정 이력(번호 1)부터는 +1 한다
// (안 그러면 "채택 때 본문 = 1", "첫 수정 본문 = 1"이 되어 AI 서버가 409 DOCUMENT_VERSION_CONFLICT로 공간 전체 동기화를 거절한다)
export function toDocumentVersion(versions: { versionNo: number; source: string }[]): number {
    const latest = versions[0]?.versionNo ?? 0;
    const hasAccepted = versions.some(({ source }) => source === "ACCEPTED");
    return hasAccepted ? Math.max(latest, 1) : latest + 1;
}

// 공간의 현재 최종 문서를 AI 서버 형식으로 바꾼다. 화면에 쓸 유형(category)도 같이 돌려준다
async function buildSnapshot(scope: RelationScope) {
    const rows = (await searchRepository.findSnapshot(scope.filter))
        // AI 서버는 채택 문서 본문이 비어 있으면 동기화 전체를 거절해서(422) 본문 없는 문서는 뺀다
        .filter((document) => (document.content ?? "").trim().length > 0);
    const documents: RelationIndexDocument[] = rows.map((document) => ({
        artifactId: String(document.documentId),
        version: toDocumentVersion(document.versions),
        status: "adopted",
        title: document.title?.trim() || "제목 없음",
        content: document.content as string,
    }));
    const categories = new Map<string, Category | null>(
        rows.map((document) => [String(document.documentId), document.category]),
    );
    return { documents, categories };
}

// 공간의 관계도를 최신 문서로 맞추고 snapshotId를 돌려준다. 바뀐 게 없으면 AI 서버를 부르지 않는다.
// 반드시 runRelationExclusive 안에서 부른다
export async function syncRelationsLocked(scope: RelationScope) {
    const { documents, categories } = await buildSnapshot(scope);
    const payloadHash = sha256(JSON.stringify(documents));
    const state = states.get(scope.ownerId);
    if (state?.payloadHash === payloadHash && state.snapshotId) return { snapshotId: state.snapshotId, categories };

    // revision은 커지기만 하면 된다. 별도 테이블 없이 현재 시각(ms)을 쓰고, 같은 ms에 두 번 보내면 +1
    // (실패한 뒤 다시 보낼 때도 새 revision을 쓴다. 이미 받은 임베딩은 AI 서버가 재사용)
    const revision = Math.max(Date.now(), (state?.revision ?? 0) + 1);
    states.set(scope.ownerId, { revision, payloadHash: null, snapshotId: null });
    const result = await syncRelationIndex(scope.ownerId, revision, documents);
    states.set(scope.ownerId, { revision, payloadHash, snapshotId: result.snapshotId });
    return { snapshotId: result.snapshotId, categories };
}

// AI 서버가 저장한 관계도를 잃었거나(데이터 폴더 삭제) 마지막 계산이 실패로 남은 경우, 다음 동기화가 꼭 다시 보내도록 기억을 지운다
export function forgetRelations(ownerId: string) {
    const state = states.get(ownerId);
    if (state) states.set(ownerId, { revision: state.revision, payloadHash: null, snapshotId: null });
}

function scheduleSync(scope: RelationScope) {
    clearTimeout(timers.get(scope.ownerId));
    const timer = setTimeout(() => {
        timers.delete(scope.ownerId);
        runRelationExclusive(scope.ownerId, () => syncRelationsLocked(scope)).catch((err) => {
            // 실패해도 다음 관계도 조회 직전에 다시 동기화한다
            logger.error(
                "AI_RELATIONS_REQUEST_FAILED",
                `관계도 동기화 실패: ${err instanceof Error ? err.message : String(err)}`,
                { ownerId: scope.ownerId },
            );
        });
    }, env.AI_RELATIONS_SYNC_DELAY_MS);
    timer.unref();
    timers.set(scope.ownerId, timer);
}

// 문서를 수정·삭제·채택·복원한 뒤 부른다 (await 하지 않음). 그 문서가 속한 공간의 관계도 동기화를 예약한다.
// 검색 색인 동기화(touchSearchIndex)와 따로 부른다. 사용자 응답과 상관없이 뒤에서 돌고, 실패는 로그만 남긴다
export async function touchRelationIndex(documentIds: bigint[]): Promise<void> {
    if (!env.AI_RELATIONS_ENABLED || documentIds.length === 0) return;
    try {
        const spaces = await searchRepository.findSpaces(documentIds);
        const scopes = new Map<string, RelationScope>();
        for (const { userId, workspaceId } of spaces) {
            // 생성 요청자가 탈퇴로 영구 삭제된 개인 문서는 볼 사람이 없다
            if (workspaceId === null && userId === null) continue;
            const scope = toRelationScope(Number(userId), workspaceId);
            scopes.set(scope.ownerId, scope);
        }
        scopes.forEach(scheduleSync);
    } catch (err) {
        logger.error(
            "AI_RELATIONS_REQUEST_FAILED",
            `관계도 동기화 예약 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
