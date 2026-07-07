"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Role = "user" | "assistant";
interface Message {
  role: Role;
  content: string;
  reasoning?: string;
}

const SUGGESTIONS = [
  "GLM에 대해 한 문장으로 소개해줘",
  "파이썬으로 피보나치 함수 짜줘",
  "이번 주말 서울 근교 여행지 3곳 추천",
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [system, setSystem] = useState("");
  const [model, setModel] = useState("z-ai/glm-5.2");
  const [temperature, setTemperature] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 새 내용이 생기면 맨 아래로 스크롤
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
      setLoading(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const apiMessages: { role: string; content: string }[] = [];
        if (system.trim())
          apiMessages.push({ role: "system", content: system.trim() });
        for (const m of history)
          apiMessages.push({ role: m.role, content: m.content });

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
          updateLast((m) => ({ ...m, content: `⚠️ ${msg}` }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
                const em =
                  json.error.message || JSON.stringify(json.error);
                updateLast((m) => ({
                  ...m,
                  content: (m.content || "") + `\n⚠️ ${em}`,
                }));
                continue;
              }
              const delta = json.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.reasoning_content)
                updateLast((m) => ({
                  ...m,
                  reasoning: (m.reasoning || "") + delta.reasoning_content,
                }));
              if (delta.content)
                updateLast((m) => ({
                  ...m,
                  content: (m.content || "") + delta.content,
                }));
            } catch {
              /* 부분 청크 — 무시 */
            }
          }
        }
      } catch (e: unknown) {
        const err = e as { name?: string };
        if (err?.name !== "AbortError") {
          updateLast((m) => ({
            ...m,
            content: (m.content || "") + `\n⚠️ ${String(e)}`,
          }));
        }
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [loading, messages, system, model, temperature, updateLast],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const clear = () => {
    if (loading) stop();
    setMessages([]);
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

      <main className="chat" ref={scrollRef}>
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
          messages.map((m, i) => (
            <div key={i} className={`row ${m.role}`}>
              <div className="avatar">{m.role === "user" ? "나" : "◆"}</div>
              <div className="bubble">
                {m.reasoning ? (
                  <details className="reasoning" open={!m.content}>
                    <summary>사고 과정</summary>
                    <div className="reasoning-body">{m.reasoning}</div>
                  </details>
                ) : null}
                <div className="content">
                  {m.content ||
                    (loading && i === messages.length - 1 ? (
                      <span className="typing">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      ""
                    ))}
                </div>
              </div>
            </div>
          ))
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
