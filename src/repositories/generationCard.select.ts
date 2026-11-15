import type { Prisma } from "../generated/prisma/client.js";

// 아직 문서가 없는 생성 요청 카드(DRAFT-08 generations[], CONV-02 generation.generations[])에 쓰는 값.
// 미채택 문서 목록(generation.repository)과 대화 목록(conversation.repository)이 같이 써서 따로 둔다
// (두 저장소가 서로를 불러오면 순서에 따라 이 값이 만들어지기 전에 쓰일 수 있음)
export const generationCardSelect = {
  generationId: true,
  retriedFromId: true,
  status: true,
  failReason: true,
  noContentReason: true,
  createdAt: true,
  user: { select: { userId: true, nickname: true } },
  conversations: { orderBy: { conversationId: "asc" }, select: { conversation: { select: { conversationId: true, title: true } } } },
} satisfies Prisma.GenerationSelect;

export type GenerationCardRow = Prisma.GenerationGetPayload<{ select: typeof generationCardSelect }>;

// 실패·문서 없음 결과를 카드로 보여 주는 기간 (확인 처리 기능이 없어서 이 기간이 지나면 빠진다)
export const RECENT_RESULT_DAYS = 7;

export function recentResultSince() {
  return new Date(Date.now() - RECENT_RESULT_DAYS * 24 * 60 * 60 * 1000);
}
