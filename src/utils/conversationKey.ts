import { createHash } from "node:crypto";
import type { ConversationProvider, MessageRole } from "../generated/prisma/client.js";

// 대화 중복 판단 키 (2026-11-19 다현 결정: 공유 링크·비공개 가져오기 공통 규칙)
//   같은 공간(개인=회원, 팀=그 팀) + 같은 AI 서비스 + 같은 발화 내용이면 중복
//   링크·서비스 대화 ID·제목은 보지 않는다 → 공유 링크로 넣은 대화와 가져온 대화도 서로 비교된다
// 발화 비교는 아래처럼 정규화한 글자로 한다 (공유 페이지와 확장 프로그램이 읽은 글자의 사소한 차이 흡수)
//   줄바꿈 \r\n → \n, 줄 끝 공백 제거, 빈 줄 3개 이상 → 2개, 앞뒤 공백 제거, 빈 발화 제외
// 저장하는 본문은 바꾸지 않는다. 키 계산에만 쓴다

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function normalizeForKey(content: string): string {
    return content
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t ]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// 발화 내용 키 (공간과 상관없음)
export function contentKey(provider: ConversationProvider, messages: { role: MessageRole; content: string }[]): string {
    const normalized = messages
        .map(({ role, content }) => ({ role, content: normalizeForKey(content) }))
        .filter(({ content }) => content.length > 0);
    return sha256(JSON.stringify({ provider, messages: normalized }));
}

// conversations.dedup_key (UNIQUE): 공간 + 발화 내용 키. 수집 완료(COLLECTED) 대화에만 채우고, 삭제하면 비운다
export function dedupKey(
    space: { userId: bigint | number | null; workspaceId: bigint | number | null },
    key: string,
): string {
    const spaceKey = space.workspaceId !== null ? `workspace:${space.workspaceId}` : `user:${space.userId}`;
    return sha256(`${spaceKey}|${key}`);
}
