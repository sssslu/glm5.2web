#!/usr/bin/env python3
"""
GLM Chat Harness — NVIDIA에서 무상 보급중인 GLM을 채팅 에이전트처럼 쓰는 CLI.

준비:
  1) NVIDIA API 키 발급 (https://build.nvidia.com)
  2) 키를 환경변수 또는 .env 파일에 저장
       PowerShell:  $env:NVIDIA_API_KEY = "nvapi-..."
       .env 파일:   NVIDIA_API_KEY=nvapi-...
  3) 실행:  python glm_chat.py

대화 중 명령어 (앞에 / 를 붙여 입력):
  /help                 명령어 도움말
  /reset                대화 기록 초기화 (시스템 프롬프트는 유지)
  /system <텍스트>      시스템 프롬프트 설정/교체
  /history              현재까지의 대화 보기
  /save [파일]          대화를 JSON으로 저장 (기본: chat_history.json)
  /load <파일>          저장한 대화 불러오기
  /model <이름>         모델 변경 (예: /model z-ai/glm-5.2)
  /temp <값>            temperature 변경 (0.0 ~ 2.0)
  /think                reasoning(사고 과정) 표시 켜기/끄기
  /tokens               마지막 응답의 토큰 사용량
  /multiline            여러 줄 입력 모드 (끝은 빈 줄 두 번 또는 /end)
  /exit  /quit          종료

단축키:
  Ctrl+C  → 생성 중이면 취소, 입력 대기 중이면 종료
  Ctrl+D  → 종료
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

try:
    from openai import OpenAI
except ImportError:
    sys.exit("openai 패키지가 필요합니다.  설치:  pip install openai")


# ── 색상 (터미널이 지원할 때만) ─────────────────────────────────────────────
def _enable_windows_ansi() -> None:
    """Windows 콘솔에서 ANSI 색상 이스케이프를 켠다."""
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004, STD_OUTPUT_HANDLE = -11
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass


_enable_windows_ansi()
_USE_COLOR = sys.stdout.isatty() and os.getenv("NO_COLOR") is None


class C:
    DIM = "\033[90m" if _USE_COLOR else ""       # reasoning / 회색
    CYAN = "\033[36m" if _USE_COLOR else ""      # assistant 라벨
    GREEN = "\033[32m" if _USE_COLOR else ""     # you 라벨
    YELLOW = "\033[33m" if _USE_COLOR else ""    # 시스템 안내
    RED = "\033[31m" if _USE_COLOR else ""       # 오류
    BOLD = "\033[1m" if _USE_COLOR else ""
    RESET = "\033[0m" if _USE_COLOR else ""


def info(msg: str) -> None:
    print(f"{C.YELLOW}{msg}{C.RESET}")


def error(msg: str) -> None:
    print(f"{C.RED}{msg}{C.RESET}", file=sys.stderr)


# ── .env 로더 (python-dotenv 없이도 동작) ──────────────────────────────────
def load_dotenv(path: str = ".env") -> None:
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)


# ── 채팅 에이전트 ───────────────────────────────────────────────────────────
class GLMChat:
    def __init__(
        self,
        api_key: str,
        model: str = "z-ai/glm-5.2",
        base_url: str = "https://integrate.api.nvidia.com/v1",
        system: str | None = None,
        temperature: float = 1.0,
        top_p: float = 1.0,
        max_tokens: int = 16384,
        seed: int | None = None,
        show_reasoning: bool = True,
    ) -> None:
        self.client = OpenAI(base_url=base_url, api_key=api_key)
        self.model = model
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = max_tokens
        self.seed = seed
        self.show_reasoning = show_reasoning
        self.system = system
        self.messages: list[dict[str, str]] = []
        self.last_usage: Any = None
        if system:
            self.messages.append({"role": "system", "content": system})

    # -- 대화 관리 -----------------------------------------------------------
    def set_system(self, text: str) -> None:
        self.system = text
        # 기존 system 메시지 제거 후 맨 앞에 삽입
        self.messages = [m for m in self.messages if m["role"] != "system"]
        self.messages.insert(0, {"role": "system", "content": text})

    def reset(self) -> None:
        self.messages = []
        if self.system:
            self.messages.append({"role": "system", "content": self.system})
        self.last_usage = None

    def save(self, path: str) -> None:
        payload = {
            "model": self.model,
            "temperature": self.temperature,
            "system": self.system,
            "messages": self.messages,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

    def load(self, path: str) -> None:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        self.messages = payload.get("messages", [])
        self.system = payload.get("system")
        self.model = payload.get("model", self.model)
        self.temperature = payload.get("temperature", self.temperature)

    # -- 응답 스트리밍 -------------------------------------------------------
    def ask(self, user_text: str) -> str:
        """사용자 입력을 보내고 응답을 스트리밍 출력한 뒤, 전체 응답 텍스트를 반환."""
        self.messages.append({"role": "user", "content": user_text})

        stream = self.client.chat.completions.create(
            model=self.model,
            messages=self.messages,
            temperature=self.temperature,
            top_p=self.top_p,
            max_tokens=self.max_tokens,
            seed=self.seed,
            stream=True,
            stream_options={"include_usage": True},
        )

        reasoning_open = False   # reasoning 블록을 열었는지
        content_started = False  # 실제 답변이 시작됐는지
        answer_parts: list[str] = []

        print(f"{C.CYAN}{C.BOLD}GLM ▸{C.RESET} ", end="", flush=True)

        try:
            for chunk in stream:
                # usage는 마지막 청크에 choices=[] 로 올 수 있음
                if getattr(chunk, "usage", None):
                    self.last_usage = chunk.usage
                if not getattr(chunk, "choices", None):
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue

                # 1) reasoning_content (GLM의 사고 과정) — 회색으로
                reasoning = getattr(delta, "reasoning_content", None)
                if reasoning and self.show_reasoning:
                    if not reasoning_open:
                        print(f"\n{C.DIM}[사고]{C.RESET} {C.DIM}", end="", flush=True)
                        reasoning_open = True
                    print(reasoning, end="", flush=True)

                # 2) 실제 답변 content
                content = getattr(delta, "content", None)
                if content:
                    if reasoning_open:
                        print(f"{C.RESET}\n{C.CYAN}{C.BOLD}GLM ▸{C.RESET} ", end="", flush=True)
                        reasoning_open = False
                    content_started = True
                    answer_parts.append(content)
                    print(content, end="", flush=True)
        except KeyboardInterrupt:
            stream.close()
            print(f"\n{C.YELLOW}(생성 취소됨){C.RESET}")
            # 부분 응답이라도 기록에 남긴다
            partial = "".join(answer_parts)
            self.messages.append({"role": "assistant", "content": partial})
            return partial
        finally:
            if reasoning_open:
                print(C.RESET, end="")

        print()  # 응답 끝 줄바꿈
        if not content_started:
            info("(빈 응답)")

        answer = "".join(answer_parts)
        self.messages.append({"role": "assistant", "content": answer})
        return answer


# ── 명령어 처리 ─────────────────────────────────────────────────────────────
HELP = __doc__.split("대화 중 명령어", 1)[1] if __doc__ else ""


def read_multiline() -> str:
    info("여러 줄 입력 모드. 끝내려면 빈 줄에서 /end 입력.")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == "/end":
            break
        lines.append(line)
    return "\n".join(lines)


def handle_command(chat: GLMChat, line: str) -> bool:
    """슬래시 명령어 처리. 종료 신호면 False 반환."""
    parts = line[1:].split(maxsplit=1)
    cmd = parts[0].lower() if parts else ""
    arg = parts[1].strip() if len(parts) > 1 else ""

    if cmd in ("exit", "quit", "q"):
        return False
    elif cmd in ("help", "h", "?"):
        print(f"{C.YELLOW}대화 중 명령어{HELP}{C.RESET}")
    elif cmd == "reset":
        chat.reset()
        info("대화 기록을 초기화했습니다.")
    elif cmd == "system":
        if arg:
            chat.set_system(arg)
            info("시스템 프롬프트를 설정했습니다.")
        else:
            info(f"현재 시스템 프롬프트: {chat.system or '(없음)'}")
    elif cmd == "history":
        for m in chat.messages:
            role = m["role"]
            tag = {"system": C.YELLOW, "user": C.GREEN, "assistant": C.CYAN}.get(role, "")
            print(f"{tag}{role}:{C.RESET} {m['content']}")
    elif cmd == "save":
        path = arg or "chat_history.json"
        chat.save(path)
        info(f"저장했습니다 → {path}")
    elif cmd == "load":
        if not arg:
            error("사용법: /load <파일>")
        else:
            try:
                chat.load(arg)
                info(f"불러왔습니다 ← {arg}  (메시지 {len(chat.messages)}개)")
            except (OSError, json.JSONDecodeError) as e:
                error(f"불러오기 실패: {e}")
    elif cmd == "model":
        if arg:
            chat.model = arg
            info(f"모델을 '{arg}' 로 변경했습니다.")
        else:
            info(f"현재 모델: {chat.model}")
    elif cmd == "temp":
        try:
            chat.temperature = float(arg)
            info(f"temperature = {chat.temperature}")
        except ValueError:
            error("사용법: /temp <숫자>  (예: /temp 0.7)")
    elif cmd == "think":
        chat.show_reasoning = not chat.show_reasoning
        info(f"reasoning 표시: {'켜짐' if chat.show_reasoning else '꺼짐'}")
    elif cmd == "tokens":
        u = chat.last_usage
        if u:
            info(
                f"prompt={getattr(u, 'prompt_tokens', '?')}  "
                f"completion={getattr(u, 'completion_tokens', '?')}  "
                f"total={getattr(u, 'total_tokens', '?')}"
            )
        else:
            info("아직 사용량 정보가 없습니다.")
    elif cmd == "multiline":
        text = read_multiline()
        if text.strip():
            _safe_ask(chat, text)
    else:
        error(f"알 수 없는 명령어: /{cmd}  (/help 참고)")
    return True


def _safe_ask(chat: GLMChat, text: str) -> None:
    try:
        chat.ask(text)
    except KeyboardInterrupt:
        print(f"\n{C.YELLOW}(취소됨){C.RESET}")
    except Exception as e:  # API 오류 등
        error(f"오류: {e}")


# ── 메인 ────────────────────────────────────────────────────────────────────
def main() -> None:
    load_dotenv()

    ap = argparse.ArgumentParser(
        description="NVIDIA 무상 GLM 채팅 하네스",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("-m", "--model", default=os.getenv("GLM_MODEL", "z-ai/glm-5.2"))
    ap.add_argument("-s", "--system", default=None, help="시스템 프롬프트")
    ap.add_argument("-t", "--temperature", type=float, default=1.0)
    ap.add_argument("--top-p", type=float, default=1.0)
    ap.add_argument("--max-tokens", type=int, default=16384)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--no-think", action="store_true", help="reasoning 표시 끄기")
    ap.add_argument(
        "--base-url", default="https://integrate.api.nvidia.com/v1"
    )
    ap.add_argument(
        "prompt",
        nargs="*",
        help="주면 단발성 질문으로 실행 후 종료 (없으면 대화형 모드)",
    )
    args = ap.parse_args()

    api_key = os.getenv("NVIDIA_API_KEY")
    if not api_key:
        error(
            "NVIDIA_API_KEY 가 설정되지 않았습니다.\n"
            "  PowerShell:  $env:NVIDIA_API_KEY = \"nvapi-...\"\n"
            "  또는 이 폴더에 .env 파일:  NVIDIA_API_KEY=nvapi-...\n"
            "  키 발급:  https://build.nvidia.com"
        )
        sys.exit(1)

    chat = GLMChat(
        api_key=api_key,
        model=args.model,
        base_url=args.base_url,
        system=args.system,
        temperature=args.temperature,
        top_p=args.top_p,
        max_tokens=args.max_tokens,
        seed=args.seed,
        show_reasoning=not args.no_think,
    )

    # 단발성 모드: 인자로 프롬프트를 주면 한 번 답하고 종료
    if args.prompt:
        _safe_ask(chat, " ".join(args.prompt))
        return

    # 대화형 모드
    info(f"GLM 채팅 시작 — 모델: {chat.model}")
    info("명령어는 /help,  종료는 /exit 또는 Ctrl+D")
    print()

    while True:
        try:
            line = input(f"{C.GREEN}{C.BOLD}You ▸{C.RESET} ")
        except EOFError:
            print()
            break
        except KeyboardInterrupt:
            print(f"\n{C.YELLOW}종료하려면 /exit 또는 Ctrl+D{C.RESET}")
            continue

        line = line.strip()
        if not line:
            continue
        if line.startswith("/"):
            if not handle_command(chat, line):
                break
            continue

        _safe_ask(chat, line)

    info("안녕히 가세요 👋")


if __name__ == "__main__":
    main()
