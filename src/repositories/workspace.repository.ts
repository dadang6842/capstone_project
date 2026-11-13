import { prisma } from "../config/prisma.js";
import type { WorkspaceRole } from "../generated/prisma/client.js";

// 구성원 목록·역할 변경 응답에 쓰는 회원 정보
const memberSelect = {
    userId: true,
    role: true,
    joinedAt: true,
    user: { select: { nickname: true, email: true } },
} as const;

export const workspaceRepository = {
    // 팀을 만들고 만든 사람을 소유자(OWNER)로 넣는다 (중첩 create라 하나의 트랜잭션)
    createWithOwner(userId: bigint, data: { name: string; description: string }) {
        return prisma.workspace.create({
            data: { ...data, members: { create: { userId, role: "OWNER" } } },
        });
    },

    // 내가 속한 팀(삭제한 팀 제외)을 참여한 순서대로, 내 역할·구성원 수와 함께
    findByMember(userId: bigint) {
        return prisma.workspaceMember.findMany({
            where: { userId, workspace: { deletedAt: null } },
            orderBy: [{ joinedAt: "asc" }, { workspaceMemberId: "asc" }],
            select: {
                role: true,
                joinedAt: true,
                workspace: { select: { workspaceId: true, name: true, _count: { select: { members: true } } } },
            },
        });
    },

    // 팀원 확인용: 이 회원의 구성원 행과 팀 (삭제 여부 포함)
    findMembership(workspaceId: bigint, userId: bigint) {
        return prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId } },
            include: { workspace: true },
        });
    },

    countMembers(workspaceId: bigint) {
        return prisma.workspaceMember.count({ where: { workspaceId } });
    },

    update(workspaceId: bigint, data: { name?: string; description?: string }) {
        return prisma.workspace.update({ where: { workspaceId }, data });
    },

    // 팀 삭제(소프트). 구성원·초대·자료는 남겨 두고, 모든 API가 삭제된 팀을 404로 본다
    softDelete(workspaceId: bigint) {
        return prisma.workspace.update({ where: { workspaceId }, data: { deletedAt: new Date() } });
    },

    // 구성원 목록: 소유자 → 관리자 → 일반 (MySQL ENUM은 정의 순서로 정렬된다), 같으면 참여일 순
    findMembers(workspaceId: bigint) {
        return prisma.workspaceMember.findMany({
            where: { workspaceId },
            orderBy: [{ role: "asc" }, { joinedAt: "asc" }, { workspaceMemberId: "asc" }],
            select: memberSelect,
        });
    },

    updateMemberRole(workspaceId: bigint, userId: bigint, role: WorkspaceRole) {
        return prisma.workspaceMember.update({
            where: { workspaceId_userId: { workspaceId, userId } },
            data: { role },
            select: memberSelect,
        });
    },

    deleteMember(workspaceId: bigint, userId: bigint) {
        return prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    },

    // 소유권 이전: 지금 소유자는 관리자로, 대상은 소유자로 (한 트랜잭션)
    transferOwnership(workspaceId: bigint, ownerId: bigint, targetId: bigint) {
        return prisma.$transaction([
            prisma.workspaceMember.update({
                where: { workspaceId_userId: { workspaceId, userId: ownerId } },
                data: { role: "ADMIN" },
            }),
            prisma.workspaceMember.update({
                where: { workspaceId_userId: { workspaceId, userId: targetId } },
                data: { role: "OWNER" },
            }),
        ]);
    },
};
