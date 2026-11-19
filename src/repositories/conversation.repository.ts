import { prisma } from "../config/prisma.js";
import {
    Prisma,
    type CollectFailReason,
    type ConversationProvider,
    type MessageRole,
} from "../generated/prisma/client.js";
import type { CollectedConversation } from "../utils/collector.js";
import { contentKey, dedupKey } from "../utils/conversationKey.js";
import type { SpaceFilter } from "../services/workspaceAccess.js";
import { generationCardSelect } from "./generationCard.select.js";

// 등록자 표시용
const registrantSelect = { user: { select: { userId: true, nickname: true } } } satisfies Prisma.ConversationInclude;

// 목록에서 대화마다 같이 가져오는 연결 문서 (삭제 문서는 빼고, 최신 문서부터)
// 초안은 생성 중인 초안이 있는지와 최신 회차를 보려고 최신순으로 전부 가져온다
// 생성 요청은 아직 문서가 없는 카드(생성 중·실패·문서 없음)를 만들려고 이 대화를 쓴 요청을 전부 가져온다 (대화마다 몇 개 안 됨)
const listInclude = {
    ...registrantSelect,
    _count: { select: { messages: true } },
    generationConversations: { select: { generation: { select: generationCardSelect } } },
    documentConversations: {
        where: { document: { deletedAt: null } },
        orderBy: { documentId: "desc" },
        select: {
            document: {
                select: {
                    documentId: true,
                    status: true,
                    drafts: { orderBy: { draftId: "desc" }, select: { draftId: true, title: true, status: true } },
                },
            },
        },
    },
} satisfies Prisma.ConversationInclude;

export type ConversationWithDocuments = Prisma.ConversationGetPayload<{ include: typeof listInclude }>;

// AI 서버로 보낼 때 같이 가져오는 발화 (순서대로). codeBlocks는 AI-01(v2)에만 보낸다
export const messagesInclude = {
    messages: {
        orderBy: { sequence: "asc" },
        select: { sourceMessageId: true, role: true, content: true, codeBlocks: true },
    },
} satisfies Prisma.ConversationInclude;

export type ConversationWithMessages = Prisma.ConversationGetPayload<{ include: typeof messagesInclude }>;

// 비공개 가져오기(CONV-05)로 저장할 대화 (서비스에서 검증·정규화를 마친 값)
export type ImportedConversation = {
    userId: bigint;
    workspaceId: bigint | null;
    provider: ConversationProvider;
    externalConversationId: string;
    title: string | null;
    captureId: string;
    dedupKey: string;
    messages: { sourceMessageId: string; role: MessageRole; content: string; codeBlocks: string[] }[];
};

export const isDedupConflict = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

async function saveCollectedOnce(
    conversationId: bigint,
    { captureId, title, messages, resolvedUrl }: CollectedConversation,
) {
    return prisma.$transaction(async (tx) => {
        const target = await tx.conversation.findUnique({
            where: { conversationId },
            select: { userId: true, workspaceId: true, provider: true, status: true, deletedAt: true },
        });
        if (!target || target.status !== "COLLECTING" || target.deletedAt) return { result: "SKIPPED" as const };

        const key = dedupKey(target, contentKey(target.provider, messages));
        const duplicate = await tx.conversation.findUnique({
            where: { dedupKey: key },
            select: { conversationId: true },
        });
        if (duplicate && duplicate.conversationId !== conversationId) {
            await tx.conversation.update({
                where: { conversationId },
                data: {
                    status: "FAILED",
                    collectFailReason: "DUPLICATED",
                    duplicateOfId: duplicate.conversationId,
                    captureId,
                },
            });
            return { result: "DUPLICATED" as const, duplicateOf: duplicate.conversationId };
        }

        await tx.conversation.update({
            where: { conversationId },
            data: { status: "COLLECTED", captureId, title, resolvedUrl: resolvedUrl ?? null, dedupKey: key },
        });
        // 코드 블록이 없는 발화는 code_blocks를 NULL로 (예전에 수집한 발화와 같게)
        await tx.conversationMessage.createMany({
            data: messages.map(({ codeBlocks, ...message }, i) => ({
                conversationId,
                sequence: i + 1,
                ...message,
                codeBlocks: codeBlocks.length > 0 ? codeBlocks : Prisma.DbNull,
            })),
        });
        return { result: "SAVED" as const };
    });
}

export const conversationRepository = {
    create(userId: bigint, workspaceId: bigint | null, shareUrl: string, provider: ConversationProvider = "CHATGPT") {
        return prisma.conversation.create({ data: { userId, workspaceId, shareUrl, provider } });
    },

    // 비공개 가져오기: 대화와 발화를 한 번에 COLLECTED로 저장한다.
    // dedup_key가 UNIQUE라 같은 원문을 동시에 두 번 보내도 한쪽은 P2002로 실패한다 (서비스가 기존 대화를 찾아 duplicate로 응답)
    createImported({ messages, ...conversation }: ImportedConversation) {
        return prisma.$transaction(async (tx) => {
            const created = await tx.conversation.create({
                data: { ...conversation, source: "PRIVATE_IMPORT", status: "COLLECTED" },
            });
            await tx.conversationMessage.createMany({
                data: messages.map(({ codeBlocks, ...message }, i) => ({
                    conversationId: created.conversationId,
                    sequence: i + 1,
                    ...message,
                    codeBlocks: codeBlocks.length > 0 ? codeBlocks : Prisma.DbNull,
                })),
            });
            return created;
        });
    },

    // 중복 확인 (공유 링크·비공개 가져오기 공통). 삭제한 대화는 dedup_key를 비워서 걸리지 않는다
    findByDedupKey(key: string) {
        return prisma.conversation.findUnique({
            where: { dedupKey: key },
            select: { conversationId: true, status: true, deletedAt: true },
        });
    },

    // 수집 성공: 발화를 저장하고 COLLECTED로 바꾼다. 결과: SAVED / DUPLICATED / SKIPPED
    //  - 같은 공간에 같은 AI 서비스·같은 발화의 대화(공유 링크든 비공개 가져오기든)가 이미 있으면 저장하지 않고
    //    FAILED(DUPLICATED) + duplicate_of_id = 기존 대화 (2026-11-19 공통 중복 규칙, utils/conversationKey.ts)
    //    (개인 공간: 내 개인 대화끼리, 팀 공간: 그 팀 대화끼리. 링크·제목은 보지 않고, 대화가 이어져 발화가 늘었으면 새 대화)
    //  - 수집 중에 대화를 삭제했으면 아무것도 하지 않는다
    //  - 같은 내용을 동시에 저장하면 dedup_key UNIQUE로 한쪽이 실패 → 한 번 더 시도해서 DUPLICATED로 정리
    async saveCollected(conversationId: bigint, collected: CollectedConversation) {
        try {
            return await saveCollectedOnce(conversationId, collected);
        } catch (err) {
            if (!isDedupConflict(err)) throw err;
            return saveCollectedOnce(conversationId, collected);
        }
    },

    markCollectFailed(conversationId: bigint, reason: CollectFailReason) {
        return prisma.conversation.updateMany({
            where: { conversationId, status: "COLLECTING" },
            data: { status: "FAILED", collectFailReason: reason },
        });
    },

    // 서버가 켜질 때: 이전 프로세스에서 수집하다 끊긴 대화를 실패로 바꾼다 (대기열은 메모리에만 있어서 다시 이어 갈 수 없음)
    failInterruptedCollecting() {
        return prisma.conversation.updateMany({
            where: { status: "COLLECTING" },
            data: { status: "FAILED", collectFailReason: "TIMEOUT" },
        });
    },

    // 서버가 켜질 때: dedup_key가 비어 있는 수집 완료 대화에 공통 중복 키를 채운다 (2026-11-19 규칙 변경 전 데이터)
    // 이미 같은 공간에 같은 내용이 여러 개 있으면 가장 먼저 등록한 대화에만 채우고 나머지는 비워 둔다 (지우지 않음)
    async backfillDedupKeys(batchSize = 50) {
        let filled = 0;
        let lastId = 0n;
        for (;;) {
            const rows = await prisma.conversation.findMany({
                where: { status: "COLLECTED", deletedAt: null, dedupKey: null, conversationId: { gt: lastId } },
                orderBy: { conversationId: "asc" },
                take: batchSize,
                select: {
                    conversationId: true,
                    userId: true,
                    workspaceId: true,
                    provider: true,
                    messages: { orderBy: { sequence: "asc" }, select: { role: true, content: true } },
                },
            });
            if (rows.length === 0) return filled;
            for (const row of rows) {
                lastId = row.conversationId;
                if (row.messages.length === 0) continue;
                try {
                    await prisma.conversation.update({
                        where: { conversationId: row.conversationId },
                        data: { dedupKey: dedupKey(row, contentKey(row.provider, row.messages)) },
                    });
                    filled += 1;
                } catch (err) {
                    if (!isDedupConflict(err)) throw err;
                }
            }
        }
    },

    // 대화 하나와 등록자, 발화, 이 대화로 만든 문서 (삭제 문서 제외, 최신 문서부터)
    findByIdWithDetail(conversationId: bigint) {
        return prisma.conversation.findUnique({
            where: { conversationId },
            include: {
                ...registrantSelect,
                messages: {
                    orderBy: { sequence: "asc" },
                    select: { sequence: true, sourceMessageId: true, role: true, content: true },
                },
                documentConversations: {
                    where: { document: { deletedAt: null } },
                    orderBy: { documentId: "desc" },
                    select: { document: { select: { documentId: true, title: true } } },
                },
            },
        });
    },

    // 삭제 전 확인용: 대화와, 이 대화를 쓰는 작업 중 삭제를 막는 것만 (설계서: 생성 중에만 삭제 불가)
    //  - 진행 중인 생성 요청(GENERATING). 문서가 아직 없어서 generation_conversations로 본다
    //  - AI 보완·재시도 중인 초안이 있는 문서 (예전 데이터의 첫 초안 생성 중 문서 포함)
    //  - _count: 이 대화를 쓰는 문서 수 (휴지통 문서 포함). 팀 일반 구성원은 0일 때만 지울 수 있다
    findByIdWithBlockingDocuments(conversationId: bigint) {
        return prisma.conversation.findUnique({
            where: { conversationId },
            include: {
                _count: { select: { documentConversations: true } },
                generationConversations: {
                    where: { generation: { status: "GENERATING" } },
                    select: { generationId: true },
                },
                documentConversations: {
                    where: {
                        document: {
                            deletedAt: null,
                            OR: [{ status: "GENERATING" }, { drafts: { some: { status: "GENERATING" } } }],
                        },
                    },
                    select: { documentId: true },
                },
            },
        });
    },

    // 소프트 삭제. 발화(conversation_messages)는 지우지 않는다 (문서 생성 기록과 함께 남김)
    // 중복 키(dedup_key)는 비운다: 지운 뒤 같은 대화를 다시 등록·가져올 수 있게
    softDelete(conversationId: bigint) {
        return prisma.conversation.update({
            where: { conversationId },
            data: { deletedAt: new Date(), dedupKey: null },
        });
    },

    // 이 공간의 삭제하지 않은 대화 중 아이디가 맞는 것 (발화 포함, 문서 생성 AI-01에 보냄)
    findActiveByIds(space: SpaceFilter, conversationIds: bigint[]) {
        return prisma.conversation.findMany({
            where: { ...space, deletedAt: null, conversationId: { in: conversationIds } },
            include: messagesInclude,
        });
    },

    // 이 공간의 삭제하지 않은 대화를 등록일 최신순(같으면 아이디 내림차순)으로 한 페이지와 전체 개수
    findPageBySpace(space: SpaceFilter, { skip, take }: { skip: number; take: number }) {
        const where: Prisma.ConversationWhereInput = { ...space, deletedAt: null };
        return prisma.$transaction([
            prisma.conversation.findMany({
                where,
                orderBy: [{ createdAt: "desc" }, { conversationId: "desc" }],
                skip,
                take,
                include: listInclude,
            }),
            prisma.conversation.count({ where }),
        ]);
    },
};
