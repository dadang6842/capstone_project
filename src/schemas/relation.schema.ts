import { z } from "zod";
import { workspaceIdQueryShape } from "./common.schema.js";

// 문서 관계도 (2026-11-17). 이 공간의 최종 지식 문서끼리 본문 내용이 비슷한 것을 선으로 잇고, 가까운 문서끼리 묶음(groupId)을 준다.
// 선은 "내용이 비슷함"일 뿐 인과·선후·사실 관계를 뜻하지 않는다. 좌표·색은 주지 않으며 배치는 프론트가 한다

// REL-01 관계도 조회
export const relationGraphQuerySchema = z.object({
    ...workspaceIdQueryShape,
});

export const relationGraphSchema = z
    .object({
        snapshotId: z
            .string()
            .meta({ description: "이 관계도의 버전 표시. 문서가 바뀌면 달라진다 (같으면 다시 그릴 필요 없음)" }),
        counts: z
            .object({
                documents: z
                    .number()
                    .int()
                    .meta({
                        example: 12,
                        description: "관계도에 들어간 문서 수 (휴지통 밖 최종 문서 중 본문 있는 것)",
                    }),
                edges: z.number().int().meta({ example: 9, description: "선 수" }),
                groups: z.number().int().meta({ example: 3, description: "묶음 수 (선이 있는 문서끼리만 묶음)" }),
                isolates: z.number().int().meta({ example: 2, description: "어떤 문서와도 이어지지 않은 문서 수" }),
            })
            .meta({ description: "개수 요약" }),
        nodes: z
            .array(
                z.object({
                    documentId: z
                        .number()
                        .int()
                        .meta({ example: 15, description: "지식 문서 아이디. 누르면 상세(DOC-02)로 연다" }),
                    title: z.string().meta({ example: "임베딩 검색이 실패한 원인 정리" }),
                    category: z
                        .enum(["IDEA_NOTE", "CONCEPT_NOTE", "LIST", "MANUAL"])
                        .nullable()
                        .meta({ description: "지식 유형 (색·필터용)" }),
                    groupId: z.string().nullable().meta({
                        example: "group-1",
                        description:
                            "탐색용 묶음. 이 응답 안에서만 같은 값끼리 같은 묶음이고, 다음 조회에서는 바뀔 수 있다(저장 금지). 선이 없는 문서는 null",
                    }),
                    degree: z.number().int().meta({ example: 2, description: "이 문서에 이어진 선 수" }),
                }),
            )
            .meta({ description: "문서(점). 선이 없는 문서도 들어 있다" }),
        edges: z
            .array(
                z.object({
                    sourceDocumentId: z.number().int().meta({ example: 15 }),
                    targetDocumentId: z
                        .number()
                        .int()
                        .meta({ example: 21, description: "방향 없음 (source·target 순서에 의미 없음)" }),
                    similarity: z
                        .number()
                        .meta({
                            example: 0.61,
                            description:
                                "두 문서의 내용 유사도(코사인, 클수록 비슷). 확률·정답 점수가 아니다. 선 굵기 등에 쓴다",
                        }),
                    passageSimilarity: z.number().meta({ example: 0.72, description: "아래 두 구간끼리의 유사도" }),
                    passages: z
                        .array(
                            z.object({
                                documentId: z.number().int().meta({ example: 15 }),
                                text: z
                                    .string()
                                    .meta({
                                        description:
                                            "그 문서에서 상대 문서와 가장 비슷한 본문 구간 (최대 약 3,600바이트). 선을 눌렀을 때 미리보기용",
                                    }),
                            }),
                        )
                        .meta({
                            description: "두 문서에서 서로 가장 비슷한 본문 구간 (각 1개, 근거가 아니라 열람 보조)",
                        }),
                }),
            )
            .meta({ description: "선(내용 유사성 연결)" }),
    })
    .meta({ id: "RelationGraph" });

export type RelationGraphQuery = z.infer<typeof relationGraphQuerySchema>;
export type RelationGraph = z.infer<typeof relationGraphSchema>;
