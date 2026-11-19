import { z } from "zod";
import type { Draft } from "../generated/prisma/client.js";
import type { ConversationWithMessages } from "../repositories/conversation.repository.js";
import { draftRepository } from "../repositories/draft.repository.js";
import { canEditDraft, getAccess } from "./workspaceAccess.js";
import { touchSearchIndex } from "./searchIndex.js";
import { touchRelationIndex } from "./relationIndex.js";
import { toUserRef } from "../schemas/common.schema.js";
import {
    describeAiError,
    requestRevision,
    toAnalysisConversationsV2,
    type AnalysisConversationV2,
} from "../utils/aiServer.js";
import { AppError } from "../utils/appError.js";
import type { ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type {
    AcceptDraftResponse,
    AcceptDraftsBody,
    AcceptDraftsResponse,
    CreateRevisionBody,
    CreateRevisionResponse,
    DraftDetail,
    DraftReview,
    RetryDraftResponse,
    UpdateDraftBody,
    UpdateDraftResponse,
} from "../schemas/draft.schema.js";

// drafts.keywords는 JSON 컬럼이라 배열이 아니면(생성 전 null) 빈 배열
function toKeywords(keywords: unknown): string[] {
    return Array.isArray(keywords) ? (keywords as string[]) : [];
}

// ---- AI 문서 원본 정보(drafts.ai_detail) → DRAFT-02 응답 ----
// ai_detail은 AI 응답을 검사하지 않고 그대로 저장한 JSON이라, 화면에 쓰는 값만 여기서 골라 검사한다. 형식이 다르면 없는 것으로 본다

const aiSourceSchema = z.looseObject({
    conversationId: z.coerce.number().int(),
    sourceId: z.string(),
    role: z.string().nullish(),
});

const aiReviewSchema = z.looseObject({
    status: z.string(),
    label: z.string(),
    findings: z
        .array(
            z.looseObject({
                category: z.string(),
                certainty: z.string(),
                fieldPath: z.string(),
                passage: z.string(),
                reason: z.string().default(""),
                impact: z.string().default(""),
                suggestion: z.string().default(""),
                evidence: z
                    .array(
                        z.looseObject({
                            kind: z.string(),
                            text: z.string(),
                            sources: z.array(aiSourceSchema).default([]),
                        }),
                    )
                    .default([]),
            }),
        )
        .default([]),
});

const aiDetailSchema = z.looseObject({
    review: z.unknown().optional(),
    sourceLinks: z.unknown().optional(),
    uncertainties: z.unknown().optional(),
});

function toSourceRef({ conversationId, sourceId, role }: z.infer<typeof aiSourceSchema>) {
    const upper = role?.toUpperCase();
    return {
        conversationId,
        sourceId,
        role: upper === "USER" || upper === "ASSISTANT" ? (upper as "USER" | "ASSISTANT") : null,
    };
}

// AI 검토의 fieldPath는 AI 쪽 필드 이름이다. 본문(body_markdown)만 우리 이름(content)으로 바꾸고 나머지는 그대로 둔다
function toFieldPath(fieldPath: string) {
    return fieldPath === "body_markdown" ? "content" : fieldPath;
}

function toAiView(aiDetail: unknown): {
    review: DraftReview | null;
    sourceLinks: ReturnType<typeof toSourceRef>[];
    uncertainties: string[];
} {
    const detail = aiDetailSchema.safeParse(aiDetail);
    if (!detail.success) return { review: null, sourceLinks: [], uncertainties: [] };

    const review = aiReviewSchema.safeParse(detail.data.review);
    const sourceLinks = z.array(aiSourceSchema).safeParse(detail.data.sourceLinks);
    const uncertainties = z.array(z.string()).safeParse(detail.data.uncertainties);
    return {
        review: review.success
            ? {
                  status: review.data.status,
                  label: review.data.label,
                  findings: review.data.findings.map((finding) => ({
                      category: finding.category,
                      certainty: finding.certainty,
                      fieldPath: toFieldPath(finding.fieldPath),
                      passage: finding.passage,
                      reason: finding.reason,
                      impact: finding.impact,
                      suggestion: finding.suggestion,
                      evidence: finding.evidence.map(({ kind, text, sources }) => ({
                          kind,
                          text,
                          sources: sources.map(toSourceRef),
                      })),
                  })),
              }
            : null,
        sourceLinks: sourceLinks.success ? sourceLinks.data.map(toSourceRef) : [],
        uncertainties: uncertainties.success ? uncertainties.data : [],
    };
}

// 초안을 고칠 권한 확인 (직접 수정·AI 보완·다시 시도·채택 공통)
//  - 볼 수 없는 문서(다른 회원·내가 팀원이 아닌 팀)·삭제한 문서의 초안은 404
//  - 팀 일반 구성원이 남이 최초 생성 요청한 문서를 고치려 하면 403
async function requireDraftEditor(
    userId: number,
    document: { userId: bigint | null; workspaceId: bigint | null; deletedAt: Date | null },
) {
    const access = document.deletedAt ? null : await getAccess(userId, document);
    if (!access) throw new AppError("DRAFT_NOT_FOUND");
    if (!canEditDraft(access)) throw new AppError("FORBIDDEN");
}

// 채택·직접 수정할 수 있는 초안을 찾는다: 고칠 권한이 있고, 생성이 끝난 회차(GENERATED)이고, 문서가 아직 채택 전(DRAFT_GENERATED)이며
// AI 보완이 진행 중이 아니어야 한다. 회차 버전 복원(HIST-04)에서도 쓴다
export async function findEditableDraft(userId: number, draftId: number) {
    const draft = await draftRepository.findWithDocumentState(BigInt(draftId));
    if (!draft) throw new AppError("DRAFT_NOT_FOUND");
    await requireDraftEditor(userId, draft.document);
    if (draft.status !== "GENERATED" || draft.document.status !== "DRAFT_GENERATED") {
        throw new AppError("INVALID_DRAFT_STATUS");
    }
    if (draft.document.drafts.length > 0) throw new AppError("REVISION_IN_PROGRESS");
    return draft;
}

// AI 보완에 보낼 원본 대화를 만들고 보낼 수 있는지 확인한다 (DRAFT-04·DRAFT-05 공용)
//  - 빈 발화·발화 없는 대화는 뺀다 (AI 서버가 422로 거절). 발화에 코드 블록이 있으면 codeBlocks로 같이 보낸다
//  - 누락 내용 보완(MISSING_CONTENT)인데 남는 대화가 없으면 409 SOURCES_DELETED (설계서 P04)
//  - 분량 줄이기(TOO_LONG)만이면 대화가 없어도 된다 (초안만으로 보완). 대화가 남아 있으면 출처 연결(sourceLinks)용으로 같이 보낸다
function toRevisionInput(
    reasons: string[],
    conversations: ConversationWithMessages[],
    message: string,
): AnalysisConversationV2[] {
    const input = toAnalysisConversationsV2(conversations);
    if (reasons.includes("MISSING_CONTENT") && input.length === 0) throw new AppError("SOURCES_DELETED", { message });
    return input;
}

// AI-03: 기준 회차와 보완 항목, 남아 있는 원본 대화(발화)를 AI 서버로 보내고, 응답으로 받은 보완본을 새 회차(draftId)에 저장한다.
// AI 보완 요청(DRAFT-04)과 보완 재시도(DRAFT-05)에서 쓴다. 호출하는 쪽은 await 하지 않는다. 기준 회차는 그대로 남는다.
// 실패하면 새 회차를 FAILED로 바꿔서 A05-2에 '보완 실패'와 '다시 시도'가 보이게 한다.
export async function sendRevisionRequest(
    draftId: bigint,
    base: Draft,
    reasons: string[],
    conversations: AnalysisConversationV2[],
) {
    try {
        const result = await requestRevision(
            Number(draftId),
            // AI 서버는 요약을 문자열로만 받는다 (예전 데이터에서 비어 있으면 빈 문자열)
            {
                title: base.title,
                category: base.category,
                summary: base.summary ?? "",
                keywords: toKeywords(base.keywords),
                content: base.content,
            },
            reasons,
            conversations,
        );
        if (await draftRepository.saveRevisionResult(draftId, result)) {
            logger.info("AI 보완 초안을 생성하였습니다.", { draftId, baseDraftId: base.draftId });
        }
    } catch (err) {
        const { failReason, logCode, message } = describeAiError(err, "REVISION_FAILED");
        logger.error(logCode, message, { draftId });
        await draftRepository
            .markRevisionFailed(draftId, failReason, message)
            .catch((dbErr) =>
                logger.error("DATABASE_ERROR", `실패 처리 저장 실패: ${(dbErr as Error).name}`, { draftId }),
            );
    }
}

// 보완 재시도(A05-2 보완 실패의 '다시 시도'): 실패한 회차와 같은 번호·기준 회차·보완 항목으로 새 행을 만들고 AI-03을 다시 보낸다.
// 기준 회차는 지금 저장된 내용을 쓴다(실패 뒤 직접 수정했다면 수정본). 보완 요청(DRAFT-04)과 같은 조건을 확인한다.
async function retryRevision(
    userId: number,
    draft: NonNullable<Awaited<ReturnType<typeof draftRepository.findForRetry>>>,
    conversations: ConversationWithMessages[],
): Promise<RetryDraftResponse> {
    const { parent, document } = draft;
    if (!parent || parent.status !== "GENERATED" || document.status !== "DRAFT_GENERATED")
        throw new AppError("INVALID_DRAFT_STATUS");

    const reasons = draft.feedbacks.map(({ reason }) => reason);
    const input = toRevisionInput(
        reasons,
        conversations,
        "원본 대화가 모두 삭제되어 누락 내용 보완을 다시 요청할 수 없습니다.",
    );

    const created = await draftRepository.createRevision(
        draft.documentId,
        parent.draftId,
        BigInt(userId),
        reasons,
        draft.versionNo,
    );
    if (!created) throw new AppError("REVISION_IN_PROGRESS");

    void sendRevisionRequest(created.draftId, parent, reasons, input);
    return { draftId: Number(created.draftId), status: "GENERATING" };
}

export const draftService = {
    // 프론트가 생성 상태를 폴링하는 API. 볼 수 없는 문서(다른 회원·내가 팀원이 아닌 팀)의 초안, 삭제한 문서의 초안은 404
    async get(userId: number, draftId: number): Promise<DraftDetail> {
        const draft = await draftRepository.findByIdWithDocument(BigInt(draftId));
        const access = draft && !draft.document.deletedAt ? await getAccess(userId, draft.document) : null;
        if (!draft || !access) throw new AppError("DRAFT_NOT_FOUND");

        const { document } = draft;
        return {
            draftId: Number(draft.draftId),
            documentId: Number(draft.documentId),
            generationId: document.generationId === null ? null : Number(document.generationId),
            parentDraftId: draft.parentDraftId === null ? null : Number(draft.parentDraftId),
            versionNo: draft.versionNo,
            status: draft.status,
            title: draft.title,
            summary: draft.summary,
            category: draft.category,
            keywords: toKeywords(draft.keywords),
            content: draft.content,
            feedbacks: draft.feedbacks.map(({ reason }) => reason),
            createdAt: draft.createdAt,
            documentStatus: document.status,
            revising: document.drafts.length > 0,
            requester: toUserRef(document.user),
            lastEditor: toUserRef(document.lastEditor),
            draftRequester: toUserRef(draft.requester),
            canEdit: canEditDraft(access),
            conversations: document.sources.map(({ conversation }) => ({
                conversationId: Number(conversation.conversationId),
                title: conversation.title,
                deleted: conversation.deletedAt !== null,
            })),
            ...toAiView(draft.aiDetail),
            // 검토 의견은 AI 원본 기준이라, 이 회차를 직접 저장·복원한 적이 있으면 수정 전 내용에 대한 의견이다
            reviewOutdated: draft._count.versions > 0,
        };
    },

    // 실패한 AI 보완 회차(2회차 이상)를 같은 기준 회차·보완 항목으로 다시 요청한다(AI-03). 실패한 행은 남기고 같은 회차의 새 행을 만들어 바로 응답한다.
    // 2026-11-15부터 첫 생성 실패는 생성 요청 다시 시도(GEN-02)로 한다. 1회차 초안은 실패 상태로 만들어지지 않고,
    // 예전 데이터의 실패한 1회차는 다시 시도할 수 없다(409, 문서를 지우고 새로 생성)
    async retry(userId: number, draftId: number): Promise<RetryDraftResponse> {
        const draft = await draftRepository.findForRetry(BigInt(draftId));
        if (!draft) throw new AppError("DRAFT_NOT_FOUND");
        await requireDraftEditor(userId, draft.document);

        // 실패한 보완 회차만, 그리고 그 회차의 가장 최근 시도만 (이미 재시도했으면 새 행으로 다시 시도해야 함)
        if (
            draft.status !== "FAILED" ||
            draft.versionNo === 1 ||
            (await draftRepository.hasNewerAttempt(draft.documentId, draft.versionNo, draft.draftId))
        ) {
            throw new AppError("INVALID_DRAFT_STATUS");
        }
        // 남아 있는 대화로만 다시 보완한다 (누락 내용 보완인데 대화가 모두 삭제됐으면 409, retryRevision에서 확인)
        const conversations = draft.document.sources.map(({ conversation }) => conversation);
        return retryRevision(userId, draft, conversations);
    },

    // 고른 회차를 기준으로 AI 보완(새 회차)을 요청한다. 기준 회차는 저장된 내용(직접 수정했다면 수정본) 그대로 쓰고 GENERATED로 남는다.
    // 새 회차를 GENERATING으로 만들고 바로 응답하며, AI 서버 요청(AI-03)은 뒤에서 보낸다. AI 서버가 응답으로 보완본을 주면 새 회차에 저장한다.
    async requestRevision(
        userId: number,
        draftId: number,
        { reasons }: CreateRevisionBody,
    ): Promise<CreateRevisionResponse> {
        const base = await findEditableDraft(userId, draftId);

        // 설계서 P04: 연결 원문이 모두 삭제됐으면 '누락 내용 보완'은 고를 수 없다 (분량 줄이기는 초안만으로 가능)
        const conversations = await draftRepository.findLiveConversations(base.documentId);
        const input = toRevisionInput(
            reasons,
            conversations,
            "원본 대화가 모두 삭제되어 누락 내용 보완을 요청할 수 없습니다.",
        );

        const created = await draftRepository.createRevision(base.documentId, base.draftId, BigInt(userId), reasons);
        if (!created) throw new AppError("REVISION_IN_PROGRESS");

        // await 하지 않는다: AI 서버가 느리거나 죽어 있어도 사용자는 기다리지 않는다
        void sendRevisionRequest(created.draftId, base, reasons, input);

        return { draftId: Number(created.draftId), versionNo: created.versionNo, status: "GENERATING" };
    },

    // 고른 회차를 지식 문서로 확정한다. 최신 회차가 아니어도 되고, 다른 회차는 GENERATED로 그대로 둔다.
    async accept(userId: number, draftId: number): Promise<AcceptDraftResponse> {
        const draft = await findEditableDraft(userId, draftId);
        const finalizedAt = await draftRepository.accept(
            { ...draft, keywords: toKeywords(draft.keywords) },
            BigInt(userId),
        );
        if (!finalizedAt) throw new AppError("INVALID_DRAFT_STATUS");
        // 채택한 문서는 AI 검색·관계도 대상이 된다 (뒤에서)
        void touchSearchIndex([draft.documentId]);
        void touchRelationIndex([draft.documentId]);

        return { documentId: Number(draft.documentId), status: "FINALIZED", finalizedAt };
    },

    // 여러 초안을 한 번에 지식 문서로 확정한다 (DRAFT-09). 같은 입력에서 나온 초안 여러 편을 골라 저장하는 편의 기능이다.
    // 하나씩 채택(DRAFT-03)과 같은 조건을 모든 초안에 먼저 확인하고, 하나라도 안 되면 아무것도 채택하지 않는다.
    // 실패 응답은 404 → 403 → 409 순으로 가장 앞선 원인 하나로 주고, details에 걸린 초안을 모두 담는다
    async acceptMany(userId: number, { draftIds }: AcceptDraftsBody): Promise<AcceptDraftsResponse> {
        const failures: { draftId: number; code: ErrorCode }[] = [];
        const targets: Awaited<ReturnType<typeof findEditableDraft>>[] = [];
        for (const draftId of draftIds) {
            try {
                targets.push(await findEditableDraft(userId, draftId));
            } catch (err) {
                if (!(err instanceof AppError)) throw err;
                failures.push({ draftId, code: err.code });
            }
        }
        // 한 문서에서는 회차 하나만 채택할 수 있다
        const documentIds = new Set<bigint>();
        for (const draft of targets) {
            if (documentIds.has(draft.documentId))
                failures.push({ draftId: Number(draft.draftId), code: "INVALID_DRAFT_STATUS" });
            documentIds.add(draft.documentId);
        }
        if (failures.length > 0) {
            const priority: ErrorCode[] = [
                "DRAFT_NOT_FOUND",
                "FORBIDDEN",
                "INVALID_DRAFT_STATUS",
                "REVISION_IN_PROGRESS",
            ];
            const code = priority.find((c) => failures.some((failure) => failure.code === c)) ?? failures[0].code;
            throw new AppError(code, { details: { draftIds: failures.map(({ draftId }) => draftId), failures } });
        }

        const finalizedAt = await draftRepository.acceptMany(
            targets.map((draft) => ({ ...draft, keywords: toKeywords(draft.keywords) })),
            BigInt(userId),
        );
        // 확인한 뒤 저장하기 전에 다른 사람이 채택한 경우 등 (전부 되돌림)
        if (!finalizedAt) throw new AppError("INVALID_DRAFT_STATUS");
        // 채택한 문서들은 AI 검색·관계도 대상이 된다 (뒤에서)
        void touchSearchIndex(targets.map((draft) => draft.documentId));
        void touchRelationIndex(targets.map((draft) => draft.documentId));

        return {
            documents: targets.map((draft) => ({
                documentId: Number(draft.documentId),
                draftId: Number(draft.draftId),
            })),
            status: "FINALIZED",
            finalizedAt,
        };
    },

    // 선택한 회차의 제목·본문을 덮어쓴다. 새 회차를 만들지 않고, 이후 채택·AI 보완의 기준이 된다.
    async update(userId: number, draftId: number, body: UpdateDraftBody): Promise<UpdateDraftResponse> {
        const draft = await findEditableDraft(userId, draftId);
        if (!(await draftRepository.updateContent(draft.draftId, draft.documentId, BigInt(userId), body))) {
            throw new AppError("INVALID_DRAFT_STATUS");
        }
        return { draftId };
    },
};
