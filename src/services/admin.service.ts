import { adminRepository } from "../repositories/admin.repository.js";
import { toPageInfo } from "../schemas/common.schema.js";
import type { AdminUserListQuery, GenerationFailureQuery, PeriodQuery } from "../schemas/admin.schema.js";
import { bucketKey, listBuckets, ratio, toKstDate, toUtcRange, type Interval } from "../utils/kstPeriod.js";

// 구간별 카운터를 0으로 미리 채워 둔다 (차트에 빈 구간도 나오게)
function emptyTrend<T>(from: string, to: string, interval: Interval, init: () => T) {
    return new Map(listBuckets(from, to, interval).map((date) => [date, init()]));
}

export const adminService = {
    // ADMIN-01 회원 목록 (B01)
    async listUsers({ q, page, limit }: AdminUserListQuery) {
        const { users, totalCount } = await adminRepository.findUsers(q, (page - 1) * limit, limit);
        const lastActive = await adminRepository.findLastActiveAt(users.map((u) => u.userId));
        return {
            ...toPageInfo(page, limit, totalCount),
            users: users.map((u) => ({
                userId: Number(u.userId),
                nickname: u.nickname,
                email: u.email,
                createdAt: u.createdAt.toISOString(),
                lastActiveAt: lastActive.get(u.userId)?.toISOString() ?? null,
                withdrawalRequestedAt: u.deletedAt?.toISOString() ?? null,
            })),
        };
    },

    // ADMIN-02 서비스 이용 통계 (B02). 조회 시점 현황
    async serviceStats() {
        const [userCount, byCategory] = await Promise.all([
            adminRepository.countActiveUsers(),
            adminRepository.countFinalizedDocumentsByCategory(),
        ]);
        const documentCount = byCategory.reduce((sum, row) => sum + row._count._all, 0);
        const categories = byCategory
            .filter((row) => row.category !== null)
            .map((row) => ({
                category: row.category!,
                count: row._count._all,
                ratio: ratio(row._count._all, documentCount) ?? 0,
            }))
            .sort((a, b) => b.count - a.count);
        return { aggregatedAt: new Date().toISOString(), userCount, documentCount, categories };
    },

    // ADMIN-03 문서 생성 현황 (B03)
    // 시도 = 생성 요청(generations 1행, 문서가 여러 편 나와도 1번) + AI 보완 회차(drafts 1행). 다시 시도도 각각 1번
    async generationStats({ from, to, interval }: PeriodQuery) {
        const range = toUtcRange(from, to);
        const [generations, drafts] = await Promise.all([
            adminRepository.findGenerationAttempts(range),
            adminRepository.findDraftAttempts(range),
        ]);

        const trend = emptyTrend(from, to, interval, () => ({ attemptCount: 0, failCount: 0 }));
        let failCount = 0;
        let noContentCount = 0;
        let finishedCount = 0; // 진행 중(GENERATING)을 뺀 시도
        for (const attempt of [...generations, ...drafts]) {
            const bucket = trend.get(bucketKey(toKstDate(attempt.createdAt), interval, from))!;
            bucket.attemptCount += 1;
            if (attempt.status !== "GENERATING") finishedCount += 1;
            if (attempt.status === "FAILED") {
                failCount += 1;
                bucket.failCount += 1;
            }
            if (attempt.status === "NO_CONTENT") noContentCount += 1;
        }

        return {
            from,
            to,
            interval,
            aggregatedAt: new Date().toISOString(),
            attemptCount: generations.length + drafts.length,
            failCount,
            noContentCount,
            failureRate: ratio(failCount, finishedCount),
            trend: [...trend].map(([date, counts]) => ({ date, ...counts })),
        };
    },

    // ADMIN-04 생성 실패 목록 (B03). 생성 요청 실패와 AI 보완 실패를 합쳐 최신순
    async generationFailures({ from, to, page, limit, failReason }: GenerationFailureQuery) {
        const range = toUtcRange(from, to);
        const [generations, drafts] = await Promise.all([
            adminRepository.findFailedGenerations(range, failReason),
            adminRepository.findFailedDrafts(range, failReason),
        ]);
        const retriedDrafts = await adminRepository.findEarlierDraftIds(drafts);

        const failures = [
            ...generations.map((g) => ({
                jobType: "FIRST_GENERATION" as const,
                generationId: Number(g.generationId),
                draftId: null,
                documentId: null,
                versionNo: null,
                requestedAt: g.createdAt,
                isRetry: g.retriedFromId !== null,
                failReason: g.failReason,
                errorMessage: g.errorMessage,
                user: g.user,
            })),
            ...drafts.map((d) => ({
                // 2회차 이상은 AI 보완, 1회차는 생성 요청이 생기기 전 예전 방식의 첫 생성
                jobType: d.versionNo >= 2 ? ("REVISION" as const) : ("FIRST_GENERATION" as const),
                generationId: null,
                draftId: Number(d.draftId),
                documentId: Number(d.documentId),
                versionNo: d.versionNo,
                requestedAt: d.createdAt,
                isRetry: retriedDrafts.has(d.draftId),
                failReason: d.failReason,
                errorMessage: d.errorMessage,
                user: d.requester ?? d.document.user,
            })),
        ].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());

        return {
            ...toPageInfo(page, limit, failures.length),
            from,
            to,
            failures: failures.slice((page - 1) * limit, page * limit).map(({ user, requestedAt, ...rest }) => ({
                ...rest,
                requestedAt: requestedAt.toISOString(),
                userId: user ? Number(user.userId) : null,
                userEmail: user?.email ?? null,
            })),
        };
    },

    // ADMIN-05 초안 검토 현황 (B04). 요약과 구간별 추이를 같은 기준으로 계산
    async reviewStats({ from, to, interval }: PeriodQuery) {
        const range = toUtcRange(from, to);
        const [documents, revisions] = await Promise.all([
            adminRepository.findFinalizedDocuments(range),
            adminRepository.findRevisionRequests(range),
        ]);

        type Acc = { documents: number; firstAccepted: number; drafts: number; revisions: number };
        const newAcc = (): Acc => ({ documents: 0, firstAccepted: 0, drafts: 0, revisions: 0 });
        const total = newAcc();
        const trend = emptyTrend(from, to, interval, newAcc);

        for (const doc of documents) {
            const bucket = trend.get(bucketKey(toKstDate(doc.finalizedAt!), interval, from))!;
            // 채택한 회차가 1회차면 첫 초안 채택 (1회차를 직접 고친 뒤 채택한 경우 포함)
            const firstAccepted = doc.drafts.some((d) => d.status === "ACCEPTED" && d.versionNo === 1) ? 1 : 0;
            for (const acc of [total, bucket]) {
                acc.documents += 1;
                acc.firstAccepted += firstAccepted;
                acc.drafts += doc.drafts.length;
            }
        }
        for (const revision of revisions) {
            total.revisions += 1;
            trend.get(bucketKey(toKstDate(revision.createdAt), interval, from))!.revisions += 1;
        }

        const metrics = (acc: Acc) => ({
            firstDraftAcceptanceRate: ratio(acc.firstAccepted, acc.documents),
            avgDraftsPerDocument: ratio(acc.drafts, acc.documents),
            revisionRequestCount: acc.revisions,
        });

        return {
            from,
            to,
            interval,
            aggregatedAt: new Date().toISOString(),
            finalizedDocumentCount: total.documents,
            ...metrics(total),
            trend: [...trend].map(([date, acc]) => ({ date, ...metrics(acc) })),
        };
    },
};
