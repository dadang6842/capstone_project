import { prisma } from "../config/prisma.js";
import type { Category, Prisma } from "../generated/prisma/client.js";

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
    createWithFirstDraft(userId: bigint, conversationIds: bigint[]) {
        return prisma.document.create({
            data: {
                userId,
                sources: { create: conversationIds.map((conversationId) => ({ conversationId })) },
                drafts: { create: { versionNo: 1 } },
            },
            include: { drafts: { select: { draftId: true } } },
        });
    },

    // 검토할 초안이 있는(DRAFT_GENERATED) 내 문서를 최근 생성순으로, 생성이 끝난 최신 회차의 제목과 함께
    // (AI 보완 중인 회차는 아직 제목이 없어서 뺀다)
    findPendingByUser(userId: bigint) {
        return prisma.document.findMany({
            where: { userId, deletedAt: null, status: "DRAFT_GENERATED" },
            orderBy: [{ createdAt: "desc" }, { documentId: "desc" }],
            select: {
                documentId: true,
                createdAt: true,
                drafts: {
                    where: { status: "GENERATED" },
                    orderBy: { draftId: "desc" },
                    take: 1,
                    select: { title: true },
                },
            },
        });
    },

    // 지식 문서 목록(DOC-01): 삭제하지 않은 내 최종 문서를 검색어·유형으로 거르고 정렬한 한 페이지와 전체 개수
    // 검색은 제목·본문 FULLTEXT(ngram) 인덱스를 쓴다. 검색 중에도 관련도가 아니라 고른 정렬을 따른다
    findFinalizedPage(
        userId: bigint,
        { q, category, sort }: { q?: string; category?: Category; sort: "updated" | "created" },
        { skip, take }: { skip: number; take: number },
    ) {
        const search = q === undefined ? undefined : toSearchQuery(q);
        if (search === null) return Promise.resolve([[], 0] as const);

        const where: Prisma.DocumentWhereInput = {
            userId,
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
                },
            }),
            prisma.document.count({ where }),
        ]);
    },

    // 지식 문서 상세(DOC-02): 문서와 키워드, 연결된 대화(삭제 여부 포함)
    findByIdWithDetail(documentId: bigint) {
        return prisma.document.findUnique({
            where: { documentId },
            include: {
                keywords: { orderBy: { documentKeywordId: "asc" }, select: { keyword: true } },
                sources: {
                    orderBy: { conversationId: "asc" },
                    select: { conversation: { select: { conversationId: true, filename: true, deletedAt: true } } },
                },
            },
        });
    },

    // 직접 수정 전 확인용: 주인·상태·삭제 여부만
    findState(documentId: bigint) {
        return prisma.document.findUnique({
            where: { documentId },
            select: { userId: true, status: true, deletedAt: true },
        });
    },

    // 지식 문서 직접 수정(DOC-03): 받은 제목·본문만 덮어쓰고, 키워드를 받았으면 통째로 바꾼다(이전 내용은 보관하지 않음)
    // 키워드만 바꿔도 수정일이 바뀌도록 updated_at은 직접 넣는다. 그 사이 문서가 삭제됐으면 null
    // 키워드 UNIQUE가 대소문자를 구분하지 않아서 skipDuplicates로 겹치는 값은 건너뛴다
    updateFinalized(documentId: bigint, data: { title?: string; content?: string; keywords?: string[] }) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.document.updateMany({
                where: { documentId, status: "FINALIZED", deletedAt: null },
                data: { title: data.title, content: data.content, updatedAt: new Date() },
            });
            if (count === 0) return null;

            if (data.keywords) {
                await tx.documentKeyword.deleteMany({ where: { documentId } });
                await tx.documentKeyword.createMany({
                    data: data.keywords.map((keyword) => ({ documentId, keyword })),
                    skipDuplicates: true,
                });
            }
            return tx.document.findUniqueOrThrow({
                where: { documentId },
                select: {
                    documentId: true,
                    title: true,
                    updatedAt: true,
                    keywords: { orderBy: { documentKeywordId: "asc" }, select: { keyword: true } },
                },
            });
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
                status: true,
                deletedAt: true,
                drafts: {
                    orderBy: [{ versionNo: "asc" }, { draftId: "asc" }],
                    select: { draftId: true, versionNo: true, status: true },
                },
            },
        });
    },

    // 첫 초안 생성 실패: 초안 FAILED(원인 기록) + 문서 FAILED
    markFirstDraftFailed(documentId: bigint, draftId: bigint, failReason: "ANALYSIS_FAILED", errorMessage: string) {
        return prisma.$transaction([
            prisma.draft.update({
                where: { draftId },
                data: { status: "FAILED", failReason, errorMessage: errorMessage.slice(0, ERROR_MESSAGE_MAX) },
            }),
            prisma.document.update({ where: { documentId }, data: { status: "FAILED" } }),
        ]);
    },
};
