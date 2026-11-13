import { prisma } from "../config/prisma.js";
import type { Category, FailReason, Prisma } from "../generated/prisma/client.js";
import type { DraftResult } from "../utils/aiServer.js";
import type { SpaceFilter } from "../services/workspaceAccess.js";
import { versionRepository } from "./version.repository.js";

// 생성 요청자·최근 수정자 표시용
const userRef = { select: { userId: true, nickname: true } } as const;
const peopleSelect = { user: userRef, lastEditor: userRef } as const;

// AI 결과를 저장해도 되는 문서: 개인 문서이거나 삭제되지 않은 팀의 문서 (팀을 지우면 진행 중이던 결과는 반영하지 않음)
const liveSpace: Prisma.DocumentWhereInput = { OR: [{ workspaceId: null }, { workspace: { deletedAt: null } }] };

// drafts.error_message가 VARCHAR(1000)
const ERROR_MESSAGE_MAX = 1000;

// 검색어를 FULLTEXT BOOLEAN MODE 검색식으로 바꾼다. "RAG 파이프라인" → +"RAG" +"파이프라인" (단어가 모두 들어간 문서)
// 검색 연산자로 쓰이는 기호는 지우고, ngram 토큰(2글자)보다 짧은 1글자 단어는 뺀다. 남는 단어가 없으면 null
function toSearchQuery(q: string) {
    const words = q
        .replace(/[+\-<>()~*"@]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 2);
    return words.length > 0 ? words.map((word) => `+"${word}"`).join(" ") : null;
}

export const documentRepository = {
    // 이 대화들을 쓰는 문서 중 생성 작업이 진행 중인 문서 (첫 초안 생성 중이거나 AI 보완·재시도 중인 초안이 있음)
    findGeneratingByConversationIds(conversationIds: bigint[]) {
        return prisma.document.findMany({
            where: {
                deletedAt: null,
                sources: { some: { conversationId: { in: conversationIds } } },
                OR: [{ status: "GENERATING" }, { drafts: { some: { status: "GENERATING" } } }],
            },
            select: { documentId: true },
        });
    },

    // 문서(GENERATING) + 분석 대상 대화 연결 + 1회차 초안(GENERATING)을 한 번에 만든다 (중첩 create라 하나의 트랜잭션)
    // userId = 최초 생성 요청자, 1회차 초안의 requestedBy도 같은 회원
    createWithFirstDraft(userId: bigint, workspaceId: bigint | null, conversationIds: bigint[]) {
        return prisma.document.create({
            data: {
                userId,
                workspaceId,
                sources: { create: conversationIds.map((conversationId) => ({ conversationId })) },
                drafts: { create: { versionNo: 1, requestedBy: userId } },
            },
            include: { drafts: { select: { draftId: true } } },
        });
    },

    // 이 공간에서 검토할 초안이 있는(DRAFT_GENERATED) 문서를 최근 생성순으로, 생성이 끝난 최신 회차의 제목과 함께
    // (AI 보완 중인 회차는 아직 제목이 없어서 뺀다)
    findPendingBySpace(space: SpaceFilter) {
        return prisma.document.findMany({
            where: { ...space, deletedAt: null, status: "DRAFT_GENERATED" },
            orderBy: [{ createdAt: "desc" }, { documentId: "desc" }],
            select: {
                documentId: true,
                createdAt: true,
                user: userRef,
                drafts: {
                    where: { status: "GENERATED" },
                    orderBy: { draftId: "desc" },
                    take: 1,
                    select: { title: true },
                },
            },
        });
    },

    // 지식 문서 목록(DOC-01): 이 공간의 삭제하지 않은 최종 문서를 검색어·유형으로 거르고 정렬한 한 페이지와 전체 개수
    // 검색은 제목·본문 FULLTEXT(ngram) 인덱스를 쓴다. 검색 중에도 관련도가 아니라 고른 정렬을 따른다
    findFinalizedPage(
        space: SpaceFilter,
        { q, category, sort }: { q?: string; category?: Category; sort: "updated" | "created" },
        { skip, take }: { skip: number; take: number },
    ) {
        const search = q === undefined ? undefined : toSearchQuery(q);
        if (search === null) return Promise.resolve([[], 0] as const);

        const where: Prisma.DocumentWhereInput = {
            ...space,
            deletedAt: null,
            status: "FINALIZED",
            category,
            // 인덱스가 (title, content) 두 컬럼이라 두 컬럼에 같은 검색식을 넣어야 MATCH(title, content)로 묶인다
            ...(search && { title: { search }, content: { search } }),
        };
        return prisma.$transaction([
            prisma.document.findMany({
                where,
                orderBy: [sort === "created" ? { createdAt: "desc" } : { updatedAt: "desc" }, { documentId: "desc" }],
                skip,
                take,
                select: {
                    documentId: true,
                    title: true,
                    summary: true,
                    category: true,
                    createdAt: true,
                    updatedAt: true,
                    keywords: { orderBy: { documentKeywordId: "asc" }, select: { keyword: true } },
                    ...peopleSelect,
                },
            }),
            prisma.document.count({ where }),
        ]);
    },

    // 지식 문서 상세(DOC-02): 문서와 키워드, 연결된 대화(삭제 여부 포함), 생성 요청자·최근 수정자
    findByIdWithDetail(documentId: bigint) {
        return prisma.document.findUnique({
            where: { documentId },
            include: {
                ...peopleSelect,
                keywords: { orderBy: { documentKeywordId: "asc" }, select: { keyword: true } },
                sources: {
                    orderBy: { conversationId: "asc" },
                    select: { conversation: { select: { conversationId: true, title: true, deletedAt: true } } },
                },
            },
        });
    },

    // 직접 수정·삭제 전 확인용: 요청자·공간·상태·삭제 여부만
    findState(documentId: bigint) {
        return prisma.document.findUnique({
            where: { documentId },
            select: { userId: true, workspaceId: true, status: true, deletedAt: true },
        });
    },

    // 지식 문서 직접 수정(DOC-03): 받은 제목·본문만 덮어쓰고, 키워드를 받았으면 통째로 바꾼다(이전 내용은 보관하지 않음)
    // 키워드만 바꿔도 수정일이 바뀌도록 updated_at은 직접 넣는다. 수정한 회원은 최근 수정자(last_edited_by)로. 그 사이 문서가 삭제됐으면 null
    // 키워드 UNIQUE가 대소문자를 구분하지 않아서 skipDuplicates로 겹치는 값은 건너뛴다
    // 저장한 결과는 지식 문서 이력에 MANUAL_SAVE로 남긴다
    updateFinalized(
        documentId: bigint,
        editorId: bigint,
        data: { title?: string; content?: string; keywords?: string[] },
    ) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.document.updateMany({
                where: { documentId, status: "FINALIZED", deletedAt: null },
                data: { title: data.title, content: data.content, lastEditedBy: editorId, updatedAt: new Date() },
            });
            if (count === 0) return null;

            if (data.keywords) {
                await tx.documentKeyword.deleteMany({ where: { documentId } });
                await tx.documentKeyword.createMany({
                    data: data.keywords.map((keyword) => ({ documentId, keyword })),
                    skipDuplicates: true,
                });
            }
            const saved = await tx.document.findUniqueOrThrow({
                where: { documentId },
                select: {
                    documentId: true,
                    title: true,
                    content: true,
                    summary: true,
                    category: true,
                    updatedAt: true,
                    keywords: { orderBy: { documentKeywordId: "asc" }, select: { keyword: true } },
                },
            });
            await versionRepository.add(tx, {
                documentId,
                draftId: null,
                source: "MANUAL_SAVE",
                savedBy: editorId,
                title: saved.title,
                content: saved.content,
                summary: saved.summary,
                category: saved.category,
                keywords: saved.keywords.map(({ keyword }) => keyword),
            });
            return saved;
        });
    },

    // 지식 문서 삭제(DOC-04): 소프트 삭제. 연결된 대화·키워드·초안은 그대로 둔다. 이미 삭제됐거나 최종 문서가 아니면 0건
    async softDeleteFinalized(documentId: bigint) {
        const { count } = await prisma.document.updateMany({
            where: { documentId, status: "FINALIZED", deletedAt: null },
            data: { deletedAt: new Date() },
        });
        return count > 0;
    },

    // 초안 이력 조회용: 문서와 모든 초안의 회차·상태
    findWithDraftHistory(documentId: bigint) {
        return prisma.document.findUnique({
            where: { documentId },
            select: {
                userId: true,
                workspaceId: true,
                status: true,
                deletedAt: true,
                drafts: {
                    orderBy: [{ versionNo: "asc" }, { draftId: "asc" }],
                    select: { draftId: true, versionNo: true, status: true },
                },
            },
        });
    },

    // 첫 초안 생성 완료(AI-01 응답): 초안에 결과를 저장하고 GENERATED, 문서 DRAFT_GENERATED. 받은 결과는 1회차 이력에 AI_GENERATED로 남긴다.
    // 기다리는 사이 상태가 바뀌었거나(서버 재시작으로 실패 처리됨 등) 팀이 삭제됐으면 저장하지 않는다 (false)
    saveFirstDraftResult(documentId: bigint, draftId: bigint, result: DraftResult) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.draft.updateMany({
                where: { draftId, status: "GENERATING", document: liveSpace },
                data: { ...result, status: "GENERATED" },
            });
            if (count === 0) return false;
            await tx.document.updateMany({
                where: { documentId, status: "GENERATING" },
                data: { status: "DRAFT_GENERATED" },
            });
            const { requestedBy } = await tx.draft.findUniqueOrThrow({
                where: { draftId },
                select: { requestedBy: true },
            });
            await versionRepository.add(tx, {
                documentId,
                draftId,
                source: "AI_GENERATED",
                savedBy: requestedBy,
                ...result,
            });
            return true;
        });
    },

    // 첫 초안 생성 실패: 초안 FAILED(원인 기록) + 문서 FAILED
    markFirstDraftFailed(documentId: bigint, draftId: bigint, failReason: FailReason, errorMessage: string) {
        return prisma.$transaction([
            prisma.draft.update({
                where: { draftId },
                data: { status: "FAILED", failReason, errorMessage: errorMessage.slice(0, ERROR_MESSAGE_MAX) },
            }),
            prisma.document.update({ where: { documentId }, data: { status: "FAILED" } }),
        ]);
    },
};
