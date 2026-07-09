# GLM Chat · NVIDIA

NVIDIA에서 무상 제공하는 **GLM** 모델을 쓰는 웹 채팅 에이전트입니다.
Next.js(App Router) + TypeScript. API 키는 **서버에만** 두고 브라우저로 노출하지 않습니다.

- 웹 UI 버전 (배포용) — 이 저장소 루트
- 터미널 CLI 버전 — [`python/`](python/) 폴더

## 구조

```
app/
  api/chat/route.ts   서버 프록시 (로컬 dev · Vercel용 — 키 보관 · SSE 통과)
  page.tsx            채팅 UI (스트리밍 · 자동 이어쓰기 · 마크다운 · 설정)
  layout.tsx
  globals.css
netlify/
  edge-functions/chat.ts   Netlify 프로덕션용 /api/chat (Edge Function)
python/
  glm_chat.py         CLI 하네스
  requirements.txt
```

## 응답이 중간에 끊기는 문제 — 해결 방식

Netlify의 일반 서버리스 함수는 실행 시간이 **기본 10초(최대 26초)** 로 제한되어,
긴 답변을 스트리밍하는 도중 함수가 종료되면서 응답이 끊겼습니다. 두 겹으로 해결:

1. **서버**: `/api/chat` 을 Next 라우트 대신 **Netlify Edge Function**
   (`netlify/edge-functions/chat.ts`)이 처리 — 스트리밍에 실행 시간 제한이 없음.
   NVIDIA 접속 오류(429/5xx)는 스트림 시작 전에 자동 재시도.
2. **클라이언트**: `finish_reason` 을 추적해서
   - 스트림이 `finish_reason` 없이 끊기면 → 끊긴 지점부터 **자동 이어쓰기** (최대 3회)
   - `max_tokens` 도달(`length`)도 동일하게 이어쓰기
   - 내용 수신 전 실패하면 → 자동 재접속 (최대 2회)

## 로컬 실행

```powershell
# 1) 의존성 설치
npm install

# 2) 환경변수 — .env.example 을 .env.local 로 복사 후 키 입력
#    (이미 .env.local 이 있으면 그대로 사용)
#    NVIDIA_API_KEY=nvapi-...

# 3) 개발 서버
npm run dev
# → http://localhost:3000
```

## 배포

### Netlify (현재 배포: slu-glm.netlify.app)

1. 이 폴더를 GitHub에 push (`.env.local` 은 `.gitignore`에 의해 제외됨)
2. Netlify에서 저장소 import — `netlify.toml` 이 빌드와 Edge Function을 자동 설정
3. **Site configuration → Environment variables** 에 추가:
   - `NVIDIA_API_KEY = nvapi-...`
   - (선택) `GLM_MODEL = z-ai/glm-5.2`
4. Deploy

### Vercel

Vercel에서는 `app/api/chat/route.ts` 가 그대로 사용됩니다 (`maxDuration = 60`).
Project Settings → Environment Variables 에 같은 변수를 추가하세요.

> 키를 코드/깃에 절대 커밋하지 마세요. 환경변수로만 주입합니다.

## 기능

- 응답 **스트리밍** (SSE) + 끊김 시 **자동 이어쓰기/재시도**
- **마크다운 렌더링** (표 · 목록 · 코드 블록 + 복사 버튼)
- GLM의 `reasoning_content`(사고 과정)를 접이식 블록으로 표시
- 멀티턴 대화, 시스템 프롬프트 · 모델 · temperature 설정
- 대화·설정 **localStorage 저장** (새로고침해도 유지)
- 메시지 복사 · 마지막 답변 다시 생성
- 스마트 자동 스크롤 (위로 올려 읽는 중엔 강제 스크롤 안 함)
- 한글 IME 조합 중 Enter 오전송 방지, 터치 기기에선 Enter = 줄바꿈
- 생성 중 중지, 모바일 반응형, 다크 테마

## 참고 — 모델 가용성

무상 티어라 시점에 따라 GLM이 `DEGRADED` 이거나 용량 초과(`request limit reached`)일 수 있습니다.
이는 NVIDIA 서버 측 상태이며, 설정에서 모델을 다른 ID로 바꾸거나 잠시 후 재시도하면 됩니다.
사용 가능한 모델 목록:

```bash
curl -s https://integrate.api.nvidia.com/v1/models \
  -H "Authorization: Bearer $NVIDIA_API_KEY"
```

## 보안 주의

API 키가 외부에 노출된 적이 있다면 [build.nvidia.com](https://build.nvidia.com)에서 **재발급(rotate)** 하세요.
