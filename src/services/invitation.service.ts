import { invitationRepository, type SentInvitationRow } from "../repositories/invitation.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { workspaceRepository } from "../repositories/workspace.repository.js";
import { findMembership, requireRole } from "./workspaceAccess.js";
import { AppError } from "../utils/appError.js";
import type {
    AcceptInvitationResponse,
    CreateInvitationBody,
    ListReceivedInvitationsQuery,
    ListReceivedInvitationsResponse,
    ListSentInvitationsResponse,
    SentInvitation,
} from "../schemas/invitation.schema.js";

function toUserRef(user: { userId: bigint; nickname: string } | null) {
    return user && { userId: Number(user.userId), nickname: user.nickname };
}

function toSentInvitation(row: SentInvitationRow): SentInvitation {
    return {
        invitationId: Number(row.workspaceInvitationId),
        invitee: { userId: Number(row.invitee.userId), nickname: row.invitee.nickname, email: row.invitee.email },
        inviter: toUserRef(row.inviter),
        status: row.status,
        createdAt: row.createdAt,
    };
}

// 받은 사람 본인의 초대인지 (남의 초대, 삭제된 팀의 초대는 없는 것으로 본다)
async function findMyInvitation(userId: number, invitationId: number) {
    const invitation = await invitationRepository.findById(BigInt(invitationId));
    if (!invitation || invitation.inviteeId !== BigInt(userId) || invitation.workspace.deletedAt) {
        throw new AppError("INVITATION_NOT_FOUND");
    }
    if (invitation.status !== "PENDING") throw new AppError("INVITATION_NOT_PENDING");
    return invitation;
}

export const invitationService = {
    // INV-01 소유자·관리자. 기존 회원만, 항상 일반 팀원으로 초대
    async create(userId: number, workspaceId: number, { email }: CreateInvitationBody): Promise<SentInvitation> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER", "ADMIN");

        const invitee = await userRepository.findActiveByEmail(email);
        if (!invitee) throw new AppError("INVITEE_NOT_FOUND");
        if (await workspaceRepository.findMembership(membership.workspaceId, invitee.userId))
            throw new AppError("ALREADY_MEMBER");
        if (await invitationRepository.findPending(membership.workspaceId, invitee.userId))
            throw new AppError("INVITATION_ALREADY_PENDING");

        return toSentInvitation(
            await invitationRepository.create(membership.workspaceId, membership.userId, invitee.userId),
        );
    },

    // INV-02 소유자·관리자
    async listSent(userId: number, workspaceId: number): Promise<ListSentInvitationsResponse> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER", "ADMIN");
        const rows = await invitationRepository.findPendingByWorkspace(membership.workspaceId);
        return { invitations: rows.map(toSentInvitation) };
    },

    // INV-03 소유자·관리자
    async cancel(userId: number, workspaceId: number, invitationId: number): Promise<void> {
        const membership = await findMembership(userId, workspaceId);
        requireRole(membership, "OWNER", "ADMIN");

        const invitation = await invitationRepository.findById(BigInt(invitationId));
        if (!invitation || invitation.workspaceId !== membership.workspaceId)
            throw new AppError("INVITATION_NOT_FOUND");
        if (!(await invitationRepository.respond(invitation.workspaceInvitationId, "CANCELED")))
            throw new AppError("INVITATION_NOT_PENDING");
    },

    // INV-04 받은 초대
    async listReceived(
        userId: number,
        { status }: ListReceivedInvitationsQuery,
    ): Promise<ListReceivedInvitationsResponse> {
        const rows = await invitationRepository.findReceived(BigInt(userId), status);
        return {
            invitations: rows.map((row) => ({
                invitationId: Number(row.workspaceInvitationId),
                workspace: { workspaceId: Number(row.workspace.workspaceId), name: row.workspace.name },
                inviter: toUserRef(row.inviter),
                status: row.status,
                respondedAt: row.respondedAt,
                createdAt: row.createdAt,
            })),
        };
    },

    // INV-05 수락 → 일반 팀원. 팀의 기존 자료도 바로 볼 수 있다
    async accept(userId: number, invitationId: number): Promise<AcceptInvitationResponse> {
        const invitation = await findMyInvitation(userId, invitationId);
        if (
            !(await invitationRepository.accept(
                invitation.workspaceInvitationId,
                invitation.workspaceId,
                BigInt(userId),
            ))
        ) {
            throw new AppError("INVITATION_NOT_PENDING");
        }
        return { workspaceId: Number(invitation.workspaceId), name: invitation.workspace.name, myRole: "MEMBER" };
    },

    // INV-06 거절
    async decline(userId: number, invitationId: number): Promise<void> {
        const invitation = await findMyInvitation(userId, invitationId);
        if (!(await invitationRepository.respond(invitation.workspaceInvitationId, "DECLINED")))
            throw new AppError("INVITATION_NOT_PENDING");
    },
};
