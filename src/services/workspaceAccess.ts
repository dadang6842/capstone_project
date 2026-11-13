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
