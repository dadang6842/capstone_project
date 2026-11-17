import { prisma } from "../config/prisma.js";
import type { SpaceFilter } from "../services/workspaceAccess.js";

// 지식 문서 AI 검색 (2026-11-17)
export const searchRepository = {
    // 검색 색인 스냅샷: 이 공간의 휴지통 밖 최종(FINALIZED) 문서 전부를 아이디 순으로.
    // 지식 문서 이력(draft_id NULL)의 출처는 채택 뒤 직접 수정·복원이 있었는지 보려고 같이 가져온다
    findSnapshot(space: SpaceFilter) {
        return prisma.document.findMany({
            where: { ...space, deletedAt: null, status: "FINALIZED" },
            orderBy: { documentId: "asc" },
            select: {
                documentId: true,
                title: true,
                content: true,
                summary: true,
                category: true,
                keywords: { select: { keyword: true }, orderBy: { documentKeywordId: "asc" } },
                versions: {
                    where: { draftId: null },
                    orderBy: { versionNo: "desc" },
                    select: { versionNo: true, source: true },
                },
            },
        });
    },

    // 문서가 속한 공간 (색인 동기화 대상 찾기용). 영구 삭제된 문서는 빠진다
    findSpaces(documentIds: bigint[]) {
        return prisma.document.findMany({
            where: { documentId: { in: documentIds } },
            select: { userId: true, workspaceId: true },
        });
    },
};
