import { prisma } from "../config/prisma.js";
import type { Category, Prisma, VersionSource } from "../generated/prisma/client.js";

// 이력 한 줄에 복사해 두는 내용 (그 시점의 제목·본문 등)
export type VersionSnapshot = {
    title: string | null;
    content: string | null;
    summary: string | null;
    category: Category | null;
    keywords: string[];
};

// 목록·조회에서 같이 가져오는 값: 저장한 회원, 복원이면 되돌린 버전 번호
const versionInclude = {
    saver: { select: { userId: true, nickname: true } },
    restoredFrom: { select: { versionNo: true } },
} satisfies Prisma.DocumentVersionInclude;

export type VersionWithSaver = Prisma.DocumentVersionGetPayload<{ include: typeof versionInclude }>;

export const versionRepository = {
    // 이력 한 줄 추가. 다른 저장과 같은 트랜잭션(tx) 안에서 부른다.
    // 번호 = 같은 이력(draftId가 같은 회차, NULL이면 지식 문서) 안에서 가장 큰 번호 + 1.
    // 문서 행을 잠가서 동시에 저장해도 번호가 겹치지 않게 한다
    async add(
        tx: Prisma.TransactionClient,
        data: {
            documentId: bigint;
            draftId: bigint | null;
            source: VersionSource;
            savedBy: bigint | null;
            restoredFromId?: bigint;
        } & VersionSnapshot,
    ) {
        await tx.$queryRaw`SELECT document_id FROM documents WHERE document_id = ${data.documentId} FOR UPDATE`;
        const { _max } = await tx.documentVersion.aggregate({
            where: { documentId: data.documentId, draftId: data.draftId },
            _max: { versionNo: true },
        });
        return tx.documentVersion.create({
            data: { ...data, versionNo: (_max.versionNo ?? 0) + 1 },
            include: versionInclude,
        });
    },

    // 한 회차(초안)의 이력, 최신순
    findByDraft(draftId: bigint) {
        return prisma.documentVersion.findMany({
            where: { draftId },
            orderBy: { versionNo: "desc" },
            include: versionInclude,
        });
    },

    // 채택 뒤 지식 문서의 이력 (draft_id NULL), 최신순
    findByDocument(documentId: bigint) {
        return prisma.documentVersion.findMany({
            where: { documentId, draftId: null },
            orderBy: { versionNo: "desc" },
            include: versionInclude,
        });
    },

    // 버전 하나와, 볼 수 있는지·복원할 수 있는지 확인할 문서 상태
    findById(documentVersionId: bigint) {
        return prisma.documentVersion.findUnique({
            where: { documentVersionId },
            include: {
                ...versionInclude,
                document: { select: { userId: true, workspaceId: true, status: true, deletedAt: true } },
            },
        });
    },

    // 회차 버전 복원: 그 회차 초안의 제목·본문을 버전 내용으로 되돌리고 RESTORE 버전을 쌓는다 (이전 버전은 지우지 않음).
    // 초안이 GENERATED일 때만 바꿔서, 그 사이 채택됐으면 null. 복원한 회원이 문서의 최근 수정자
    restoreDraft(
        version: {
            documentVersionId: bigint;
            documentId: bigint;
            draftId: bigint;
            title: string | null;
            content: string | null;
        },
        editorId: bigint,
    ) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.draft.updateMany({
                where: { draftId: version.draftId, status: "GENERATED" },
                data: { title: version.title, content: version.content },
            });
            if (count === 0) return null;
            await tx.document.update({ where: { documentId: version.documentId }, data: { lastEditedBy: editorId } });
            const draft = await tx.draft.findUniqueOrThrow({ where: { draftId: version.draftId } });
            return versionRepository.add(tx, {
                documentId: version.documentId,
                draftId: version.draftId,
                source: "RESTORE",
                savedBy: editorId,
                restoredFromId: version.documentVersionId,
                title: draft.title,
                content: draft.content,
                summary: draft.summary,
                category: draft.category,
                keywords: Array.isArray(draft.keywords) ? (draft.keywords as string[]) : [],
            });
        });
    },

    // 지식 문서 버전 복원: 제목·본문·키워드를 버전 내용으로 되돌리고 RESTORE 버전을 쌓는다 (지식 유형·요약은 수정할 수 없는 값이라 그대로).
    // 문서가 FINALIZED이고 삭제되지 않았을 때만 (아니면 null). 복원한 회원이 최근 수정자, 수정일 갱신
    restoreDocument(
        version: {
            documentVersionId: bigint;
            documentId: bigint;
            title: string | null;
            content: string | null;
            keywords: unknown;
        },
        editorId: bigint,
    ) {
        const keywords = Array.isArray(version.keywords) ? (version.keywords as string[]) : [];
        return prisma.$transaction(async (tx) => {
            const { documentId } = version;
            const { count } = await tx.document.updateMany({
                where: { documentId, status: "FINALIZED", deletedAt: null },
                data: { title: version.title, content: version.content, lastEditedBy: editorId, updatedAt: new Date() },
            });
            if (count === 0) return null;
            await tx.documentKeyword.deleteMany({ where: { documentId } });
            await tx.documentKeyword.createMany({
                data: keywords.map((keyword) => ({ documentId, keyword })),
                skipDuplicates: true,
            });
            const document = await tx.document.findUniqueOrThrow({ where: { documentId } });
            return versionRepository.add(tx, {
                documentId,
                draftId: null,
                source: "RESTORE",
                savedBy: editorId,
                restoredFromId: version.documentVersionId,
                title: document.title,
                content: document.content,
                summary: document.summary,
                category: document.category,
                keywords,
            });
        });
    },
};
