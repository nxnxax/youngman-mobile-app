# 영맨 앱 측 결제(PortOne + 토스페이먼츠) 통합 TODO

사용자가 정리한 작업 리스트 — 영맨 구독 결제 시스템.
PG는 **PortOne(포트원)** 어그리게이터 통해 **토스페이먼츠** 사용.
(이전 Polar 계획은 폐기 — 한국 결제 지원 + 카드사 앱 redirect 처리 때문에 PortOne으로 변경)

웹 측 결제 페이지 (`/billing`, `/subscribe`)와 서버 API (`/api/billing/status`,
`/api/auth/me` 등)는 별도. 이 문서는 RN Android 앱 측에서 해야 할 일만.

## A. 결제 진입점

- [ ] **A1.** 설정 메뉴 또는 프로필 화면에 "플랜 보기 / 구독 관리" 항목 추가
- [ ] **A2.** 항목 탭 → WebView로 `/billing` 또는 `/subscribe` 진입
      (앱은 결제 API 직접 호출 안 함; 결제는 항상 웹+서버 측에서만)
- [ ] **A3.** ⚠ **사전 리스크**: App Store / Play Store 외부 결제 정책 review.
      iOS reject 우려 가장 큼 — 앱 카테고리 확인 후 외부결제 가능 여부
      심사팀에 미리 확인.

## B. 결제 완료 감지

- [ ] **B1.** WebView의 `onShouldStartLoadWithRequest`에서 결제 성공
      redirect URL intercept
      - 예: `youngman-biz.com/billing?success=1`
      - 예: `youngman-biz.com/billing/return?session_id=...`
      - 정확한 패턴은 웹팀과 협의
- [ ] **B2.** 감지 즉시 로컬 plan 캐시 무효화
- [ ] **B3.** `/api/auth/me` 또는 `/api/billing/status` 재호출 →
      `plan`, `plan_status`, `summary_used`, `summary_limit` 갱신
- [ ] **B4.** UI 갱신 — 통화녹취 / AI 요약 버튼 활성 상태 즉시 반영

## C. Bridge 메시지

- [ ] **C1.** `subscription.statusUpdate` (web → app):
      ```json
      { "plan": "...", "plan_status": "...",
        "summary_limit": 20, "summary_used": 7,
        "current_period_end": "2026-..." }
      ```
- [ ] **C2.** app → web 방향은 필요 없음 (앱이 직접 server status endpoint
      호출하므로 web → app 단방향으로 충분)

## D. 기능 게이팅 UI

- [ ] **D1.** 통화 종료 → AI 요약 자동 업로드 전 사용량 사전 검증
      - `GET /api/billing/status` 또는 `/api/usage/check-summary` 호출
      - `allow=false` 면 업로드 skip + 안내 모달
- [ ] **D2.** 안내 모달 카피
      - free: "Plus 구독부터 통화 AI 요약 가능합니다 [지금 업그레이드]"
      - plus 한도 초과: "이번 달 20회 모두 사용 — Pro 업그레이드 또는
        다음 결제일까지 대기"
      - trialing 5회 소진: "체험 5회 소진 — Plus 구독으로 계속"
- [ ] **D3.** 메인/설정 화면에 사용량 인디케이터 (선택):
      "이번 달 AI 요약: 7/20회"

## E. 신규 가입자 5회 체험

- [ ] **E1.** 첫 가입 시 trialing 상태 + 5회 무료 안내 모달 (1회만)
- [ ] **E2.** 매 사용 후 "체험 X회 남음" 표시
- [ ] **E3.** 5회 소진 시점에 Plus/Pro 권유 모달

## F. 결제 실패 / 만료

- [ ] **F1.** `plan_status === 'past_due' | 'cancelled'` 인 사용자가
      통화녹취 기능 사용 시도 시:
      "결제가 처리되지 않았습니다 [결제 정보 업데이트]" → `/billing` 이동

## G. 검증 항목 (PoC 단계 필요)

- [ ] **G1.** WebView 안에서 PortOne(토스페이먼츠) 결제 동작 확인
      - PortOne v2 SDK가 띄우는 토스페이먼츠 결제창 — 3DS / 카드사 앱
        redirect 정상 처리되는가
      - **카드사 앱 redirect**: PortOne이 `intent://`, `kb-acp://`,
        `shinhan-sr-ansimclick://` 등 다양한 스킴 사용 → linkRouter.ts에서
        반드시 `Linking.openURL`로 시스템에 위임해야 함. 현재 `intent:`는
        SYSTEM_SCHEMES에 있음, 나머지 카드사 스킴은 `APP_SCHEMES`로 추가 필요
      - 카드사 앱에서 결제 인증 후 영맨 앱 WebView로 복귀하는 경로 (Android
        `App2App` 패턴)
      - 결제 성공 후 PortOne webhook → 서버 → 웹페이지 redirect URL을
        WebView가 intercept 가능한가
- [ ] **G2.** WebView로 `/subscribe` 진입 시 Supabase 세션 (cookie / storage)
      정상 전달되는지 확인
      - 같은 WebView 인스턴스 + 같은 도메인이라 일반적으로 OK
      - `sharedCookiesEnabled` + `domStorageEnabled` 이미 ON ([WebViewHost.tsx:209-213](../src/features/webview/WebViewHost.tsx#L209))

## 권장 진행 순서 (제안)

1. **G2 → G1** PoC 먼저 — 결제 자체가 WebView에서 동작 안 하면 다 무용지물
2. **A1 → A2** 진입점 UI (15분)
3. **B1~B4** 결제 완료 감지 (반나절)
4. **D1~D3** 게이팅 UI (1일)
5. **E1~E3** 체험 UX (반나절)
6. **C1, F1** Bridge + 만료 처리 (각 반나절)

각 단계는 웹팀 / 서버 API 준비 상태에 dependency 있음.
