import { createHash } from "node:crypto";
import { Prisma, type Conversation, type ConversationProvider } from "../generated/prisma/client.js";
import { conversationRepository, type ConversationWithDocuments } from "../repositories/conversation.repository.js";
import { canDeleteConversation, getAccess, resolveSpace, spaceFilter } from "./workspaceAccess.js";
import { toGenerationCards } from "./generation.service.js";
import { collectSharedConversation, CollectError } from "../utils/collector.js";
import { findShareLinks } from "../utils/shareUrl.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import { toPageInfo, toUserRef } from "../schemas/common.schema.js";
import type {
    ConversationDetail,
    ConversationListItem,
    ConversationResponse,
    CreateConversationBody,
    CreateConversationResponse,
    ImportConversationBody,
    ImportConversationResponse,
    ListConversationsQuery,
    ListConversationsResponse,
} from "../schemas/conversation.schema.js";

type ConversationWithRegistrant = Conversation & { user: { userId: bigint; nickname: string } | null };

function toConversationResponse(conversation: ConversationWithRegistrant, messageCount: number): ConversationResponse {
    return {
        conversationId: Number(conversation.conversationId),
        title: conversation.title,
        shareUrl: conversation.shareUrl,
        provider: conversation.provider,
        source: conversation.source,
        status: conversation.status,
        collectFailReason: conversation.collectFailReason,
        messageCount,
        registrant: toUserRef(conversation.user),
        createdAt: conversation.createdAt,
    };
}

// 대화 목록의 generation: 이 대화로 만든 문서들과 아직 문서가 없는 생성 요청을 하나의 상태로 묶는다
function toGeneration({
    documentConversations,
    generationConversations,
}: ConversationWithDocuments): ConversationListItem["generation"] {
    const documents = documentConversations.map(({ document }) => document);
    const pending = documents.filter((document) => document.status !== "FINALIZED");
    // 아직 문서가 없는 생성 요청 (생성 중, 최근 7일 안의 실패·문서 없음. 재시도 묶음은 가장 최근 시도만)
    const generations = toGenerationCards(generationConversations.map(({ generation }) => generation));
    // 생성 요청이 진행 중이거나, 검토 중인 문서에 AI 보완 중인 초안이 있으면 생성 중 (예전 데이터의 첫 초안 생성 중 문서 포함)
    const generating =
        generations.some((generation) => generation.status === "GENERATING") ||
        documents.some(
            (document) =>
                document.status === "GENERATING" || document.drafts.some((draft) => draft.status === "GENERATING"),
        );

    let status: ConversationListItem["generation"]["status"] = "NONE";
    if (generating) status = "GENERATING";
    else if (
        generations.some((generation) => generation.status === "FAILED") ||
        documents.some((document) => document.status === "FAILED")
    ) {
        status = "FAILED";
    } else if (pending.length > 0) status = "PENDING_REVIEW";
    else if (documents.length > 0) status = "COMPLETED";
    else if (generations.length > 0) status = "NO_CONTENT";

    return {
        status,
        generations,
        pendingDocuments: pending.map((document) => {
            // 버튼이 이동할 초안 (초안은 최신순)
            //  - 검토 중: 생성이 끝난 최신 회차 (AI 보완 중인 회차는 아직 내용이 없어서 건너뜀) → A05에서 이 회차를 미리 선택
            //  - (예전 데이터) 첫 초안 생성 중·실패: 가장 최근 시도
            const target =
                document.status === "DRAFT_GENERATED"
                    ? document.drafts.find((draft) => draft.status === "GENERATED")
                    : document.drafts[0];
            return {
                documentId: Number(document.documentId),
                title: target?.title ?? null,
                status: document.status as "GENERATING" | "DRAFT_GENERATED" | "FAILED",
                latestDraftId: target ? Number(target.draftId) : null,
            };
        }),
    };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// Markdown 코드 블록(``` 또는 ~~~ 울타리) 안의 코드만 뽑는다. 공유 링크 수집의 codeBlocks와 같은 용도 (AI-01에 코드 경계를 알려 줌)
function extractCodeBlocks(markdown: string): string[] {
    const blocks: string[] = [];
    for (const match of markdown.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[`~]*[ \t]*$/gm)) {
        if (match[2].trim()) blocks.push(match[2].replace(/\n$/, ""));
    }
    return blocks;
}

// 비공개 가져오기 원문 정규화: 줄바꿈을 \n으로 통일하고 앞뒤 공백만 정리 (Markdown·코드 들여쓰기는 그대로), sequence 순으로 정렬
function normalizeImportedMessages(messages: ImportConversationBody["messages"]) {
    return [...messages]
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ role, content }) => ({ role, content: content.replace(/\r\n?/g, "\n").trim() }));
}

// 공유 페이지 수집 (뒤에서 실행). 끝나면 발화를 저장하고 COLLECTED, 실패하면 FAILED + 원인
async function collect(conversationId: bigint, shareUrl: string) {
    try {
        const collected = await collectSharedConversation(shareUrl);
        const saved = await conversationRepository.saveCollected(conversationId, collected);
        if (saved.result === "SAVED")
            logger.info(`공유 대화를 수집하였습니다. 발화 ${collected.messages.length}개`, { conversationId });
        if (saved.result === "DUPLICATED") {
            logger.info(
                `이미 수집한 대화와 내용이 같아 저장하지 않았습니다. (기존 conversationId=${saved.duplicateOf})`,
                { conversationId },
            );
        }
    } catch (err) {
        const reason = err instanceof CollectError ? err.code : "COLLECT_ERROR";
        const detail = err instanceof Error ? err.message : String(err);
        if (err instanceof CollectError)
            logger.error("CONVERSATION_COLLECT_FAILED", `${reason} ${detail}`, { conversationId });
        else logger.error("DATABASE_ERROR", `수집 결과 저장 실패: ${detail.slice(0, 300)}`, { conversationId });
        await conversationRepository
            .markCollectFailed(conversationId, reason)
            .catch((dbErr) =>
                logger.error("DATABASE_ERROR", `수집 실패 저장 실패: ${(dbErr as Error).name}`, { conversationId }),
            );
    }
}

export const conversationService = {
    // workspaceId가 없으면 개인 공간(내가 등록하고 팀에 올리지 않은 대화), 있으면 그 팀의 대화 전부
    async list(
        userId: number,
        { page, limit, workspaceId }: ListConversationsQuery,
    ): Promise<ListConversationsResponse> {
        const space = await resolveSpace(userId, workspaceId);
        const [conversations, totalCount] = await conversationRepository.findPageBySpace(spaceFilter(userId, space), {
            skip: (page - 1) * limit,
            take: limit,
        });
        return {
            ...toPageInfo(page, limit, totalCount),
            conversations: conversations.map((conversation) => ({
                ...toConversationResponse(conversation, conversation._count.messages),
                generation: toGeneration(conversation),
            })),
        };
    },

    // 공유 링크를 등록하고 바로 응답한다. 수집(Chromium으로 공유 페이지 읽기)은 응답과 상관없이 뒤에서 한다(비동기).
    // 프론트는 conversationId로 원본 대화 열람(CONV-03)을 폴링해서 status가 COLLECTING이 아니게 되면 결과를 보여 준다.
    async create(userId: number, { url, workspaceId }: CreateConversationBody): Promise<CreateConversationResponse> {
        // 팀 공간이면 팀원인지 먼저 확인 (팀원이면 역할과 관계없이 등록 가능)
        const space = await resolveSpace(userId, workspaceId);
        const links = findShareLinks(url);
        if (links.length === 0) throw new AppError("INVALID_SHARE_URL");
        if (links.length > 1) {
            throw new AppError("INVALID_SHARE_URL", {
                message: "서로 다른 공유 링크가 여러 개입니다. 가져올 링크 하나만 입력해 주세요.",
                details: { candidates: links.map((link) => link.url) },
            });
        }
        const [link] = links;

        // 중복 확인은 등록 때가 아니라 수집이 끝난 뒤 capture_id(최종 주소 + 내용 해시)로 한다.
        //  - 같은 링크라도 대화가 이어져 내용이 늘었으면 새 대화로 저장해야 해서, 링크만 보고 막지 않는다
        //  - 단축 주소(g.co)와 최종 주소(gemini.google.com)는 입력이 달라도 리디렉션 뒤 최종 주소가 같으면 중복으로 잡힌다
        const conversation = await conversationRepository.create(BigInt(userId), space, link.url, link.provider);
        // await 하지 않는다: 수집은 수십 초 걸려서 사용자는 기다리지 않는다
        void collect(conversation.conversationId, link.url);
        return { conversationId: Number(conversation.conversationId), status: "COLLECTING" };
    },

    // 확장 프로그램이 읽은 비공개 대화를 바로 COLLECTED로 저장한다 (수집 단계 없음)
    // 중복: 같은 공간(개인=나, 팀=그 팀) + 서비스 + 대화 ID + 서버가 다시 계산한 원문 해시가 같으면 새로 만들지 않고 기존 대화를 돌려준다
    //  - 프론트의 contentHash는 계산 방식(확장 프로그램 메시지 배열)이 서버와 달라 형식만 확인하고 쓰지 않는다
    //  - 대화가 이어져 발화가 늘면 해시가 달라져 새 대화로 저장된다 (공유 링크와 같음)
    //  - 재전송·동시 저장은 import_key UNIQUE로 막는다
    async importConversation(
        userId: number,
        body: ImportConversationBody,
    ): Promise<ImportConversationResponse & { created: boolean }> {
        const space = await resolveSpace(userId, body.workspaceId);
        const provider = body.provider.toUpperCase() as ConversationProvider;
        const messages = normalizeImportedMessages(body.messages);
        const captureId =
            "import_" +
            sha256(JSON.stringify({ provider, externalConversationId: body.externalConversationId, messages }));
        const spaceKey = space === null ? `user:${userId}` : `workspace:${space}`;
        const importKey = sha256(`${spaceKey}|${captureId}`);

        const duplicateOf = async () => {
            const existing = await conversationRepository.findByImportKey(importKey);
            return existing && !existing.deletedAt ? existing : null;
        };
        const found = await duplicateOf();
        if (found)
            return {
                conversationId: Number(found.conversationId),
                status: "COLLECTED",
                duplicate: true,
                created: false,
            };

        const firstQuestion =
            messages
                .find((message) => message.role === "USER")
                ?.content.split("\n")[0]
                .trim() ?? "";
        const title = body.title?.trim() || firstQuestion.slice(0, 60) || null;
        try {
            const created = await conversationRepository.createImported({
                userId: BigInt(userId),
                workspaceId: space,
                provider,
                externalConversationId: body.externalConversationId,
                title,
                captureId,
                importKey,
                messages: messages.map((message, i) => ({
                    ...message,
                    sourceMessageId: `import-${i + 1}`,
                    codeBlocks: extractCodeBlocks(message.content),
                })),
            });
            return {
                conversationId: Number(created.conversationId),
                status: "COLLECTED",
                duplicate: false,
                created: true,
            };
        } catch (err) {
            // 같은 원문을 동시에 보낸 다른 요청이 먼저 저장함 → 그 대화를 중복으로 돌려준다
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                const winner = await duplicateOf();
                if (winner)
                    return {
                        conversationId: Number(winner.conversationId),
                        status: "COLLECTED",
                        duplicate: true,
                        created: false,
                    };
            }
            throw err;
        }
    },

    // 볼 수 없는 대화(다른 회원의 개인 대화, 내가 팀원이 아닌 팀의 대화)나 삭제한 대화도 없는 것과 똑같이 404로 응답한다 (있는지 여부를 알려 주지 않음)
    async get(userId: number, conversationId: number): Promise<ConversationDetail> {
        const conversation = await conversationRepository.findByIdWithDetail(BigInt(conversationId));
        if (!conversation || conversation.deletedAt || !(await getAccess(userId, conversation))) {
            throw new AppError("CONVERSATION_NOT_FOUND");
        }

        return {
            ...toConversationResponse(conversation, conversation.messages.length),
            messages: conversation.messages.map(({ sequence, sourceMessageId, role, content }) => ({
                sequence,
                sourceId: sourceMessageId,
                role,
                content,
            })),
            documents: conversation.documentConversations.map(({ document }) => ({
                documentId: Number(document.documentId),
                title: document.title,
            })),
        };
    },

    // 이 대화로 만든 문서는 지우지 않는다 (본문이 이미 저장돼 있어 편집도 계속 가능)
    // 수집 중인 대화도 지울 수 있다 (수집이 끝나도 삭제한 대화에는 저장하지 않음)
    // 팀 대화: 소유자·관리자는 전부, 일반 구성원은 내가 등록했고 어떤 문서도 쓰지 않는 대화만 (아니면 403)
    async delete(userId: number, conversationId: number): Promise<void> {
        const conversation = await conversationRepository.findByIdWithBlockingDocuments(BigInt(conversationId));
        const access = conversation && !conversation.deletedAt ? await getAccess(userId, conversation) : null;
        if (!conversation || !access) throw new AppError("CONVERSATION_NOT_FOUND");
        if (!canDeleteConversation(access, conversation._count.documentConversations > 0))
            throw new AppError("FORBIDDEN");
        if (conversation.generationConversations.length > 0 || conversation.documentConversations.length > 0) {
            throw new AppError("CONVERSATION_IN_USE", {
                details: {
                    generationIds: conversation.generationConversations.map(({ generationId }) => Number(generationId)),
                    documentIds: conversation.documentConversations.map(({ documentId }) => Number(documentId)),
                },
            });
        }
        await conversationRepository.softDelete(conversation.conversationId);
    },
};
