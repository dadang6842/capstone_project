import { env } from "../config/env.js";
import { resolveSpace } from "./workspaceAccess.js";
import {
    forgetRelations,
    runRelationExclusive,
    syncRelationsLocked,
    toRelationScope,
    type RelationScope,
} from "./relationIndex.js";
import { AiRelationsError, fetchRelationGraph, type AiRelationGraph } from "../utils/aiRelations.js";
import type { Category } from "../generated/prisma/client.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type { RelationGraph, RelationGraphQuery } from "../schemas/relation.schema.js";

// 문서 관계도 (2026-11-17). 대상은 이 공간(개인·팀)의 휴지통 밖 최종 문서.
// 조회할 때마다 먼저 AI 서버 관계도를 최신 문서로 맞춘 뒤(바뀐 게 없으면 생략) 완성된 관계도를 받는다

async function resolveScope(userId: number, workspaceId?: number): Promise<RelationScope> {
    if (!env.AI_RELATIONS_ENABLED) throw new AppError("AI_RELATIONS_UNAVAILABLE");
    // 팀이면 팀원인지 확인한다 (아니면 404 WORKSPACE_NOT_FOUND). 범위는 JWT 회원·팀 아이디로만 정한다
    return toRelationScope(userId, await resolveSpace(userId, workspaceId));
}

async function loadGraph(scope: RelationScope) {
    const { snapshotId, categories } = await syncRelationsLocked(scope);
    try {
        return { graph: await fetchRelationGraph(scope.ownerId, snapshotId), categories };
    } catch (err) {
        // 404: AI 서버가 이 공간 관계도를 잃음(데이터 폴더 초기화 등), 409: 그 사이 AI 쪽 상태가 바뀜 → 기억을 지우고 한 번만 다시 보낸다
        if (!(err instanceof AiRelationsError) || (err.status !== 404 && err.status !== 409)) throw err;
        forgetRelations(scope.ownerId);
        const retry = await syncRelationsLocked(scope);
        return { graph: await fetchRelationGraph(scope.ownerId, retry.snapshotId), categories: retry.categories };
    }
}

function toResult(graph: AiRelationGraph, categories: Map<string, Category | null>): RelationGraph {
    // artifactId = 백엔드 문서 아이디 (동기화 때 String(documentId)로 보냄)
    return {
        snapshotId: graph.snapshotId,
        counts: graph.counts,
        nodes: graph.nodes.map(({ artifactId, title, groupId, degree }) => ({
            documentId: Number(artifactId),
            title,
            category: categories.get(artifactId) ?? null,
            groupId,
            degree,
        })),
        edges: graph.edges.map(({ sourceId, targetId, similarity, passageSimilarity, similarPassages }) => ({
            sourceDocumentId: Number(sourceId),
            targetDocumentId: Number(targetId),
            similarity,
            passageSimilarity,
            // start·end는 Python 문자 위치라 JS 문자열 위치와 다를 수 있어서 주지 않고 구간 글만 준다
            passages: similarPassages.map(({ artifactId, text }) => ({ documentId: Number(artifactId), text })),
        })),
    };
}

export const relationService = {
    // REL-01: 이 공간의 문서 관계도. 문서가 바뀐 뒤 처음 부르면 바뀐 문서만 임베딩하고 전체를 다시 계산한다(수 초~, 처음엔 더 걸림)
    async getGraph(userId: number, { workspaceId }: RelationGraphQuery): Promise<RelationGraph> {
        const scope = await resolveScope(userId, workspaceId);
        try {
            const { graph, categories } = await runRelationExclusive(scope.ownerId, () => loadGraph(scope));
            return toResult(graph, categories);
        } catch (err) {
            if (!(err instanceof AiRelationsError)) throw err;
            logger.error("AI_RELATIONS_REQUEST_FAILED", err.message, { ownerId: scope.ownerId, code: err.code });
            // 문서 수·본문 구간 한도(기본 200편·512구간) 초과. 일부만 보내 우회하지 않는다
            if (err.status === 413) throw new AppError("RELATIONS_TOO_LARGE");
            throw new AppError("AI_RELATIONS_FAILED");
        }
    },
};
