import { z } from "zod";
import { userRefSchema } from "./common.schema.js";

// 생성 요청 (2026-11-15 지식 분할 저장). 대화를 골라 '지식 문서 만들기'를 누른 1번 = 생성 요청 1개.
// AI가 한 요청에서 지식 문서를 여러 편 돌려줘서, 문서는 응답을 받은 뒤 만들어진다

export const generationIdParamsSchema = z.object({
  generationId: z.coerce.number().int().positive().meta({ description: "생성 요청 아이디" }),
});

export const generationStatusSchema = z
  .enum(["GENERATING", "COMPLETED", "NO_CONTENT", "FAILED"])
  .meta({
    description:
      "GENERATING 생성 중(몇 초 뒤 다시 조회), COMPLETED 문서 1편 이상 생성, NO_CONTENT AI가 남길 지식이 없다고 답함(noContentReason), FAILED 실패(failReason, 다시 시도 GEN-02)",
  });

export const generationFailReasonSchema = z
  .enum(["GENERATION_FAILED", "INVALID_RESPONSE", "TIMEOUT"])
  .nullable()
  .meta({ description: "실패 원인 (FAILED일 때만). GENERATION_FAILED AI 서버 요청·생성 실패, INVALID_RESPONSE AI 응답 형식 오류, TIMEOUT 시간 초과·서버 재시작" });

// 생성 요청 상태 조회(GEN-01)
export const generationDetailSchema = z
  .object({
    generationId: z.number().int().meta({ example: 9 }),
    status: generationStatusSchema,
    failReason: generationFailReasonSchema,
    noContentReason: z.string().nullable().meta({ example: "대화에 남길 만한 지식이 없습니다.", description: "AI가 준 문서 없음 사유 (NO_CONTENT일 때만)" }),
    reviewStatus: z
      .enum(["COMPLETED", "INCOMPLETE", "PENDING", "NOT_APPLICABLE"])
      .nullable()
      .meta({ description: "AI 자동 검토 결과 (요청 전체, 응답을 받은 뒤에만). COMPLETED 외에는 '검토 의견을 받지 못했다'로 안내하면 된다. 초안은 정상" }),
    conversations: z
      .array(
        z.object({
          conversationId: z.number().int().meta({ example: 7 }),
          title: z.string().nullable().meta({ example: "JWT 인증 흐름 정리" }),
          deleted: z.boolean().meta({ description: "대화가 삭제됐는지 (다시 시도는 남은 대화로만 함)" }),
        }),
      )
      .meta({ description: "이 요청에 고른 대화" }),
    documents: z
      .array(
        z.object({
          documentId: z.number().int().meta({ example: 15 }),
          draftId: z.number().int().meta({ example: 31, description: "AI가 만든 1회차 초안. 초안 조회(DRAFT-02)·채택(DRAFT-03·09)에 쓴다" }),
          documentStatus: z.enum(["DRAFT_GENERATED", "FINALIZED"]).meta({ description: "FINALIZED면 이미 채택한 문서" }),
          title: z.string().nullable().meta({ example: "Refresh Token 저장 위치" }),
          category: z.enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"]).nullable(),
          summary: z.string().nullable(),
          keywords: z.array(z.string()).meta({ example: ["JWT", "Refresh Token"] }),
          reviewLabel: z.string().nullable().meta({ description: "AI 자동 검토의 한 줄 판정 (검토 의견이 없으면 null)" }),
        }),
      )
      .meta({ description: "이 요청으로 만든 지식 문서 초안 (COMPLETED일 때만, 휴지통으로 보낸 문서 제외, 생성 순)" }),
    requester: userRefSchema.meta({ description: "생성 요청자 (다시 시도면 다시 시도한 회원)" }),
    createdAt: z.date(),
    completedAt: z.date().nullable().meta({ description: "AI 응답을 받아 끝낸 일시 (생성 중이면 null)" }),
  })
  .meta({ id: "GenerationDetail" });

// 생성 다시 시도(GEN-02)
export const retryGenerationResponseSchema = z
  .object({
    generationId: z.number().int().meta({ example: 10, description: "새로 만든 생성 요청 아이디. 이 아이디로 GEN-01을 폴링한다" }),
    status: z.literal("GENERATING"),
  })
  .meta({ id: "RetryGenerationResponse" });

// 아직 문서가 없는 생성 요청 카드 (DRAFT-08 generations[], CONV-02 generation.generations[]).
// 생성 중이거나, 최근 7일 안에 실패·문서 없음으로 끝난 요청. 재시도한 요청은 가장 최근 시도만
export const generationCardSchema = z
  .object({
    generationId: z.number().int().meta({ example: 9, description: "GEN-01로 진행 확인, FAILED면 GEN-02로 다시 시도" }),
    status: z.enum(["GENERATING", "NO_CONTENT", "FAILED"]),
    failReason: generationFailReasonSchema,
    noContentReason: z.string().nullable(),
    conversations: z
      .array(z.object({ conversationId: z.number().int().meta({ example: 7 }), title: z.string().nullable() }))
      .meta({ description: "이 요청에 고른 대화 (카드에 '어떤 대화로 만든 요청인지' 표시용)" }),
    requester: userRefSchema,
    createdAt: z.date(),
  })
  .meta({ id: "GenerationCard" });

export type GenerationIdParams = z.infer<typeof generationIdParamsSchema>;
export type GenerationDetail = z.infer<typeof generationDetailSchema>;
export type RetryGenerationResponse = z.infer<typeof retryGenerationResponseSchema>;
export type GenerationCard = z.infer<typeof generationCardSchema>;
