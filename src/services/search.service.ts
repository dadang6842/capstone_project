import { env } from "../config/env.js";
import { resolveSpace } from "./workspaceAccess.js";
import { runExclusive, syncLocked, toSearchScope, type SearchScope } from "./searchIndex.js";
import { AiSearchError, continueSearch, pageSearch, startSearch, type AiSearchResult } from "../utils/aiSearch.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type { ContinueSearchBody, SearchPageQuery, SearchResult, StartSearchBody } from "../schemas/search.schema.js";

// 지식 문서 AI 검색 (2026-11-17). 검색 대상은 이 공간(개인·팀)의 휴지통 밖 최종 문서.
// 세 API 모두 AI 서버를 부르기 전에 색인을 최신 문서로 맞춘다. 문서가 바뀌었으면 이전 검색의 이어서 찾기·페이지 이동은 409 SEARCH_OUTDATED

async function resolveScope(userId: number, workspaceId?: number): Promise<SearchScope> {
    if (!env.AI_SEARCH_ENABLED) throw new AppError("AI_SEARCH_UNAVAILABLE");
    // 팀이면 팀원인지 확인한다 (아니면 404 WORKSPACE_NOT_FOUND). 검색 범위는 JWT 회원·팀 아이디로만 정한다
    return toSearchScope(userId, await resolveSpace(userId, workspaceId));
}

// 같은 공간의 동기화·검색을 차례로 실행하고, AI 서버 오류를 API 에러로 바꾼다
async function run(scope: SearchScope, task: () => Promise<AiSearchResult>): Promise<SearchResult> {
    try {
        return toResult(await runExclusive(scope.ownerId, task));
    } catch (err) {
        if (!(err instanceof AiSearchError)) throw err;
        // 404: 이 공간의 검색 기록이 아님(다른 공간의 searchId 포함), 409: 문서가 바뀌었거나 더 최신 resultRevision이 있음
        if (err.status === 404) throw new AppError("SEARCH_NOT_FOUND");
        if (err.status === 409) throw new AppError("SEARCH_OUTDATED");
        logger.error("AI_SEARCH_REQUEST_FAILED", err.message, { ownerId: scope.ownerId });
        throw new AppError("AI_SEARCH_FAILED");
    }
}

function toResult(result: AiSearchResult): SearchResult {
    return {
        searchId: result.searchId,
        resultRevision: result.resultRevision,
        status: result.status.toUpperCase() as SearchResult["status"],
        complete: result.complete,
        processedDocuments: result.processedDocuments,
        totalDocuments: result.totalDocuments,
        knownMatches: result.knownMatches,
        totalMatches: result.totalMatches,
        hasMoreCandidates: result.hasMoreCandidates,
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        // artifactId = 백엔드 문서 아이디 (색인 동기화 때 String(documentId)로 보냄)
        results: result.results.map(({ artifactId, title, reason, evidence, evidenceStart, strength }) => ({
            documentId: Number(artifactId),
            title,
            reason,
            evidence,
            evidenceStart,
            strength,
        })),
        errors: (result.errors ?? []).map(({ type, message }) => ({ type, message: message ?? null })),
    };
}

export const searchService = {
    // SEARCH-01: 새 검색. 관련성이 높아 보이는 문서부터 한 묶음만 AI가 읽고 응답한다 (같은 문서·같은 검색어면 저장된 결과를 다시 줌)
    async start(userId: number, { query, pageSize, workspaceId }: StartSearchBody): Promise<SearchResult> {
        const scope = await resolveScope(userId, workspaceId);
        return run(scope, async () => startSearch(scope.ownerId, await syncLocked(scope), query, pageSize));
    },

    // SEARCH-02: 남은 후보를 한 묶음 더 AI가 읽는다 (모델 비용 발생). 다 확인한 검색이면 그대로 돌려준다
    async continue(
        userId: number,
        searchId: string,
        { resultRevision, pageSize, workspaceId }: ContinueSearchBody,
    ): Promise<SearchResult> {
        const scope = await resolveScope(userId, workspaceId);
        return run(scope, async () => {
            await syncLocked(scope);
            return continueSearch(scope.ownerId, searchId, resultRevision, pageSize);
        });
    },

    // SEARCH-03: 이미 찾은 결과의 페이지만 옮긴다 (모델 호출 없음)
    async page(
        userId: number,
        searchId: string,
        { resultRevision, page, pageSize, workspaceId }: SearchPageQuery,
    ): Promise<SearchResult> {
        const scope = await resolveScope(userId, workspaceId);
        return run(scope, async () => {
            await syncLocked(scope);
            return pageSearch(scope.ownerId, searchId, resultRevision, page, pageSize);
        });
    },
};
