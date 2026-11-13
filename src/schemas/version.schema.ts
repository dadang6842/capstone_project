import { z } from "zod";
import { userRefSchema } from "./common.schema.js";
import { categorySchema } from "./document.schema.js";

export const versionIdParamsSchema = z.object({
    versionId: z.coerce.number().int().positive().meta({ description: "저장 이력 버전 아이디" }),
});

export const versionSourceSchema = z
    .enum(["AI_GENERATED", "MANUAL_SAVE", "RESTORE", "ACCEPTED"])
    .meta({
        description:
            "AI_GENERATED AI가 만든 원본, MANUAL_SAVE 직접 저장, RESTORE 이전 버전으로 복원, ACCEPTED 최초 채택(지식 문서 이력의 첫 버전)",
    });

// 이력 목록의 한 줄 (HIST-01·02)
export const versionListItemSchema = z
    .object({
        versionId: z.number().int().meta({ example: 41 }),
        versionNo: z.number().int().meta({ example: 3, description: "같은 이력(그 회차 또는 지식 문서) 안에서 1부터" }),
        source: versionSourceSchema,
        restoredFromVersionNo: z
            .number()
            .int()
            .nullable()
            .meta({ example: 1, description: "RESTORE일 때 되돌린 버전 번호 ('1번 버전으로 복원'), 아니면 null" }),
        title: z.string().nullable().meta({ example: "Prisma로 ERD 옮기기" }),
        savedBy: userRefSchema.meta({ description: "저장한 회원 (AI_GENERATED는 그 회차를 요청한 회원)" }),
        createdAt: z.date().meta({ description: "저장 일시" }),
    })
    .meta({ id: "VersionListItem" });

export const listVersionsResponseSchema = z
    .object({ versions: z.array(versionListItemSchema).meta({ description: "최신 버전부터" }) })
    .meta({ id: "VersionList" });

// 버전 하나 (HIST-03), 복원 결과 (HIST-04)
export const versionDetailSchema = versionListItemSchema
    .extend({
        documentId: z.number().int().meta({ example: 15 }),
        draftId: z
            .number()
            .int()
            .nullable()
            .meta({ example: 31, description: "회차 이력이면 그 초안 아이디, 지식 문서 이력이면 null" }),
        summary: z.string().nullable(),
        category: categorySchema.nullable(),
        keywords: z.array(z.string()).meta({ example: ["Prisma", "ERD"] }),
        content: z.string().nullable().meta({ description: "본문 (Markdown)" }),
    })
    .meta({ id: "VersionDetail" });

export type VersionIdParams = z.infer<typeof versionIdParamsSchema>;
export type VersionListItem = z.infer<typeof versionListItemSchema>;
export type ListVersionsResponse = z.infer<typeof listVersionsResponseSchema>;
export type VersionDetail = z.infer<typeof versionDetailSchema>;
