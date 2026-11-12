import type { Conversation } from "../generated/prisma/client.js";
import { conversationRepository, type ConversationWithDocuments } from "../repositories/conversation.repository.js";
import { collectSharedConversation, CollectError } from "../utils/collector.js";
import { extractShareUrls } from "../utils/shareUrl.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import { toPageInfo } from "../schemas/common.schema.js";
import type {
    ConversationDetail,
    ConversationListItem,
    ConversationResponse,
    CreateConversationBody,
    CreateConversationResponse,
    ListConversationsQuery,
    ListConversationsResponse,
} from "../schemas/conversation.schema.js";

function toConversationResponse(conversation: Conversation, messageCount: number): ConversationResponse {
    return {
        conversationId: Number(conversation.conversationId),
        title: conversation.title,
        shareUrl: conversation.shareUrl,
        status: conversation.status,
        collectFailReason: conversation.collectFailReason,
        messageCount,
        createdAt: conversation.createdAt,
    };
}

// 대화 목록의 generation: 이 대화로 만든 문서들의 생성 결과를 하나의 상태로 묶는다
function toGeneration({ documentConversations }: ConversationWithDocuments): ConversationListItem["generation"] {
    const documents = documentConversations.map(({ document }) => document);
    const pending = documents.filter((document) => document.status !== "FINALIZED");
    // 첫 초안 생성 중이거나, 검토 중인 문서에 AI 보완 중인 초안이 있으면 생성 중
    const generating = documents.some(
        (document) =>
            document.status === "GENERATING" || document.drafts.some((draft) => draft.status === "GENERATING"),
    );

    let status: ConversationListItem["generation"]["status"] = "NONE";
    if (generating) status = "GENERATING";
    else if (documents.some((document) => document.status === "FAILED")) status = "FAILED";
    else if (pending.length > 0) status = "PENDING_REVIEW";
    else if (documents.length > 0) status = "COMPLETED";

    return {
        status,
        pendingDocuments: pending.map((document) => {
            // 버튼이 이동할 초안 (초안은 최신순)
            //  - 검토 중: 생성이 끝난 최신 회차 (AI 보완 중인 회차는 아직 내용이 없어서 건너뜀) → A05에서 이 회차를 미리 선택
            //  - 첫 초안 생성 중·실패: 가장 최근 시도 → A04 진행 확인(폴링)·다시 시도
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
    async list(userId: number, { page, limit }: ListConversationsQuery): Promise<ListConversationsResponse> {
        const [conversations, totalCount] = await conversationRepository.findPageByUser(BigInt(userId), {
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
    async create(userId: number, { url }: CreateConversationBody): Promise<CreateConversationResponse> {
        const urls = extractShareUrls(url);
        if (urls.length === 0) throw new AppError("INVALID_SHARE_URL");
        if (urls.length > 1) {
            throw new AppError("INVALID_SHARE_URL", {
                message: "서로 다른 공유 링크가 여러 개입니다. 가져올 링크 하나만 입력해 주세요.",
                details: { candidates: urls },
            });
        }
        const [shareUrl] = urls;

        // 중복 확인은 등록 때가 아니라 수집이 끝난 뒤 capture_id(내용 해시)로 한다.
        // 같은 링크라도 대화가 이어져 내용이 늘었으면 새 대화로 저장해야 해서, 링크만 보고 막지 않는다
        const conversation = await conversationRepository.create(BigInt(userId), shareUrl);
        // await 하지 않는다: 수집은 수십 초 걸려서 사용자는 기다리지 않는다
        void collect(conversation.conversationId, shareUrl);
        return { conversationId: Number(conversation.conversationId), status: "COLLECTING" };
    },

    // 다른 회원의 대화나 삭제한 대화도 없는 것과 똑같이 404로 응답한다 (있는지 여부를 알려 주지 않음)
    async get(userId: number, conversationId: number): Promise<ConversationDetail> {
        const conversation = await conversationRepository.findByIdWithDetail(BigInt(conversationId));
        if (!conversation || conversation.userId !== BigInt(userId) || conversation.deletedAt) {
            throw new AppError("CONVERSATION_NOT_FOUND");
        }

        return {
            ...toConversationResponse(conversation, conversation.messages.length),
            messages: conversation.messages,
            documents: conversation.documentConversations.map(({ document }) => ({
                documentId: Number(document.documentId),
                title: document.title,
            })),
        };
    },

    // 이 대화로 만든 문서는 지우지 않는다 (본문이 이미 저장돼 있어 편집도 계속 가능)
    // 수집 중인 대화도 지울 수 있다 (수집이 끝나도 삭제한 대화에는 저장하지 않음)
    async delete(userId: number, conversationId: number): Promise<void> {
        const conversation = await conversationRepository.findByIdWithBlockingDocuments(BigInt(conversationId));
        if (!conversation || conversation.userId !== BigInt(userId) || conversation.deletedAt) {
            throw new AppError("CONVERSATION_NOT_FOUND");
        }
        if (conversation.documentConversations.length > 0) {
            throw new AppError("CONVERSATION_IN_USE", {
                details: {
                    documentIds: conversation.documentConversations.map(({ documentId }) => Number(documentId)),
                },
            });
        }
        await conversationRepository.softDelete(conversation.conversationId);
    },
};
