// 서버 측 프록시 라우트.
// NVIDIA API 키는 여기(process.env)에만 존재하며 브라우저로 절대 나가지 않는다.
// 클라이언트 → /api/chat → NVIDIA integrate API 로 스트리밍을 그대로 통과시킨다.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel: 스트리밍 최대 실행 시간(초)

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.GLM_MODEL || "z-ai/glm-5.2";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface ChatRequest {
  messages?: ChatMessage[];
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return jsonError(
      "NVIDIA_API_KEY 가 서버에 설정되지 않았습니다. .env.local 또는 배포 환경변수에 추가하세요.",
      500,
    );
  }

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return jsonError("잘못된 요청 본문(JSON 파싱 실패).", 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError("messages 배열이 필요합니다.", 400);
  }

  const payload = {
    model: body.model || DEFAULT_MODEL,
    messages,
    temperature: body.temperature ?? 1,
    top_p: body.top_p ?? 1,
    max_tokens: body.max_tokens ?? 16384,
    stream: true,
  };

  let upstream: Response;
  try {
    upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return jsonError(`NVIDIA API 연결 실패: ${String(e)}`, 502);
  }

  // 오류(모델 DEGRADED, 용량 초과 등)면 상태와 본문을 그대로 전달
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text || JSON.stringify({ error: { message: "빈 응답" } }), {
      status: upstream.status || 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SSE 스트림을 클라이언트로 그대로 통과 (reasoning_content 포함 보존)
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
