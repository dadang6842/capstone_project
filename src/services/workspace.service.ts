import type { Workspace } from "../generated/prisma/client.js";
import { workspaceRepository } from "../repositories/workspace.repository.js";
import { findMembership, requireRole } from "./workspaceAccess.js";
import { AppError } from "../utils/appError.js";
import type {
    CreateWorkspaceBody,
    ListMembersResponse,
    ListWorkspacesResponse,
    MemberResponse,
    TransferOwnershipBody,
    TransferOwnershipResponse,
    UpdateMemberRoleBody,
    UpdateWorkspaceBody,
    WorkspaceResponse,
    WorkspaceRole,
} from "../schemas/workspace.schema.js";

function toWorkspaceResponse(workspace: Workspace, myRole: WorkspaceRole, memberCount: number): WorkspaceResponse {
    return {
        workspaceId: Number(workspace.workspaceId),
        name: workspace.name,
        description: workspace.description,
        myRole,
        memberCount,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
    };
}

type MemberRow = Awaited<ReturnType<typeof workspaceRepository.findMembers>>[number];

function toMemberResponse(member: MemberRow, myUserId: number): MemberResponse {
    return {
        userId: Number(member.userId),
        nickname: member.user.nickname,
        email: member.user.email,
        role: member.role,
        joinedAt: member.joinedAt,
        isMe: Number(member.userId) === myUserId,
    };
}

// 역할 변경·내보내기·소유권 이전 대상이 이 팀의 구성원인지
async function findTarget(workspaceId: number, userId: number) {
    const target = await workspaceRepository.findMembership(BigInt(workspaceId), BigInt(userId));
    if (!target) throw new AppError("MEMBER_NOT_FOUND");
    return target;
}

export const workspaceService = {
    // 만든 사람이 소유자가 된다. 개인 워크스페이스의 자료는 복사하지 않는다
    async create(userId: number, { name, description }: CreateWorkspaceBody): Promise<WorkspaceResponse> {
        const workspace = await workspaceRepository.createWithOwner(BigInt(userId), { name, description });
        return toWorkspaceResponse(workspace, "OWNER", 1);
    },

    // 사이드바 워크스페이스 목록. 개인 워크스페이스는 프론트가 맨 위에 따로 그린다
    async list(userId: number): Promise<ListWorkspacesResponse> {
        const memberships = await workspaceRepository.findByMember(BigInt(userId));
        return {
            workspaces: memberships.map(({ role, joinedAt, workspace }) => ({
                workspaceId: Number(workspace.workspaceId),
                name: workspace.name,
                myRole: role,
                memberCount: workspace._count.members,
                joinedAt,
            })),
        };
    },

    async get(userId: number, workspaceId: number): Promise<WorkspaceResponse> {
        const { workspace, role } = await findMembership(userId, workspaceId);
        return toWorkspaceResponse(workspace, role, await workspaceRepository.countMembers(workspace.workspaceId));
    },

    // 소유자·관리자
    async update(userId: number, workspaceId: number, body: UpdateWorkspaceBody): Promise<WorkspaceResponse> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER", "ADMIN");
        const workspace = await workspaceRepository.update(membership.workspaceId, body);
        return toWorkspaceResponse(
            workspace,
            membership.role,
            await workspaceRepository.countMembers(workspace.workspaceId),
        );
    },

    // 소유자만. 복구 API 없음
    async delete(userId: number, workspaceId: number): Promise<void> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER");
        await workspaceRepository.softDelete(membership.workspaceId);
    },

    // 소유자만. 이전하면 내 역할은 관리자가 된다
    async transferOwnership(
        userId: number,
        workspaceId: number,
        { userId: targetUserId }: TransferOwnershipBody,
    ): Promise<TransferOwnershipResponse> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER");
        if (targetUserId === userId)
            throw new AppError("VALIDATION_ERROR", { message: "본인에게는 소유권을 이전할 수 없습니다." });

        await findTarget(workspaceId, targetUserId);
        await workspaceRepository.transferOwnership(membership.workspaceId, BigInt(userId), BigInt(targetUserId));
        return { ownerUserId: targetUserId, myRole: "ADMIN" };
    },

    // 팀원이면 누구나
    async listMembers(userId: number, workspaceId: number): Promise<ListMembersResponse> {
        const membership = await findMembership(userId, workspaceId);
        const members = await workspaceRepository.findMembers(membership.workspaceId);
        return { members: members.map((member) => toMemberResponse(member, userId)) };
    },

    // 소유자만. 관리자 ↔ 일반. 소유자 본인의 역할은 소유권 이전으로만 바뀐다
    async updateMemberRole(
        userId: number,
        workspaceId: number,
        targetUserId: number,
        { role }: UpdateMemberRoleBody,
    ): Promise<MemberResponse> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER");

        const target = await findTarget(workspaceId, targetUserId);
        if (target.role === "OWNER") throw new AppError("OWNER_CANNOT_LEAVE");
        const updated = await workspaceRepository.updateMemberRole(membership.workspaceId, target.userId, role);
        return toMemberResponse(updated, userId);
    },

    // 대상이 나면 '팀 나가기'(소유자는 불가), 다른 사람이면 '내보내기'(소유자는 소유자 외 전부, 관리자는 일반 팀원만)
    // 나가거나 내보내도 그 사람이 만든 팀 자료는 팀에 남는다
    async removeMember(userId: number, workspaceId: number, targetUserId: number): Promise<"LEFT" | "REMOVED"> {
        const membership = await findMembership(userId, workspaceId);

        if (targetUserId === userId) {
            if (membership.role === "OWNER") throw new AppError("OWNER_CANNOT_LEAVE");
            await workspaceRepository.deleteMember(membership.workspaceId, membership.userId);
            return "LEFT";
        }

        requireRole(membership, "OWNER", "ADMIN");
        const target = await findTarget(workspaceId, targetUserId);
        if (target.role === "OWNER") throw new AppError("OWNER_CANNOT_LEAVE");
        if (membership.role === "ADMIN" && target.role !== "MEMBER") throw new AppError("FORBIDDEN");
        await workspaceRepository.deleteMember(membership.workspaceId, target.userId);
        return "REMOVED";
    },
};
