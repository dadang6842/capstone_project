import { prisma } from "../config/prisma.js";
import type { FailReason, Prisma, ReviewStatus } from "../generated/prisma/client.js";
import type { AnalysisDocument, AnalysisResult } from "../utils/aiServer.js";
import type { SpaceFilter } from "../services/workspaceAccess.js";
import { messagesInclude } from "./conversation.repository.js";
import { generationCardSelect, recentResultSince } from "./generationCard.select.js";
import { versionRepository } from "./version.repository.js";

// 생성 요청(generations) 저장소 (2026-11-15 지식 분할 저장)
// 생성 요청 1번 = AI-01(/v2/analyses) 시도 1번. AI가 몇 편을 줄지 미리 몰라서 문서는 응답을 받은 뒤 한 번에 만든다

const userRef = { select: { userId: true, nickname: true } } as const;

// generations의 VARCHAR(1000)·VARCHAR(100) 컬럼
const TEXT_MAX = 1000;
const RUN_ID_MAX = 100;

const REVIEW_STATUS: Record<AnalysisResult["reviewStatus"], ReviewStatus> = {
  completed: "COMPLETED",
  incomplete: "INCOMPLETE",
  pending: "PENDING",
  not_applicable: "NOT_APPLICABLE",
};

// AI 문서 1편에서 기본 5개 필드와 artifactId를 뺀 나머지 = drafts.ai_detail (받은 그대로)
function toAiDetail({ artifactId: _artifactId, title: _t, category: _c, summary: _s, keywords: _k, content: _b, ...detail }: AnalysisDocument) {
  return detail as Prisma.InputJsonObject;
}

// 이 문서가 출처로 가리킨 대화 (sourceLinks[].conversationId). 생성 요청에 고른 대화 중에서만 고르고, 하나도 없으면 고른 대화 전부
function sourceConversationIds(document: AnalysisDocument, requested: bigint[]) {
  const links = Array.isArray(document.sourceLinks) ? (document.sourceLinks as { conversationId?: unknown }[]) : [];
  const linked = new Set(links.map(({ conversationId }) => String(conversationId)));
  const picked = requested.filter((id) => linked.has(String(id)));
  return picked.length > 0 ? picked : requested;
}

// 재시도 묶음의 첫 요청 번호 (AI 서버에 documentId로 보내는 값)
export function rootGenerationId(generation: { generationId: bigint; retriedFromId: bigint | null }) {
  return generation.retriedFromId ?? generation.generationId;
}

export const generationRepository = {
  // 이 대화들을 쓰는 진행 중인 생성 요청 (문서 생성 요청 409, 대화 삭제 409)
  findGeneratingByConversationIds(conversationIds: bigint[]) {
    return prisma.generation.findMany({
      where: { status: "GENERATING", conversations: { some: { conversationId: { in: conversationIds } } } },
      select: { generationId: true },
    });
  },

  // 생성 요청(GENERATING) + 고른 대화를 한 번에 만든다. 다시 시도면 retriedFromId에 재시도 묶음의 첫 요청
  create(userId: bigint, workspaceId: bigint | null, conversationIds: bigint[], retriedFromId: bigint | null = null) {
    return prisma.generation.create({
      data: {
        userId,
        workspaceId,
        retriedFromId,
        conversations: { create: conversationIds.map((conversationId) => ({ conversationId })) },
      },
      select: { generationId: true, retriedFromId: true },
    });
  },

  // 다시 시도: 실패한 요청이 재시도 묶음의 가장 최근 시도일 때만 새 행을 만든다 (버튼을 두 번 눌러도 하나만, 아니면 null)
  // 묶음의 첫 요청 행을 잠가서 동시에 다시 시도해도 겹치지 않게 한다
  createRetry(failed: { generationId: bigint; retriedFromId: bigint | null; workspaceId: bigint | null }, userId: bigint, conversationIds: bigint[]) {
    const rootId = rootGenerationId(failed);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT generation_id FROM generations WHERE generation_id = ${rootId} FOR UPDATE`;
      const newer = await tx.generation.count({
        where: { OR: [{ generationId: rootId }, { retriedFromId: rootId }], generationId: { gt: failed.generationId } },
      });
      const current = await tx.generation.findUnique({ where: { generationId: failed.generationId }, select: { status: true } });
      if (newer > 0 || current?.status !== "FAILED") return null;
      return tx.generation.create({
        data: {
          userId,
          workspaceId: failed.workspaceId,
          retriedFromId: rootId,
          conversations: { create: conversationIds.map((conversationId) => ({ conversationId })) },
        },
        select: { generationId: true, retriedFromId: true },
      });
    });
  },

  // 생성 요청 상태 조회(GEN-01): 요청자, 고른 대화(삭제 여부), 만들어진 문서(휴지통 제외)와 1회차 초안
  findByIdWithDetail(generationId: bigint) {
    return prisma.generation.findUnique({
      where: { generationId },
      include: {
        user: userRef,
        conversations: {
          orderBy: { conversationId: "asc" },
          select: { conversation: { select: { conversationId: true, title: true, deletedAt: true } } },
        },
        documents: {
          where: { deletedAt: null },
          orderBy: { documentId: "asc" },
          select: {
            documentId: true,
            status: true,
            drafts: {
              where: { versionNo: 1, status: { in: ["GENERATED", "ACCEPTED"] } },
              take: 1,
              select: { draftId: true, title: true, category: true, summary: true, keywords: true, aiDetail: true },
            },
          },
        },
      },
    });
  },

  // 다시 시도(GEN-02)용: 실패한 요청과 고른 대화 중 남아 있는 것(발화 포함)
  findForRetry(generationId: bigint) {
    return prisma.generation.findUnique({
      where: { generationId },
      include: {
        conversations: {
          where: { conversation: { deletedAt: null } },
          orderBy: { conversationId: "asc" },
          select: { conversation: { include: messagesInclude } },
        },
      },
    });
  },

  // 이 공간의 아직 문서가 없는 생성 요청 카드용 (DRAFT-08): 생성 중이거나 최근 7일 안의 요청.
  // 재시도 묶음별 최신 시도만 고르는 일은 서비스에서 한다 (toGenerationCards)
  findRecentBySpace(space: SpaceFilter) {
    return prisma.generation.findMany({
      where: { ...space, OR: [{ status: "GENERATING" }, { createdAt: { gte: recentResultSince() } }] },
      orderBy: { generationId: "desc" },
      select: generationCardSelect,
    });
  },

  // AI-01 응답 저장: 문서 1편마다 문서(DRAFT_GENERATED) + 출처 대화 연결 + 1회차 초안(GENERATED) + 회차 이력(AI_GENERATED)을 만들고
  // 생성 요청을 COMPLETED(문서 없음이면 NO_CONTENT)로 바꾼다. 한 트랜잭션이라 중간에 실패하면 아무것도 저장되지 않는다.
  // 기다리는 사이 상태가 바뀌었거나(서버 재시작으로 실패 처리됨 등) 팀이 삭제됐으면 저장하지 않는다 (null)
  saveResult(generationId: bigint, result: AnalysisResult) {
    return prisma.$transaction(
      async (tx) => {
        const documents = result.status === "drafts_stored" ? result.documents : [];
        const { count } = await tx.generation.updateMany({
          where: { generationId, status: "GENERATING", OR: [{ workspaceId: null }, { workspace: { deletedAt: null } }] },
          data: {
            status: documents.length > 0 ? "COMPLETED" : "NO_CONTENT",
            aiRunId: result.runId.slice(0, RUN_ID_MAX),
            reviewStatus: REVIEW_STATUS[result.reviewStatus],
            reviewError: result.reviewError?.message.slice(0, TEXT_MAX) ?? null,
            noContentReason: documents.length > 0 ? null : (result.noDocumentReason ?? "").slice(0, TEXT_MAX) || null,
            documentCount: documents.length,
            completedAt: new Date(),
          },
        });
        if (count === 0) return null;

        const generation = await tx.generation.findUniqueOrThrow({
          where: { generationId },
          select: { userId: true, workspaceId: true, conversations: { select: { conversationId: true } } },
        });
        const requested = generation.conversations.map(({ conversationId }) => conversationId);

        const documentIds: bigint[] = [];
        for (const item of documents) {
          const { artifactId, title, category, summary, keywords, content } = item;
          const document = await tx.document.create({
            data: {
              userId: generation.userId,
              workspaceId: generation.workspaceId,
              generationId,
              status: "DRAFT_GENERATED",
              sources: { create: sourceConversationIds(item, requested).map((conversationId) => ({ conversationId })) },
              drafts: {
                create: {
                  versionNo: 1,
                  status: "GENERATED",
                  title,
                  category,
                  summary,
                  keywords,
                  content,
                  requestedBy: generation.userId,
                  aiArtifactId: artifactId,
                  aiDetail: toAiDetail(item),
                },
              },
            },
            select: { documentId: true, drafts: { select: { draftId: true } } },
          });
          await versionRepository.add(tx, {
            documentId: document.documentId,
            draftId: document.drafts[0].draftId,
            source: "AI_GENERATED",
            savedBy: generation.userId,
            title,
            category,
            summary,
            keywords,
            content,
          });
          documentIds.push(document.documentId);
        }
        return documentIds;
      },
      // 문서가 여러 편이면 기본 5초를 넘길 수 있어서 넉넉히
      { timeout: 30_000 },
    );
  },

  // 생성 실패: FAILED + 원인. 이미 끝난 요청(서버 재시작으로 실패 처리 등)은 건드리지 않는다
  markFailed(generationId: bigint, failReason: FailReason, errorMessage: string) {
    return prisma.generation.updateMany({
      where: { generationId, status: "GENERATING" },
      data: { status: "FAILED", failReason, errorMessage: errorMessage.slice(0, TEXT_MAX), completedAt: new Date() },
    });
  },

  // 서버가 켜질 때: 이전 프로세스에서 AI 서버 응답을 기다리던 생성 요청을 실패로 바꾼다 (사용자가 '다시 시도')
  async failInterrupted() {
    const { count } = await prisma.generation.updateMany({
      where: { status: "GENERATING" },
      data: { status: "FAILED", failReason: "TIMEOUT", errorMessage: "AI 서버 응답을 기다리는 중 서버가 재시작됨", completedAt: new Date() },
    });
    return count;
  },
};
