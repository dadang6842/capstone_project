import { z } from "zod";
import { workspaceIdBodyShape, workspaceIdQueryShape } from "./common.schema.js";

// 지식 문서 AI 검색 (2026-11-17). 제목·본문 단어 검색(DOC-01 ?q)과 별개로, 문장으로 물으면 AI가 채택한 지식 문서 본문을 읽고 관련 문서와 이유를 찾아 준다

const pageSizeMeta = { description: "한 페이지에 보여 줄 결과 수 (기본 10, 최대 50). 찾을 문서 수 제한이 아니다" };

export const searchIdParamsSchema = z.object({
    searchId: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .meta({ description: "검색 아이디 (AI 검색 시작 응답의 searchId)" }),
});

// SEARCH-01 AI 검색 시작
export const startSearchBodySchema = z.object({
    query: z
        .string()
        .trim()
        .min(2)
        .max(500)
        .meta({
            example: "전에 임베딩으로 대화를 나눠봤는데 잘 안됐던 이유",
            description: "찾을 내용을 문장으로 (앞뒤 공백 제외 2~500자)",
        }),
    pageSize: z.number().int().min(1).max(50).default(10).meta(pageSizeMeta),
    ...workspaceIdBodyShape,
});

// SEARCH-02 남은 후보 이어서 찾기
export const continueSearchBodySchema = z.object({
    resultRevision: z
        .number()
        .int()
        .positive()
        .meta({ example: 1, description: "가장 최근에 받은 응답의 resultRevision" }),
    pageSize: z.number().int().min(1).max(50).default(10).meta(pageSizeMeta),
    ...workspaceIdBodyShape,
});

// SEARCH-03 결과 페이지 이동
export const searchPageQuerySchema = z.object({
    resultRevision: z.coerce
        .number()
        .int()
        .positive()
        .meta({ example: 2, description: "가장 최근에 받은 응답의 resultRevision" }),
    page: z.coerce.number().int().min(1).default(1).meta({ description: "페이지 번호 (기본 1)" }),
    pageSize: z.coerce.number().int().min(1).max(50).default(10).meta(pageSizeMeta),
    ...workspaceIdQueryShape,
});

// 세 API 공통 응답
export const searchResultSchema = z
    .object({
        searchId: z.string().meta({ description: "이어서 찾기(SEARCH-02)·페이지 이동(SEARCH-03)에 쓰는 검색 아이디" }),
        resultRevision: z
            .number()
            .int()
            .meta({
                example: 1,
                description: "결과 갱신 번호. 이어서 찾을 때마다 1씩 커지고, 다음 요청에는 가장 최근 값을 보낸다",
            }),
        status: z.enum(["MATCHES", "NO_MATCH", "NO_DOCUMENTS", "IN_PROGRESS", "INCOMPLETE"]).meta({
            description:
                "MATCHES 모든 문서를 확인했고 결과 있음, NO_MATCH 모든 문서를 확인했고 결과 없음, NO_DOCUMENTS 검색할 지식 문서가 없음, " +
                "IN_PROGRESS 아직 확인하지 않은 문서가 남음(이어서 찾기 가능), INCOMPLETE AI 판단 도중 오류(결과 없음으로 안내하지 말 것, 이어서 찾기로 다시 시도)",
        }),
        complete: z.boolean().meta({ description: "모든 문서를 오류 없이 확인했는지" }),
        processedDocuments: z.number().int().meta({ example: 8, description: "지금까지 확인한 문서 수" }),
        totalDocuments: z.number().int().meta({ example: 20, description: "검색 대상 문서 수 (이 공간의 최종 문서)" }),
        knownMatches: z
            .number()
            .int()
            .meta({ example: 3, description: "지금까지 찾은 문서 수. 진행 중에는 이 값을 '지금까지 n개'로 보여 준다" }),
        totalMatches: z
            .number()
            .int()
            .nullable()
            .meta({
                example: null,
                description: "전체 결과 수. 모든 문서를 확인했을 때만 값이 있고 진행 중·오류면 null",
            }),
        hasMoreCandidates: z
            .boolean()
            .meta({ description: "아직 확인하지 않은 문서가 있는지 ('더 찾아보기' 버튼 표시 기준)" }),
        page: z.number().int().meta({ example: 1 }),
        pageSize: z.number().int().meta({ example: 10 }),
        hasMore: z
            .boolean()
            .meta({ description: "이미 찾은 결과 중 다음 페이지가 있는지 (모델 호출 없이 SEARCH-03으로 이동)" }),
        results: z
            .array(
                z.object({
                    documentId: z
                        .number()
                        .int()
                        .meta({ example: 15, description: "지식 문서 아이디. 상세(DOC-02)로 연다" }),
                    title: z.string().meta({ example: "임베딩 검색이 실패한 원인 정리" }),
                    reason: z.string().meta({ description: "AI가 이 문서를 고른 이유" }),
                    evidence: z.string().meta({ description: "본문에서 그대로 가져온 근거 구절" }),
                    evidenceStart: z
                        .number()
                        .int()
                        .meta({ description: "근거 구절이 본문에서 시작하는 글자 위치 (못 찾으면 -1)" }),
                    strength: z
                        .number()
                        .int()
                        .meta({
                            example: 3,
                            description: "3 질문의 핵심에 직접 답함, 2 질문 일부에 답함 (정렬용, 확률·점수가 아님)",
                        }),
                }),
            )
            .meta({ description: "현재 페이지 결과 (관련도 순). 이어서 찾으면 순서가 바뀔 수 있다" }),
        errors: z
            .array(z.object({ type: z.string(), message: z.string().nullable() }))
            .meta({ description: "AI 판단 실패 내용 (INCOMPLETE일 때). 진행 중인 것 자체는 오류가 아니다" }),
    })
    .meta({ id: "SearchResult" });

export type SearchIdParams = z.infer<typeof searchIdParamsSchema>;
export type StartSearchBody = z.infer<typeof startSearchBodySchema>;
export type ContinueSearchBody = z.infer<typeof continueSearchBodySchema>;
export type SearchPageQuery = z.infer<typeof searchPageQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
