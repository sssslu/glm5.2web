# GLM Chat · NVIDIA

NVIDIA에서 무상 제공하는 **GLM** 모델을 쓰는 웹 채팅 에이전트입니다.
Next.js(App Router) + TypeScript. API 키는 **서버에만** 두고 브라우저로 노출하지 않습니다.

- 웹 UI 버전 (배포용) — 이 저장소 루트
- 터미널 CLI 버전 — [`python/`](python/) 폴더

## 구조

```
app/
  api/chat/route.ts   서버 프록시 (키 보관 · NVIDIA로 SSE 스트리밍 통과)
  page.tsx            채팅 UI (스트리밍 · reasoning 표시 · 설정)
  layout.tsx
  globals.css
python/
  glm_chat.py         CLI 하네스
  requirements.txt
```

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

## 배포 (Vercel 권장)

1. 이 폴더를 GitHub에 push (`.env.local` 은 `.gitignore`에 의해 제외됨)
2. [vercel.com](https://vercel.com)에서 저장소 import
3. **Project Settings → Environment Variables** 에 추가:
   - `NVIDIA_API_KEY = nvapi-...`
   - (선택) `GLM_MODEL = z-ai/glm-5.2`
4. Deploy

> 키를 코드/깃에 절대 커밋하지 마세요. 환경변수로만 주입합니다.

## 기능

- 응답 **스트리밍** (SSE)
- GLM의 `reasoning_content`(사고 과정)를 접이식 블록으로 표시
- 멀티턴 대화, 시스템 프롬프트 · 모델 · temperature 설정
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
