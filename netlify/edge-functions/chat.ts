// 프로덕션 /api/chat 을 처리하는 Netlify Edge Function.
//
// 왜 Edge Function인가:
//   Next.js 서버 라우트(app/api/chat/route.ts)는 Netlify에서 일반 서버리스 함수(Lambda)로
//   실행되는데, 실행 시간이 기본 10초(최대 26초)로 제한된다. GLM처럼 reasoning을 포함한
//   긴 답변을 스트리밍하면 그 제한에 걸려 응답이 문장 중간에 끊긴다.
//   Edge Function은 스트리밍 응답에 이런 실행 시간 제한이 없어 끊김 없이 통과시킬 수 있다.
//
// netlify.toml 의 [[edge_functions]] 선언이 이 함수를 /api/chat 에 매핑하며,
// 이 함수가 응답을 반환하면 Next.js 라우트까지 요청이 내려가지 않는다.
// (로컬 `next dev` 에서는 app/api/chat/route.ts 가 동일한 역할을 수행)

declare const Netlify: { env: { get(key: string): string | undefined } };

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const FALLBACK_MODEL = "z-ai/glm-5.2";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonError("POST 요청만 지원합니다.", 405);

  const apiKey = Netlify.env.get("NVIDIA_API_KEY");
  if (!apiKey) {
    return jsonError(
      "NVIDIA_API_KEY 가 배포 환경변수에 설정되지 않았습니다. Netlify → Site configuration → Environment variables 에 추가하세요.",
      500,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("잘못된 요청 본문(JSON 파싱 실패).", 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError("messages 배열이 필요합니다.", 400);
  }

  const payload = {
    model: body.model || Netlify.env.get("GLM_MODEL") || FALLBACK_MODEL,
    messages,
    temperature: body.temperature ?? 1,
    top_p: body.top_p ?? 1,
    max_tokens: body.max_tokens ?? 16384,
    stream: true,
  };

  // 스트림이 시작되기 전(접속/과부하 오류)에만 재시도한다.
  // 스트림 시작 후 끊기는 경우는 클라이언트의 자동 이어쓰기가 복구한다.
  let upstream: Response;
  for (let attempt = 0; ; attempt++) {
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
      if (attempt >= MAX_RETRIES) {
        return jsonError(`NVIDIA API 연결 실패: ${String(e)}`, 502);
      }
      await sleep(700 * (attempt + 1));
      continue;
    }

    if (upstream.ok && upstream.body) break;

    if (attempt >= MAX_RETRIES || !RETRYABLE.has(upstream.status)) {
      const text = await upstream.text();
      return new Response(
        text || JSON.stringify({ error: { message: "빈 응답" } }),
        {
          status: upstream.status || 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await upstream.body?.cancel();
    await sleep(700 * (attempt + 1));
  }

  // SSE 스트림을 그대로 통과 (reasoning_content 포함 보존)
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
