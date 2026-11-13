import { z } from "zod";

// 팀 워크스페이스 (WS-01~09)

export const workspaceRoleSchema = z
    .enum(["OWNER", "ADMIN", "MEMBER"])
    .meta({ description: "팀에서의 역할. OWNER 소유자, ADMIN 관리자, MEMBER 일반" });

// 팀 이름: 1~60자 (앞뒤 공백 제거). 같은 이름의 팀도 따로 만들 수 있다
const nameField = z
    .string()
    .trim()
    .min(1, "팀 이름을 입력해 주세요.")
    .max(60, "팀 이름은 60자 이하로 입력해 주세요.")
    .meta({ example: "졸업프로젝트 공동 작업실", description: "팀 이름 1~60자" });

// 팀 소개: 0~500자, 선택
const descriptionField = z
    .string()
    .trim()
    .max(500, "소개는 500자 이하로 입력해 주세요.")
    .meta({ example: "화면 캡처를 위한 로컬 예시 작업실입니다.", description: "팀 소개 0~500자 (선택)" });

export const workspaceIdParamsSchema = z.object({
    workspaceId: z.coerce.number().int().positive().meta({ description: "팀 아이디" }),
});

export const memberParamsSchema = workspaceIdParamsSchema.extend({
    userId: z.coerce.number().int().positive().meta({ description: "구성원의 회원 아이디" }),
});

// 팀 응답 (WS-01 만들기, WS-03 조회, WS-04 수정에서 같이 쓴다)
export const workspaceSchema = z
    .object({
        workspaceId: z.number().int().meta({ example: 3 }),
        name: z.string().meta({ example: "졸업프로젝트 공동 작업실" }),
        description: z.string().meta({ example: "화면 캡처를 위한 로컬 예시 작업실입니다." }),
        myRole: workspaceRoleSchema,
        memberCount: z.number().int().meta({ example: 1 }),
        createdAt: z.date().meta({ description: "만든 일시 (ISO 8601 UTC)" }),
        updatedAt: z.date().meta({ description: "팀 정보 수정 일시 (ISO 8601 UTC)" }),
    })
    .meta({ id: "Workspace" });

// 팀 만들기(WS-01)
export const createWorkspaceBodySchema = z
    .object({
        name: nameField,
        description: descriptionField.default(""),
    })
    .meta({ id: "CreateWorkspaceRequest" });

// 내 팀 목록(WS-02): 사이드바 워크스페이스 목록
export const workspaceListItemSchema = z
    .object({
        workspaceId: z.number().int().meta({ example: 3 }),
        name: z.string().meta({ example: "졸업프로젝트 공동 작업실" }),
        myRole: workspaceRoleSchema,
        memberCount: z.number().int().meta({ example: 2 }),
        joinedAt: z.date().meta({ description: "내가 참여한 일시 (팀을 만들었거나 초대를 수락한 일시)" }),
    })
    .meta({ id: "WorkspaceListItem" });

export const listWorkspacesResponseSchema = z
    .object({ workspaces: z.array(workspaceListItemSchema) })
    .meta({ id: "ListWorkspacesResponse" });

// 팀 정보 수정(WS-04): 이름·소개 중 하나 이상
export const updateWorkspaceBodySchema = z
    .object({
        name: nameField.optional(),
        description: descriptionField.optional(),
    })
    .refine(
        (body) => body.name !== undefined || body.description !== undefined,
        "팀 이름이나 소개 중 하나는 보내 주세요.",
    )
    .meta({ id: "UpdateWorkspaceRequest" });

// 소유권 이전(WS-06)
export const transferOwnershipBodySchema = z
    .object({
        userId: z.number().int().positive().meta({ example: 5, description: "새 소유자가 될 구성원의 회원 아이디" }),
    })
    .meta({ id: "TransferOwnershipRequest" });

export const transferOwnershipResponseSchema = z
    .object({
        ownerUserId: z.number().int().meta({ example: 5, description: "새 소유자" }),
        myRole: z.literal("ADMIN").meta({ description: "이전한 뒤 내 역할 (관리자)" }),
    })
    .meta({ id: "TransferOwnershipResponse" });

// 구성원 (WS-07 목록, WS-08 역할 변경 응답)
export const memberSchema = z
    .object({
        userId: z.number().int().meta({ example: 5 }),
        nickname: z.string().meta({ example: "로컬 사용자" }),
        email: z.string().meta({ example: "member@example.com" }),
        role: workspaceRoleSchema,
        joinedAt: z.date().meta({ description: "참여일 (ISO 8601 UTC)" }),
        isMe: z.boolean().meta({ description: "요청한 본인이면 true (구성원 표의 '나' 표시)" }),
    })
    .meta({ id: "WorkspaceMember" });

export const listMembersResponseSchema = z
    .object({ members: z.array(memberSchema) })
    .meta({ id: "ListWorkspaceMembersResponse" });

// 역할 변경(WS-08): 소유자는 소유권 이전(WS-06)으로만 바뀐다
export const updateMemberRoleBodySchema = z
    .object({ role: z.enum(["ADMIN", "MEMBER"]).meta({ description: "바꿀 역할. ADMIN 관리자, MEMBER 일반" }) })
    .meta({ id: "UpdateMemberRoleRequest" });

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceIdParams = z.infer<typeof workspaceIdParamsSchema>;
export type MemberParams = z.infer<typeof memberParamsSchema>;
export type WorkspaceResponse = z.infer<typeof workspaceSchema>;
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBodySchema>;
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>;
export type UpdateWorkspaceBody = z.infer<typeof updateWorkspaceBodySchema>;
export type TransferOwnershipBody = z.infer<typeof transferOwnershipBodySchema>;
export type TransferOwnershipResponse = z.infer<typeof transferOwnershipResponseSchema>;
export type MemberResponse = z.infer<typeof memberSchema>;
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBodySchema>;
