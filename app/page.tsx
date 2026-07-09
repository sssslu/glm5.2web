"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "assistant";
interface Message {
  role: Role;
  content: string;
  reasoning?: string;
}

const STORAGE_KEY = "glm-chat-v1";

// 스트림이 끊기거나(finish_reason 없음) max_tokens에 도달하면 자동으로 이어쓰기
const MAX_CONTINUATIONS = 3;
// 내용을 하나도 받기 전에 실패하면 자동 재시도
const MAX_CONNECT_RETRIES = 2;
const CONTINUE_PROMPT =
  "(직전 assistant 응답이 중간에 끊겼습니다. 인사말이나 서론 없이, 끊긴 지점 바로 다음 글자부터 자연스럽게 이어서 작성하세요. 이미 작성된 내용은 절대 반복하지 마세요.)";

const SUGGESTIONS = [
  "GLM에 대해 한 문장으로 소개해줘",
  "파이썬으로 피보나치 함수 짜줘",
  "이번 주말 서울 근교 여행지 3곳 추천",
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── 마크다운 렌더링 ─────────────────────── */

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = ref.current?.innerText ?? "";
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <button className="codeblock-copy" type="button" onClick={copy}>
        {copied ? "복사됨 ✓" : "복사"}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer" />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

/* ── 메인 ────────────────────────────────── */

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [system, setSystem] = useState("");
  const [model, setModel] = useState("z-ai/glm-5.2");
  const [temperature, setTemperature] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState(""); // "이어쓰는 중…" 등 상태 표시
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);
  const hydratedRef = useRef(false);

  // 저장된 대화/설정 복원
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.messages)) setMessages(saved.messages);
        if (typeof saved.system === "string") setSystem(saved.system);
        if (typeof saved.model === "string" && saved.model) setModel(saved.model);
        if (typeof saved.temperature === "number")
          setTemperature(saved.temperature);
      }
    } catch {
      /* 손상된 저장값 무시 */
    }
    hydratedRef.current = true;
  }, []);

  // 대화/설정 저장 (스트리밍 중에는 건너뛰고 끝났을 때 저장)
  useEffect(() => {
    if (!hydratedRef.current || loading) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages, system, model, temperature }),
      );
    } catch {
      /* 저장 실패 무시 */
    }
  }, [messages, system, model, temperature, loading]);

  // 사용자가 위로 스크롤해 읽는 중이면 자동 스크롤 중지
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // textarea 높이 자동 조절
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  const updateLast = useCallback((fn: (m: Message) => Message) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return copy;
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* 한 번의 SSE 요청을 수행하고 결과를 반환 */
  const streamRound = useCallback(
    async (
      apiMessages: { role: string; content: string }[],
      controller: AbortController,
      onDelta: (d: { content?: string; reasoning?: string }) => void,
    ) => {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, model, temperature }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let msg = `요청 실패 (HTTP ${res.status})`;
        try {
          const j = await res.json();
          msg = j?.error?.message || j?.detail || msg;
        } catch {
          /* ignore */
        }
        return { ok: false as const, message: msg };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finish: string | null = null;
      let errorMsg: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            if (json.error) {
              errorMsg = json.error.message || JSON.stringify(json.error);
              continue;
            }
            const choice = json.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finish = choice.finish_reason;
            const delta = choice.delta;
            if (delta?.reasoning_content || delta?.content) {
              onDelta({
                content: delta.content,
                reasoning: delta.reasoning_content,
              });
            }
          } catch {
            /* 불완전한 청크 — 무시 */
          }
        }
      }
      return { ok: true as const, finish, errorMsg };
    },
    [model, temperature],
  );

  /*
   * 어시스턴트 응답 한 턴을 완주시킨다.
   * - 내용 수신 전 실패 → 자동 재시도 (최대 MAX_CONNECT_RETRIES)
   * - 스트림이 도중에 끊기거나 max_tokens 도달 → 이어쓰기 요청 (최대 MAX_CONTINUATIONS)
   */
  const runTurn = useCallback(
    async (history: Message[]) => {
      setLoading(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const base: { role: string; content: string }[] = [];
      if (system.trim())
        base.push({ role: "system", content: system.trim() });
      for (const m of history)
        base.push({ role: m.role, content: m.content });

      let content = "";
      let reasoning = "";
      const apply = () => updateLast((m) => ({ ...m, content, reasoning }));

      let continuations = 0;
      let connectRetries = 0;

      try {
        while (true) {
          const msgs =
            content.length === 0
              ? base
              : [
                  ...base,
                  { role: "assistant", content },
                  { role: "user", content: CONTINUE_PROMPT },
                ];

          const before = content.length + reasoning.length;
          let result: Awaited<ReturnType<typeof streamRound>>;
          try {
            result = await streamRound(msgs, controller, (d) => {
              if (d.reasoning) reasoning += d.reasoning;
              if (d.content) content += d.content;
              apply();
            });
          } catch (e) {
            if (controller.signal.aborted) break;
            result = { ok: false as const, message: String(e) };
          }

          if (controller.signal.aborted) break;

          const progressed = content.length + reasoning.length > before;

          // HTTP/네트워크 오류
          if (!result.ok) {
            if (connectRetries < MAX_CONNECT_RETRIES) {
              connectRetries++;
              setNotice(
                `연결 문제 — 자동 재시도 중 (${connectRetries}/${MAX_CONNECT_RETRIES})…`,
              );
              await sleep(900 * connectRetries);
              continue;
            }
            content += (content ? "\n\n" : "") + `⚠️ ${result.message}`;
            apply();
            break;
          }

          // 스트림 본문에 오류가 실려 온 경우
          if (result.errorMsg) {
            content += (content ? "\n\n" : "") + `⚠️ ${result.errorMsg}`;
            apply();
            break;
          }

          // 토큰 한도 도달 or finish_reason 없이 스트림이 끊김 → 이어쓰기
          if (
            content.length > 0 &&
            (result.finish === "length" ||
              (result.finish === null && progressed))
          ) {
            if (continuations < MAX_CONTINUATIONS) {
              continuations++;
              setNotice("응답이 끊겨 자동으로 이어쓰는 중…");
              await sleep(400);
              continue;
            }
            break; // 이어쓰기 한도 초과 — 받은 데까지 표시
          }

          // 아무것도 받지 못하고 스트림 종료 → 재시도
          if (result.finish === null && !progressed && content.length === 0) {
            if (connectRetries < MAX_CONNECT_RETRIES) {
              connectRetries++;
              setNotice(
                `빈 응답 — 자동 재시도 중 (${connectRetries}/${MAX_CONNECT_RETRIES})…`,
              );
              await sleep(900 * connectRetries);
              continue;
            }
            content =
              "⚠️ 모델이 응답을 반환하지 않았습니다. 무료 티어가 혼잡할 수 있으니 잠시 후 다시 시도해 주세요.";
            apply();
            break;
          }

          break; // finish_reason === "stop" 등 정상 종료
        }
      } finally {
        setNotice("");
        setLoading(false);
        abortRef.current = null;
      }
    },
    [system, streamRound, updateLast],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const history: Message[] = [
        ...messages,
        { role: "user", content: trimmed },
      ];
      setMessages([...history, { role: "assistant", content: "", reasoning: "" }]);
      setInput("");
      stickToBottomRef.current = true;
      await runTurn(history);
    },
    [loading, messages, runTurn],
  );

  /* 마지막 답변을 지우고 같은 질문으로 다시 생성 */
  const regenerate = useCallback(async () => {
    if (loading) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const history = messages.slice(0, -1);
    if (!history.length || history[history.length - 1].role !== "user") return;
    setMessages([...history, { role: "assistant", content: "", reasoning: "" }]);
    stickToBottomRef.current = true;
    await runTurn(history);
  }, [loading, messages, runTurn]);

  const copyMessage = useCallback((text: string, i: number) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // 한글 IME 조합 중 Enter는 무시 (조합 확정 키)
    if (e.nativeEvent.isComposing) return;
    // 터치 기기에서는 Enter로 줄바꿈, 전송은 버튼으로
    if (navigator.maxTouchPoints > 0) return;
    e.preventDefault();
    send(input);
  };

  const clear = () => {
    if (loading) stop();
    setMessages([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span>
          <span>
            GLM 5.2 by Slu park <em>/ NVIDIA</em>
          </span>
        </div>
        <div className="actions">
          <button
            className="ghost"
            onClick={() => setShowSettings((s) => !s)}
            aria-expanded={showSettings}
          >
            설정
          </button>
          <button className="ghost" onClick={clear} disabled={!messages.length}>
            대화 지우기
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="settings">
          <label>
            <span>모델</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="z-ai/glm-5.2"
              spellCheck={false}
            />
          </label>
          <label className="wide">
            <span>시스템 프롬프트</span>
            <input
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="예: 너는 한국어로 답하는 친절한 도우미야"
            />
          </label>
          <label>
            <span>temperature · {temperature.toFixed(1)}</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
            />
          </label>
        </section>
      )}

      <main className="chat" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-logo">◆</div>
            <h1>무엇을 도와드릴까요?</h1>
            <p>NVIDIA에서 무상 제공하는 GLM 모델과 대화하세요.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const streamingThis = loading && isLast;
            return (
              <div key={i} className={`row ${m.role}`}>
                <div className="avatar">{m.role === "user" ? "나" : "◆"}</div>
                <div className="bubble">
                  {m.role === "assistant" ? (
                    <>
                      {m.reasoning ? (
                        <details className="reasoning" open={!m.content}>
                          <summary>사고 과정</summary>
                          <div className="reasoning-body">{m.reasoning}</div>
                        </details>
                      ) : null}
                      {m.content ? (
                        <div className="content md">
                          <Markdown text={m.content} />
                        </div>
                      ) : streamingThis ? (
                        <span className="typing">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : null}
                      {streamingThis && notice ? (
                        <div className="notice">{notice}</div>
                      ) : null}
                      {!streamingThis && m.content ? (
                        <div className="msg-actions">
                          <button onClick={() => copyMessage(m.content, i)}>
                            {copiedIdx === i ? "복사됨 ✓" : "복사"}
                          </button>
                          {isLast && !loading ? (
                            <button onClick={regenerate}>다시 생성</button>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="content">{m.content}</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>

      <footer className="composer">
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="메시지를 입력하세요… (Enter 전송, Shift+Enter 줄바꿈)"
            rows={1}
          />
          {loading ? (
            <button className="send stop" onClick={stop} title="중지">
              ■
            </button>
          ) : (
            <button
              className="send"
              onClick={() => send(input)}
              disabled={!input.trim()}
              title="전송"
            >
              ↑
            </button>
          )}
        </div>
        <p className="hint">
          응답은 스트리밍됩니다. API 키는 서버에만 저장되며 브라우저로 전송되지 않습니다.
        </p>
      </footer>
    </div>
  );
}
