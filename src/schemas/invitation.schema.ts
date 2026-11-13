import { z } from "zod";
import { workspaceIdParamsSchema, workspaceRoleSchema } from "./workspace.schema.js";

// 팀 초대 (INV-01~06). 초대는 만료되지 않는다 (다현 결정 2026-11-13)

export const invitationStatusSchema = z
    .enum(["PENDING", "ACCEPTED", "DECLINED", "CANCELED"])
    .meta({ description: "PENDING 대기 중, ACCEPTED 수락, DECLINED 거절, CANCELED 취소(소유자·관리자)" });

const userRefSchema = z.object({
    userId: z.number().int().meta({ example: 5 }),
    nickname: z.string().meta({ example: "로컬 사용자" }),
});

export const invitationIdParamsSchema = z.object({
    invitationId: z.coerce.number().int().positive().meta({ description: "초대 아이디" }),
});

export const workspaceInvitationParamsSchema = workspaceIdParamsSchema.extend(invitationIdParamsSchema.shape);

// 초대 보내기(INV-01)
export const createInvitationBodySchema = z
    .object({
        email: z
            .string()
            .trim()
            .pipe(z.email().max(100))
            .meta({ example: "member@example.com", description: "초대할 회원의 가입 이메일" }),
    })
    .meta({ id: "CreateInvitationRequest" });

// 팀 쪽에서 보는 초대 (INV-01 응답, INV-02 대기 중 초대)
export const sentInvitationSchema = z
    .object({
        invitationId: z.number().int().meta({ example: 12 }),
        invitee: userRefSchema.extend({ email: z.string().meta({ example: "member@example.com" }) }),
        inviter: userRefSchema.nullable().meta({ description: "초대한 사람 (탈퇴로 삭제되면 null)" }),
        status: invitationStatusSchema,
        createdAt: z.date().meta({ description: "보낸 일시 (ISO 8601 UTC)" }),
    })
    .meta({ id: "SentInvitation" });

export const listSentInvitationsResponseSchema = z
    .object({ invitations: z.array(sentInvitationSchema) })
    .meta({ id: "ListSentInvitationsResponse" });

// 받은 초대(INV-04)
export const listReceivedInvitationsQuerySchema = z.object({
    status: invitationStatusSchema
        .optional()
        .meta({
            description:
                "PENDING이면 응답할 수 있는 초대만(헤더 '받은 초대' 배지 개수 = 길이). 생략하면 전체 초대 내역",
        }),
});

export const receivedInvitationSchema = z
    .object({
        invitationId: z.number().int().meta({ example: 12 }),
        workspace: z.object({
            workspaceId: z.number().int().meta({ example: 3 }),
            name: z.string().meta({ example: "졸업프로젝트 공동 작업실" }),
        }),
        inviter: userRefSchema.nullable().meta({ description: "초대한 사람 (탈퇴로 삭제되면 null)" }),
        status: invitationStatusSchema,
        respondedAt: z.date().nullable().meta({ description: "수락·거절·취소 일시 (대기 중이면 null)" }),
        createdAt: z.date().meta({ description: "받은 일시 (ISO 8601 UTC)" }),
    })
    .meta({ id: "ReceivedInvitation" });

export const listReceivedInvitationsResponseSchema = z
    .object({ invitations: z.array(receivedInvitationSchema) })
    .meta({ id: "ListReceivedInvitationsResponse" });

// 초대 수락(INV-05): 바로 그 팀으로 이동할 수 있게 팀 정보를 준다
export const acceptInvitationResponseSchema = z
    .object({
        workspaceId: z.number().int().meta({ example: 3 }),
        name: z.string().meta({ example: "졸업프로젝트 공동 작업실" }),
        myRole: workspaceRoleSchema,
    })
    .meta({ id: "AcceptInvitationResponse" });

export type InvitationIdParams = z.infer<typeof invitationIdParamsSchema>;
export type WorkspaceInvitationParams = z.infer<typeof workspaceInvitationParamsSchema>;
export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;
export type SentInvitation = z.infer<typeof sentInvitationSchema>;
export type ListSentInvitationsResponse = z.infer<typeof listSentInvitationsResponseSchema>;
export type ListReceivedInvitationsQuery = z.infer<typeof listReceivedInvitationsQuerySchema>;
export type ListReceivedInvitationsResponse = z.infer<typeof listReceivedInvitationsResponseSchema>;
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;
