import { prisma } from "../config/prisma.js";
import type { FailReason, Prisma } from "../generated/prisma/client.js";

// 관리자 통계 저장소 (화면 B01~B04)
// 로그 테이블 없이 기존 테이블을 집계한다. 기간 집계는 필요한 행만 읽어서 서비스에서 날짜 구간별로 센다(졸업 프로젝트 규모 기준).

type Range = { gte: Date; lt: Date };

// 관리자 계정이 요청·생성한 데이터는 뺀다. 탈퇴로 회원이 영구 삭제된 행(user NULL)은 일반 회원 데이터로 본다
const notAdminGeneration: Prisma.GenerationWhereInput = { NOT: { user: { is: { role: "ADMIN" } } } };
const notAdminDocument: Prisma.DocumentWhereInput = { NOT: { user: { is: { role: "ADMIN" } } } };
// 초안은 회차를 요청한 회원 기준. 예전 데이터처럼 requested_by가 비어 있으면 문서 주인으로 판단
const notAdminDraft: Prisma.DraftWhereInput = {
    NOT: [
        { requester: { is: { role: "ADMIN" } } },
        { requestedBy: null, document: { user: { is: { role: "ADMIN" } } } },
    ],
};

// 생성 시도로 세는 초안: AI 보완 회차(2회차 이상)와, 생성 요청(generations)이 생기기 전 예전 방식의 1회차.
// 지식 분할 저장 이후의 1회차는 생성 요청 결과로 만들어진 행이라 시도는 generations에서 센다
const attemptDraft: Prisma.DraftWhereInput = {
    OR: [{ versionNo: { gte: 2 } }, { document: { generationId: null } }],
};

const requesterSelect = { select: { userId: true, email: true } } as const;

export const adminRepository = {
    // ───── ADMIN-01 회원 목록 ─────
    async findUsers(q: string | undefined, skip: number, take: number) {
        const where: Prisma.UserWhereInput = {
            role: "USER",
            ...(q && { OR: [{ email: { contains: q } }, { nickname: { contains: q } }] }),
        };
        const [users, totalCount] = await prisma.$transaction([
            prisma.user.findMany({
                where,
                orderBy: [{ createdAt: "desc" }, { userId: "desc" }],
                skip,
                take,
                select: { userId: true, nickname: true, email: true, createdAt: true, deletedAt: true },
            }),
            prisma.user.count({ where }),
        ]);
        return { users, totalCount };
    },

    // 회원별 마지막 refresh 토큰 발급 시각 (로그인·재발급마다 행이 생긴다)
    async findLastActiveAt(userIds: bigint[]) {
        if (userIds.length === 0) return new Map<bigint, Date>();
        const rows = await prisma.refreshToken.groupBy({
            by: ["userId"],
            where: { userId: { in: userIds } },
            _max: { createdAt: true },
        });
        return new Map(rows.filter((r) => r._max.createdAt).map((r) => [r.userId, r._max.createdAt as Date]));
    },

    // ───── ADMIN-02 서비스 이용 통계 ─────
    countActiveUsers() {
        return prisma.user.count({ where: { role: "USER", deletedAt: null } });
    },

    // 최종 채택했고 휴지통에 없는 문서 (개인·팀 모두)
    countFinalizedDocumentsByCategory() {
        return prisma.document.groupBy({
            by: ["category"],
            where: { status: "FINALIZED", deletedAt: null, category: { not: null }, ...notAdminDocument },
            _count: { _all: true },
        });
    },

    // ───── ADMIN-03 문서 생성 현황 ─────
    findGenerationAttempts(range: Range) {
        return prisma.generation.findMany({
            where: { createdAt: range, ...notAdminGeneration },
            select: { createdAt: true, status: true },
        });
    },

    findDraftAttempts(range: Range) {
        return prisma.draft.findMany({
            where: { createdAt: range, AND: [attemptDraft, notAdminDraft] },
            select: { createdAt: true, status: true },
        });
    },

    // ───── ADMIN-04 생성 실패 목록 ─────
    // 실패는 건수가 적어서 기간 안의 실패를 모두 읽고 서비스에서 합쳐 정렬·페이징한다
    findFailedGenerations(range: Range, failReason?: FailReason) {
        return prisma.generation.findMany({
            where: { createdAt: range, status: "FAILED", ...(failReason && { failReason }), ...notAdminGeneration },
            select: {
                generationId: true,
                retriedFromId: true,
                failReason: true,
                errorMessage: true,
                createdAt: true,
                user: requesterSelect,
            },
        });
    },

    findFailedDrafts(range: Range, failReason?: FailReason) {
        return prisma.draft.findMany({
            where: {
                createdAt: range,
                status: "FAILED",
                ...(failReason && { failReason }),
                AND: [attemptDraft, notAdminDraft],
            },
            select: {
                draftId: true,
                documentId: true,
                versionNo: true,
                failReason: true,
                errorMessage: true,
                createdAt: true,
                requester: requesterSelect,
                document: { select: { user: requesterSelect } },
            },
        });
    },

    // 같은 문서·같은 회차에 먼저 만든 행이 있으면 '다시 시도'
    async findEarlierDraftIds(drafts: { draftId: bigint; documentId: bigint; versionNo: number }[]) {
        if (drafts.length === 0) return new Set<bigint>();
        const siblings = await prisma.draft.findMany({
            where: { OR: drafts.map(({ documentId, versionNo }) => ({ documentId, versionNo })) },
            select: { draftId: true, documentId: true, versionNo: true },
        });
        const firstId = new Map<string, bigint>();
        for (const s of siblings) {
            const key = `${s.documentId}-${s.versionNo}`;
            const current = firstId.get(key);
            if (current === undefined || s.draftId < current) firstId.set(key, s.draftId);
        }
        return new Set(
            drafts.filter((d) => firstId.get(`${d.documentId}-${d.versionNo}`) !== d.draftId).map((d) => d.draftId),
        );
    },

    // ───── ADMIN-05 초안 검토 현황 ─────
    // 기간 안에 최종 채택된 문서와 그 문서의 정상 초안(GENERATED·ACCEPTED). 휴지통으로 옮긴 문서도 채택 기록이라 센다
    findFinalizedDocuments(range: Range) {
        return prisma.document.findMany({
            where: { finalizedAt: range, ...notAdminDocument },
            select: {
                finalizedAt: true,
                drafts: {
                    where: { status: { in: ["GENERATED", "ACCEPTED"] } },
                    select: { status: true, versionNo: true },
                },
            },
        });
    },

    // AI 보완 요청: 2회차 이상 (문서, 회차)마다 가장 먼저 만든 행. 같은 요구의 다시 시도는 빼야 해서
    // 기간 안의 행을 읽은 뒤, 같은 (문서, 회차)에 기간 시작 전 행이 있으면 그 묶음은 이전 기간 요청으로 본다
    async findRevisionRequests(range: Range) {
        const rows = await prisma.draft.findMany({
            where: { createdAt: range, versionNo: { gte: 2 } },
            orderBy: [{ createdAt: "asc" }, { draftId: "asc" }],
            select: {
                draftId: true,
                documentId: true,
                versionNo: true,
                createdAt: true,
                requestedBy: true,
                requester: { select: { role: true } },
                document: { select: { user: { select: { role: true } } } },
            },
        });
        const first = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
            const key = `${row.documentId}-${row.versionNo}`;
            if (!first.has(key)) first.set(key, row);
        }
        const groups = [...first.values()];
        if (groups.length === 0) return [];

        const earlier = await prisma.draft.findMany({
            where: {
                createdAt: { lt: range.gte },
                OR: groups.map(({ documentId, versionNo }) => ({ documentId, versionNo })),
            },
            select: { documentId: true, versionNo: true },
        });
        const startedBefore = new Set(earlier.map((e) => `${e.documentId}-${e.versionNo}`));

        // 요청자 기준으로 관리자 요청을 뺀다 (requested_by가 비어 있으면 문서 주인)
        return groups
            .filter((g) => !startedBefore.has(`${g.documentId}-${g.versionNo}`))
            .filter((g) => (g.requestedBy !== null ? g.requester?.role : g.document.user?.role) !== "ADMIN")
            .map((g) => ({ createdAt: g.createdAt }));
    },
};
