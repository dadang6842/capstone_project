import { workspaceRepository } from "../repositories/workspace.repository.js";
import type { WorkspaceRole } from "../generated/prisma/client.js";
import { AppError } from "../utils/appError.js";

// 팀 API 공통 확인 (권한 표: design.md 2장)
//  - 팀원이 아니거나 삭제된 팀이면 팀이 있는지 숨기려고 404 WORKSPACE_NOT_FOUND
//  - 팀원인데 역할이 모자라면 403 FORBIDDEN
export async function findMembership(userId: number, workspaceId: number) {
    const membership = await workspaceRepository.findMembership(BigInt(workspaceId), BigInt(userId));
    if (!membership || membership.workspace.deletedAt) throw new AppError("WORKSPACE_NOT_FOUND");
    return membership;
}

export type Membership = Awaited<ReturnType<typeof findMembership>>;

export function requireRole(membership: Membership, ...roles: WorkspaceRole[]) {
    if (!roles.includes(membership.role)) throw new AppError("FORBIDDEN");
}

// 목록·생성 API의 공간. workspaceId가 없으면 개인 공간(null), 있으면 팀원인지 확인한다(아니면 404 WORKSPACE_NOT_FOUND)
export async function resolveSpace(userId: number, workspaceId?: number): Promise<bigint | null> {
    if (workspaceId === undefined) return null;
    await findMembership(userId, workspaceId);
    return BigInt(workspaceId);
}

// 공간별 조회 조건. 개인 공간은 "내가 만들고 팀에 올리지 않은 자료", 팀 공간은 "그 팀 자료 전부"
export type SpaceFilter = { userId?: bigint; workspaceId: bigint | null };

export function spaceFilter(userId: number, workspaceId: bigint | null): SpaceFilter {
    return workspaceId === null ? { userId: BigInt(userId), workspaceId: null } : { workspaceId };
}

// 아이디로 찾은 자료(대화·문서)에 대한 내 권한
//  - manager: 팀 전체를 관리할 수 있음 (개인 자료의 주인, 팀 소유자·관리자)
//  - mine: 내가 등록·최초 생성 요청한 자료 (conversations.user_id, documents.user_id)
export type Access = { manager: boolean; mine: boolean };

// 볼 수 없는 자료면 null. 호출하는 쪽에서 자료별 404(CONVERSATION_NOT_FOUND 등)로 바꿔서 있는지 숨긴다
//  - 개인 자료: 본인만
//  - 팀 자료: 그 팀의 팀원만 (삭제된 팀이면 아무도)
export async function getAccess(
    userId: number,
    item: { userId: bigint | null; workspaceId: bigint | null },
): Promise<Access | null> {
    const me = BigInt(userId);
    if (item.workspaceId === null) return item.userId === me ? { manager: true, mine: true } : null;

    const membership = await workspaceRepository.findMembership(item.workspaceId, me);
    if (!membership || membership.workspace.deletedAt) return null;
    return { manager: membership.role !== "MEMBER", mine: item.userId === me };
}

// 미채택 초안 직접 수정·AI 보완·다시 시도·최종 채택: 소유자·관리자는 팀 전체, 일반은 내가 최초 생성 요청한 문서만
export function canEditDraft(access: Access) {
    return access.manager || access.mine;
}

// 문서 삭제(휴지통): 최종 문서는 소유자·관리자만, 미채택 문서는 소유자·관리자 + 최초 생성 요청자
export function canDeleteDocument(access: Access, finalized: boolean) {
    return finalized ? access.manager : access.manager || access.mine;
}

// 원문 삭제: 소유자·관리자는 팀 전체, 일반은 내가 등록했고 어떤 문서도 쓰지 않는 원문만 (휴지통 문서 포함)
export function canDeleteConversation(access: Access, referenced: boolean) {
    return access.manager || (access.mine && !referenced);
}
