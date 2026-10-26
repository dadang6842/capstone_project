import { z } from "zod";

export const draftIdParamsSchema = z.object({
    draftId: z.coerce.number().int().positive().meta({ description: "초안 아이디" }),
});

// 초안 조회(DRAFT-02)
export const draftDetailSchema = z
    .object({
        draftId: z.number().int().meta({ example: 31 }),
        documentId: z.number().int().meta({ example: 15 }),
        parentDraftId: z.number().int().nullable().meta({ description: "이전 초안 아이디 (1회차는 null)" }),
        versionNo: z.number().int().meta({ example: 1, description: "초안 회차" }),
        status: z
            .enum(["GENERATING", "GENERATED", "ACCEPTED", "FAILED", "NOT_KNOWLEDGE"])
            .meta({ description: "초안 상태. GENERATING이면 몇 초 뒤 다시 조회" }),
        title: z.string().nullable().meta({ example: "Prisma로 ERD 옮기기", description: "생성 완료 전에는 null" }),
        summary: z.string().nullable(),
        category: z.enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]).nullable().meta({ description: "지식 유형" }),
        keywords: z.array(z.string()).meta({ example: ["Prisma", "MySQL", "ERD"] }),
        content: z.string().nullable().meta({ description: "본문 (Markdown)" }),
        feedbacks: z
            .array(z.string())
            .meta({ description: "이 회차를 만들 때 요청한 보완 항목 코드 (1회차는 빈 배열)" }),
        createdAt: z.date(),
        documentStatus: z
            .enum(["GENERATING", "DRAFT_GENERATED", "FINALIZED", "FAILED", "NOT_KNOWLEDGE"])
            .meta({ description: "문서 상태" }),
        revising: z
            .boolean()
            .meta({ description: "이 문서에 진행 중인 AI 보완 작업이 있는지 (true면 수정·보완·채택 버튼을 막음)" }),
        conversations: z
            .array(
                z.object({
                    conversationId: z.number().int().meta({ example: 7 }),
                    filename: z.string().meta({ example: "claude-jwt-대화.json" }),
                    deleted: z.boolean().meta({ description: "대화가 삭제됐는지 (true면 원문 열람 불가)" }),
                }),
            )
            .meta({ description: "분석한 원본 대화 (원본 대조 → CONV-03)" }),
    })
    .meta({ id: "DraftDetail" });

export type DraftIdParams = z.infer<typeof draftIdParamsSchema>;
export type DraftDetail = z.infer<typeof draftDetailSchema>;
