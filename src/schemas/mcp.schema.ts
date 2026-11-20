import { z } from "zod";

// MCP 서버가 공유 링크를 수집한 뒤 보내는 결과.
// captureId·title·resolvedUrl·messages는 collector/collect.py의 성공 출력과 같은 모양 (mcp_server.py가 collect.to_output을 그대로 씀)
export const saveCaptureBodySchema = z.object({
    shareUrl: z.string().min(1).max(2048),
    captureId: z.string().min(1).max(80),
    title: z.string().max(255).nullable(),
    resolvedUrl: z.string().max(2048).nullable().optional(),
    messages: z
        .array(
            z.object({
                sourceMessageId: z.string().min(1).max(100),
                role: z.enum(["USER", "ASSISTANT"]),
                content: z.string().min(1),
                // 발화별 코드 블록 (문서 생성 때 AI-01 codeBlocks로 보냄). 없으면 빈 배열
                codeBlocks: z.array(z.string()).default([]),
            }),
        )
        .min(1),
});

export type SaveCaptureBody = z.infer<typeof saveCaptureBodySchema>;

// ChatGPT 화면에 그대로 전달되는 값이라 message는 사용자에게 보여 줄 문장으로 쓴다
export type SaveCaptureResponse = {
    status: "saved" | "duplicated";
    conversationId: number;
    message: string;
};
