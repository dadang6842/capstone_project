import { prisma } from "../config/prisma.js";
import type { InvitationStatus } from "../generated/prisma/client.js";

// 팀 쪽에서 보는 초대 (받는 사람·보낸 사람)
const sentSelect = {
    workspaceInvitationId: true,
    status: true,
    createdAt: true,
    invitee: { select: { userId: true, nickname: true, email: true } },
    inviter: { select: { userId: true, nickname: true } },
} as const;

export type SentInvitationRow = Awaited<ReturnType<typeof invitationRepository.findPendingByWorkspace>>[number];

export const invitationRepository = {
    findPending(workspaceId: bigint, inviteeId: bigint) {
        return prisma.workspaceInvitation.findFirst({ where: { workspaceId, inviteeId, status: "PENDING" } });
    },

    create(workspaceId: bigint, inviterId: bigint, inviteeId: bigint) {
        return prisma.workspaceInvitation.create({ data: { workspaceId, inviterId, inviteeId }, select: sentSelect });
    },

    // 팀의 대기 중 초대 (최근 보낸 순)
    findPendingByWorkspace(workspaceId: bigint) {
        return prisma.workspaceInvitation.findMany({
            where: { workspaceId, status: "PENDING" },
            orderBy: { workspaceInvitationId: "desc" },
            select: sentSelect,
        });
    },

    findById(invitationId: bigint) {
        return prisma.workspaceInvitation.findUnique({
            where: { workspaceInvitationId: invitationId },
            include: { workspace: { select: { workspaceId: true, name: true, deletedAt: true } } },
        });
    },

    // 받은 초대 (삭제된 팀 제외, 최근 받은 순)
    findReceived(inviteeId: bigint, status?: InvitationStatus) {
        return prisma.workspaceInvitation.findMany({
            where: { inviteeId, status, workspace: { deletedAt: null } },
            orderBy: { workspaceInvitationId: "desc" },
            select: {
                workspaceInvitationId: true,
                status: true,
                respondedAt: true,
                createdAt: true,
                workspace: { select: { workspaceId: true, name: true } },
                inviter: { select: { userId: true, nickname: true } },
            },
        });
    },

    // 대기 중일 때만 상태를 바꾼다 (동시에 수락·취소해도 한 번만 처리). 바꿨으면 true
    async respond(invitationId: bigint, status: "DECLINED" | "CANCELED") {
        const { count } = await prisma.workspaceInvitation.updateMany({
            where: { workspaceInvitationId: invitationId, status: "PENDING" },
            data: { status, respondedAt: new Date() },
        });
        return count > 0;
    },

    // 수락: 초대를 ACCEPTED로 바꾸고 일반 팀원(MEMBER)으로 넣는다 (한 트랜잭션). 이미 처리된 초대면 false
    accept(invitationId: bigint, workspaceId: bigint, userId: bigint) {
        return prisma.$transaction(async (tx) => {
            const { count } = await tx.workspaceInvitation.updateMany({
                where: { workspaceInvitationId: invitationId, status: "PENDING" },
                data: { status: "ACCEPTED", respondedAt: new Date() },
            });
            if (count === 0) return false;
            // 그사이 다른 경로로 이미 팀원이 됐어도 오류 없이 넘어간다
            await tx.workspaceMember.createMany({
                data: [{ workspaceId, userId, role: "MEMBER" }],
                skipDuplicates: true,
            });
            return true;
        });
    },
};
