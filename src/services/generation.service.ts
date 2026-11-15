import { env } from "../config/env.js";
import type { ConversationWithMessages } from "../repositories/conversation.repository.js";
import { documentRepository } from "../repositories/document.repository.js";
import { generationRepository, rootGenerationId } from "../repositories/generation.repository.js";
import { recentResultSince, type GenerationCardRow } from "../repositories/generationCard.select.js";
import { canEditDraft, getAccess } from "./workspaceAccess.js";
import { toUserRef } from "../schemas/common.schema.js";
import {
  countInputChars,
  describeAiError,
  requestAnalysis,
  toAnalysisConversationsV2,
  type AnalysisConversationV2,
} from "../utils/aiServer.js";
import { AppError } from "../utils/appError.js";
import { logger } from "../utils/logger.js";
import type { GenerationCard, GenerationDetail, RetryGenerationResponse } from "../schemas/generation.schema.js";

// 생성 요청 (2026-11-15 지식 분할 저장)
// 문서 생성 요청(DRAFT-01)과 다시 시도(GEN-02)가 AI-01(/v2/analyses)을 보내고, 응답으로 받은 문서 N편을 한 번에 저장한다

// 대화를 AI-01 요청 형식으로 바꾸고 보낼 수 있는지 확인한다 (DRAFT-01·GEN-02 공용)
//  - 빈 발화·발화 없는 대화를 빼고 남는 대화가 없으면 409 SOURCES_DELETED (AI 서버가 422로 거절하므로 보내지 않음)
//  - 발화 글자 수 합계가 AI_MAX_INPUT_CHARS를 넘으면 400 INPUT_TOO_LARGE (AI 출력 한도를 넘어 응답이 중간에 끊기는 것을 막음)
export function toAnalysisInput(conversations: ConversationWithMessages[]): AnalysisConversationV2[] {
  const input = toAnalysisConversationsV2(conversations);
  if (input.length === 0) throw new AppError("SOURCES_DELETED", { message: "분석할 발화가 남아 있는 대화가 없습니다." });
  const totalChars = countInputChars(input);
  if (totalChars > env.AI_MAX_INPUT_CHARS) {
    throw new AppError("INPUT_TOO_LARGE", { details: { totalChars, maxChars: env.AI_MAX_INPUT_CHARS } });
  }
  return input;
}

// 고른 대화를 쓰는 작업이 진행 중이면 409 CONVERSATION_IN_USE (DRAFT-01·GEN-02 공용)
//  - 진행 중인 생성 요청, AI 보완 중인 문서(예전 데이터의 첫 초안 생성 중 문서 포함)
export async function ensureNotInUse(conversationIds: bigint[]) {
  const [generations, documents] = await Promise.all([
    generationRepository.findGeneratingByConversationIds(conversationIds),
    documentRepository.findGeneratingByConversationIds(conversationIds),
  ]);
  if (generations.length > 0 || documents.length > 0) {
    throw new AppError("CONVERSATION_IN_USE", {
      details: {
        generationIds: generations.map(({ generationId }) => Number(generationId)),
        documentIds: documents.map(({ documentId }) => Number(documentId)),
      },
    });
  }
}

// AI-01: 발화를 AI 서버로 보내고, 응답으로 받은 문서 N편을 저장한다.
// AI 서버가 GPT로 문서를 만들고 검토하는 동안(수십 초~수 분) 기다리므로 호출하는 쪽은 await 하지 않는다.
// documentId 자리에는 재시도 묶음의 첫 요청 번호를 보낸다: AI 서버는 같은 입력이면 성공했던 모델 호출을 캐시에서 꺼내 써서,
// 시간 초과 뒤 다시 시도할 때 AI 쪽에서 이미 끝난 결과를 비용 없이 받을 수 있다.
// 실패하면(요청 실패, 시간 초과, AI 서버 실패 응답, 형식 오류) 생성 요청을 FAILED로 바꿔서 '다시 시도'(GEN-02)할 수 있게 한다.
export async function sendGenerationRequest(
  generation: { generationId: bigint; retriedFromId: bigint | null },
  conversations: AnalysisConversationV2[],
) {
  const { generationId } = generation;
  try {
    const result = await requestAnalysis(Number(rootGenerationId(generation)), conversations);
    const documentIds = await generationRepository.saveResult(generationId, result);
    if (documentIds) {
      logger.info(`지식 문서 초안 ${documentIds.length}편을 생성하였습니다. (documentId ${documentIds.join(", ") || "없음"}, 검토 ${result.reviewStatus})`, {
        generationId,
      });
    }
  } catch (err) {
    const { failReason, logCode, message } = describeAiError(err, "GENERATION_FAILED");
    logger.error(logCode, message, { generationId });
    await generationRepository
      .markFailed(generationId, failReason, message)
      .catch((dbErr) => logger.error("DATABASE_ERROR", `실패 처리 저장 실패: ${(dbErr as Error).name}`, { generationId }));
  }
}

// 아직 문서가 없는 생성 요청 카드 (DRAFT-08, CONV-02):
// 재시도 묶음마다 가장 최근 시도만 남기고(재시도해서 성공했으면 카드 없음), 그중 생성 중이거나 최근 7일 안에 실패·문서 없음으로 끝난 것만
export function toGenerationCards(generations: GenerationCardRow[]): GenerationCard[] {
  const latest = new Map<bigint, GenerationCardRow>();
  for (const generation of generations) {
    const root = rootGenerationId(generation);
    const current = latest.get(root);
    if (!current || generation.generationId > current.generationId) latest.set(root, generation);
  }
  const since = recentResultSince();
  return [...latest.values()]
    .filter((generation) => generation.status === "GENERATING" || (generation.status !== "COMPLETED" && generation.createdAt >= since))
    .sort((a, b) => (a.generationId > b.generationId ? -1 : 1))
    .map((generation) => ({
      generationId: Number(generation.generationId),
      status: generation.status as GenerationCard["status"],
      failReason: generation.failReason as GenerationCard["failReason"],
      noContentReason: generation.noContentReason,
      conversations: generation.conversations.map(({ conversation }) => ({
        conversationId: Number(conversation.conversationId),
        title: conversation.title,
      })),
      requester: toUserRef(generation.user),
      createdAt: generation.createdAt,
    }));
}

function toKeywords(keywords: unknown): string[] {
  return Array.isArray(keywords) ? (keywords as string[]) : [];
}

// drafts.ai_detail.review.label (없으면 null)
function reviewLabel(aiDetail: unknown): string | null {
  const review = (aiDetail as { review?: { label?: unknown } } | null)?.review;
  return typeof review?.label === "string" ? review.label : null;
}

export const generationService = {
  // 생성 요청 상태 조회(GEN-01). 프론트가 생성 중에 폴링한다. 볼 수 없는(다른 회원·내가 팀원이 아닌 팀) 요청은 404
  async get(userId: number, generationId: number): Promise<GenerationDetail> {
    const generation = await generationRepository.findByIdWithDetail(BigInt(generationId));
    if (!generation || !(await getAccess(userId, generation))) throw new AppError("GENERATION_NOT_FOUND");

    return {
      generationId: Number(generation.generationId),
      status: generation.status,
      failReason: generation.failReason as GenerationDetail["failReason"],
      noContentReason: generation.noContentReason,
      reviewStatus: generation.reviewStatus,
      conversations: generation.conversations.map(({ conversation }) => ({
        conversationId: Number(conversation.conversationId),
        title: conversation.title,
        deleted: conversation.deletedAt !== null,
      })),
      // 새 흐름의 문서는 1회차 초안(AI 원본)을 항상 가진다
      documents: generation.documents
        .filter((document) => document.drafts.length > 0)
        .map(({ documentId, status, drafts: [draft] }) => ({
          documentId: Number(documentId),
          draftId: Number(draft.draftId),
          documentStatus: status as "DRAFT_GENERATED" | "FINALIZED",
          title: draft.title,
          category: draft.category,
          summary: draft.summary,
          keywords: toKeywords(draft.keywords),
          reviewLabel: reviewLabel(draft.aiDetail),
        })),
      requester: toUserRef(generation.user),
      createdAt: generation.createdAt,
      completedAt: generation.completedAt,
    };
  },

  // 생성 다시 시도(GEN-02): 실패한 요청은 남기고 남아 있는 대화로 새 요청을 GENERATING으로 만들어 바로 응답한다.
  // 실패한(FAILED) 요청이면서 재시도 묶음의 가장 최근 시도일 때만 (아니면 409 INVALID_GENERATION_STATUS)
  // 팀: 소유자·관리자는 모두, 일반 구성원은 본인이 요청한 생성만 (아니면 403, 초안 다시 시도와 같은 기준)
  async retry(userId: number, generationId: number): Promise<RetryGenerationResponse> {
    const failed = await generationRepository.findForRetry(BigInt(generationId));
    const access = failed ? await getAccess(userId, failed) : null;
    if (!failed || !access) throw new AppError("GENERATION_NOT_FOUND");
    if (!canEditDraft(access)) throw new AppError("FORBIDDEN");
    if (failed.status !== "FAILED") throw new AppError("INVALID_GENERATION_STATUS");

    // 실패한 요청의 대화는 삭제할 수 있어서(CONV-04) 남은 대화로만 다시 분석한다
    const conversations = failed.conversations.map(({ conversation }) => conversation);
    if (conversations.length === 0) throw new AppError("SOURCES_DELETED", { message: "원본 대화가 모두 삭제되어 다시 생성할 수 없습니다." });
    const input = toAnalysisInput(conversations);
    const ids = conversations.map(({ conversationId }) => conversationId);
    await ensureNotInUse(ids);

    const created = await generationRepository.createRetry(failed, BigInt(userId), ids);
    if (!created) throw new AppError("INVALID_GENERATION_STATUS");

    // await 하지 않는다: AI 서버 요청은 뒤에서 보낸다
    void sendGenerationRequest(created, input);
    return { generationId: Number(created.generationId), status: "GENERATING" };
  },
};
