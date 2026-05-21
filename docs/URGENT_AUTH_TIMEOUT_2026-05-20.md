# 영맨(Youngman) 앱 — 인증 timeout 비상 상황 (2026-05-20)

> ChatGPT 복붙용 문서. 영맨 = B2B 영업사원용 모바일 CRM. 핵심 기능 = 통화 종료
> 후 녹음 자동 감지 → AI 요약 → 고객관리대장 자동 저장. **24/365 무결성 요구.**

---

## 1. 1분 컨텍스트

- **앱 구조**: React Native (Android only) + WebView 래퍼.
  - WebView는 `https://youngman-biz.com` (cafe24 호스팅, PHP) 사이트를 표시.
  - 통화 감지/오버레이/녹음 자동 제출은 native (Kotlin) — CallScreeningService /
    CallStateReceiver / PostCallScan / Headless task (FGS 아님).
- **인증 모델**: Supabase Auth.
  - **WebView 안 Supabase JS SDK가 auth source of truth**. localStorage에 세션
    저장 + 자동 refresh.
  - 사이트의 `bridge.js`가 `TOKEN_REFRESHED` 이벤트를 듣다가 `auth.login`
    postMessage로 RN에 access_token 전달.
  - RN은 받은 access_token을 인메모리 캐시 + AsyncStorage 백업 후 PHP API 호출
    (`Bearer <token>`).
- **API**: cafe24의 `records.php`, `process-recording.php`, `upload.php`,
  `job-status.php` 등. 모두 Supabase JWT 검증.
- **비교 대상 (사장님 표현 그대로)**: 경쟁사 모모콜(momocall.kr)은 한 달 동안 안
  쓰던 폰에서도 "찰거머리처럼" 통화 시 작동. 영맨은 **장기 미사용 후 첫 사용 시
  거의 매번 실패**.

## 2. 비상 상황 요약 (2026-05-20)

**시나리오**:
1. 사장님이 자고 일어나서(약 8시간+ 미사용 상태) PoC 테스트 시작.
2. **1차 통화** → 통화 후 모달 안 뜸, 아무것도 작동 안 함.
3. **2차 통화** → 역시 작동 안 함. 상단 알림 아이콘은 남아있음.
4. **3차 통화** → 통화 후 모달 정상 표시 → **"요약보기" 탭 → "처리 실패 HTTP 401"
   모달**.
5. 그 직후 시스템 모달 **"다시 로그인이 필요해요. 세션이 만료되었습니다.
   로그인 화면으로 이동할까요?"** (SESSION_DEAD 이벤트).
6. 사장님이 "로그인" 탭 → 새로 로그인 → 정상 작동 시작.

**해결해야 할 패턴**: 자고 일어났는데 영맨이 안 깬다. 모모콜은 깨어 있다.

## 3. ErrorLog (16:02:10 ~ 16:03:24, 74초)

```
16:02:10.991 [Session.refresh] start
              ← refreshProfile() → apiGet(auth-profile) → maybeProactiveRefresh 트리거
16:02:20.998 [Session.refresh] timeout after 10010ms
              ← ★ refreshSession() 응답 없음 (10초)
16:02:21.565 [Session.refresh] start
              ← 별도 호출자 (tryRefreshSession from apiGet)
16:02:22.584 [Session] logged-out 401 — skipping reload
              ← authRef.current == null → reload skip, SESSION_DEAD emit
16:02:41.571 [Session.refresh] timeout after 20006ms
              ← ★ 20초 timeout
16:02:41.575 [api] HTTP 401 — /records.php?resource=auth-profile
16:02:41.575 [api] 토큰 검증 실패 — /records.php?resource=customer-log
16:02:41.576 [api] 토큰 검증 실패 — /records.php?resource=customer-log
16:02:41.600 [Session.refresh] start (uploadRecording 트리거)
16:02:42.606 [Session] logged-out 401 — skipping reload
16:02:51.618 [Session.refresh] timeout after 10017ms
16:02:52.068 [Session.refresh] start
16:02:53.085 [Session] logged-out 401 — skipping reload
16:03:12.073 [Session.refresh] timeout after 20005ms
16:03:12.074 [api] HTTP 401 — /records.php?resource=ledger-groups
16:03:12.075 [api] HTTP 401 — /upload.php   ← 통화 녹음 업로드 실패
16:03:24.090 [Auth.login] user=afa8cd5c-560e-42e2-9113-7f9e16e4e9ac
              ← 사장님이 모달 "로그인" 탭 → 수동 재로그인 완료
16:03:24.099 [Auth.login] user=afa8cd5c…   (중복 — dedup 무시됨)
16:03:24.104 [Auth.login] user=afa8cd5c…
```

**관찰 사실**:
- `refreshSession()` **6연속 모두 timeout** (10초 또는 20초). 성공 0건.
- `auth.login` postMessage **수동 재로그인 전까지 0건**.
- → 즉 **WebView → RN 방향 메시지가 한 번도 안 도착했다**.
- 401 받은 엔드포인트: `auth-profile`, `customer-log`, `ledger-groups`,
  `upload.php`. 모두 같은 stale token으로 호출됨.
- `Auth.login` 마지막에 3건 연속 — bridge가 회복되자 메시지가 한꺼번에 풀린
  것처럼 보임.

## 4. 현재 인증 아키텍처

### 4.1 Refresh 트리거 (RN 측)

API 호출 시 다음 조건에서 refresh 요청:
- (a) **Proactive**: `isSessionExpiringSoon(5*60_000)` (5분 이내 만료) →
  `tryRefreshSession(10_000)` 호출.
- (b) **Reactive**: 401 응답 받음 → `tryRefreshSession(20_000)` 호출 → 성공 시
  요청 재시도.

### 4.2 `tryRefreshSession()` 동작 (`src/services/api/client.ts`)

1. inflight dedup (동시 N건 호출 → 1건으로 합침).
2. `Error('start')` 로깅 + `SESSION_REFRESH_REQUEST_EVENT` emit.
3. `waitForSessionUpdate(timeoutMs)` — `auth.login` 도착할 때까지 대기.
4. 결과: `ok in <ms>` 또는 `timeout after <ms>` 로깅.

### 4.3 WebView 측 `injectSessionRefresh()` (`src/features/webview/WebViewHost.tsx`)

`SESSION_REFRESH_REQUEST_EVENT` 리스너가 WebView에 JS 주입:

```javascript
(function() {
  var post = function(s) {
    if (!s || !s.access_token) return false;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'auth.login',
      payload: { accessToken: s.access_token, ... }
    }));
    return true;
  };
  try {
    // (1) Fast path — localStorage 직독.
    var keys = Object.keys(localStorage || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('sb-') !== 0 || k.indexOf('-auth-token') < 0) continue;
      var raw = localStorage.getItem(k);
      var s = JSON.parse(raw);
      if (s && s.access_token) { post(s); break; }
    }
    // (2) 영맨 웹측 single-refresh hook.
    if (window.YoungmanBridge && typeof window.YoungmanBridge.refreshSession === 'function') {
      try { window.YoungmanBridge.refreshSession(); } catch (e) {}
    }
  } catch (e) {}
})();
```

1초 후 폴백:
- 새 `auth.login` 도착했으면 → 성공, 끝.
- `authRef.current == null` → "logged-out 401 — skipping reload" 후
  `SESSION_DEAD_EVENT` emit.
- 30초 reload cooldown 내 → skip.
- 최근 60초 내 `auth.login` 있었음 → 무시 (Path A 3번 가드).
- 2회 연속 실패 → SESSION_DEAD emit.
- 위 모두 통과 시 → `webViewRef.current?.reload()` (hard reload 폴백).

### 4.4 "Path A 1번" 결정 (2026-05-20)

- 과거: RN 주입 JS에서 `supabase.auth.refreshSession()` 직접 호출 + 웹팀 자체
  hook도 같은 함수 호출 → **dual-consumer race**. 한쪽이 refresh token 소비하면
  다른 쪽이 invalid 받아서 logout 트리거.
- **결정**: RN의 `injectSessionRefresh`에서 `supabase.auth.refreshSession()`
  직접 호출 **제거**. `window.YoungmanBridge.refreshSession()`만 single source.
- 웹팀 측 `bridge.js`는 `_refreshInflight` + 25초 cooldown 적용 (commit 15f0959).

### 4.5 6중 안전망 (이번 ship에서 완성)

1. 앱팀 `auth.logout` race guard 30초 (`messageHandler.ts`).
2. 웹팀 `logout.html?explicit=1` 가드 (영맨 commit 7917f43).
3. 웹팀 `bridge.js notifyLogout` cooldown 30초.
4. 웹팀 `auth-shared.js SIGNED_OUT recent-refresh guard 60초` (commit e8de91d).
5. 웹팀 `auth-shared.js _refreshInflight + 25초 cooldown` (commit 15f0959).
6. 앱팀 `ConfirmRecording` 3초 session retry.

**이 6중 안전망은 race 문제를 푸는 도구**. 이번 케이스는 **race가 아니라
timeout** (응답 자체가 0건) 이라서 직접적인 도움이 안 된 것으로 보임.

## 5. 가능한 원인 후보

### A. Supabase refresh token 자체 만료
- Supabase는 refresh token rotation을 적용. **stale token reuse interval
  10초 후 invalidate**.
- 8시간 이상 미사용 + 백그라운드에서 silent refresh 실패 누적 → 캐시된 refresh
  token이 invalid 상태.
- **반례**: 통상 invalid refresh는 즉시 400/401 응답을 받아야지 **10/20초 timeout
  은 안 됨**. 즉 응답을 받아서 처리해야 timeout이 아닌 다른 error로 떨어져야
  자연스러움.
- 다만 만약 `bridge.js`가 invalid refresh 응답을 받고 자체적으로 swallow하고 RN에
  알리지 않으면 → RN에서는 timeout으로만 보임.

### B. WebView가 백그라운드에서 paused / 컨텐츠 프로세스 회수됨
- Android가 메모리 회수해서 WebView 컨텐츠 프로세스를 죽이면 → 주입한 JS가
  실행 안 됨 → `injectJavaScript`는 큐잉만 되고 응답 0건 → **timeout**.
- `onContentProcessDidTerminate` / `onRenderProcessGone` 리스너 등록은 되어 있고
  reload 트리거. **하지만 이 이벤트가 안 떴을 가능성** (또는 8시간 idle 사이에
  떴지만 reload 후 다시 회수 반복).
- **가장 가능성 높은 후보 (1순위)**.

### C. WebView가 cold start 중이라 bridge.js 미로드
- 앱 cold start → 사용자가 트리거 (예: PostCallScan) → WebView 페이지 로드 중 →
  `window.YoungmanBridge` 아직 undefined → 가드(`if (window.YoungmanBridge && ...)`)
  통과 못 하고 빠져나옴 → fast path도 localStorage 비어있으면 실패 → timeout만
  기다림.
- **사장님 1, 2차 통화 미작동**과 일치 (앱 백그라운드 → 통화 종료 → headless
  task만 동작 → WebView UI는 아직 잠들어 있음).
- **가장 가능성 높은 후보 (2순위)**.

### D. Headless task에서는 WebView 자체가 없음
- AutoSubmit headless task (`src/features/callRecording/headless/autoSubmitTask.ts`)
  는 RN UI가 없는 상태에서 동작. → WebView 자체 미존재 → `injectSessionRefresh`
  호출 자체 불가능.
- 코드 상으로는 headless task가 `processRecordingAsync` 호출 → `apiPostMultipart`
  → 401 → `tryRefreshSession()` → 이벤트 emit → **리스너 없음 (WebViewHost
  unmounted)** → timeout 그대로.
- 401 시 `AUTO_SUBMIT_AUTH_FAIL_FLAG` AsyncStorage에 저장 → 다음 foreground 시
  WebViewHost가 읽어서 SESSION_DEAD 모달 표시.
- **이번 케이스에서도 강하게 의심됨** (3번째 통화에서 모달이 떴으니 그 시점엔
  UI가 살아있었을 가능성, 하지만 1,2번째는 headless만 동작 → 그래서 작동 안 함).

### E. Android Doze / 배터리 최적화로 네트워크 차단
- 백그라운드 8시간 = Doze 깊은 단계 진입 가능 → 백그라운드 fetch 자체 막힘.
- Supabase `*.supabase.co` 도달 불가 → bridge.js의 refresh 시도가 무한 hang.
- **반례**: 그러면 사용자가 폰을 켜고 앱을 다시 보면 즉시 해소되어야 함 (도즈
  해제). 하지만 사장님 케이스는 앱 진입 후에도 timeout 발생.

### F. `_refreshInflight` 락이 stuck
- 영맨 commit 15f0959에서 추가된 `_refreshInflight` 플래그. 한 번의 refresh가
  완료(resolve/reject) 신호를 못 주면 → 영원히 inflight 상태 → 새 호출 즉시
  cooldown 캐시 반환 → 하지만 캐시된 값이 stale.
- **검증 필요**: bridge.js의 `_refreshInflight` 해제 finally 블록이 모든 예외
  케이스를 다 잡는지 (timeout, network error, abort 등).

## 6. 핵심 의문 (ChatGPT에게)

1. **ErrorLog 패턴 (timeout 6연속, auth.login 0건) 으로 원인 좁히면 A~F 중
   어느 게 가장 유력한가**? 각각의 신호로 분리할 방법은?

2. **장기 미사용 후 첫 통화 100% 작동시키려면 영맨 아키텍처에 어떤 구조적
   변경이 필요한가**? (모모콜 수준 안정성)

3. **즉시 적용 가능한 패치** (전면 리팩토링 없이):
   - (i) Native에서 직접 Supabase refresh token으로 token 갱신
     (`POST /auth/v1/token?grant_type=refresh_token`)을 도입해서 WebView 없이도
     작동시키는 방법. Path A 1번(dual-consumer race 방지)과 모순되지 않으려면
     어떻게 게이팅해야 하는가? 예: "WebView가 떠 있으면 WebView, 아니면
     native fallback".
   - (ii) 앱 cold start 시 WebView를 **백그라운드에서 미리 로드**하는 패턴 —
     사용자가 native trigger로 진입하기 전에 bridge.js 준비 끝나도록.
   - (iii) WebView 컨텐츠 프로세스 사망 빠른 감지 — heartbeat ping/pong, 또는
     `onRenderProcessGone` 외 추가 시그널.
   - (iv) Headless task가 401 만났을 때, RN 측에서 WebView 없이 **Supabase refresh
     token으로 native HTTP fallback** 후 재시도 + AsyncStorage 갱신 + 다음
     foreground 시 WebView에 sync.

4. **Path A 1번 결정이 이 timeout 시나리오에서는 오히려 발목을 잡는가**? 즉
   "single source of truth"가 single point of failure가 된 건가? 어떻게 single
   source의 장점은 유지하면서 SPoF를 분리할 수 있는가?

5. **검증 가능한 가설 실험**:
   - (a) WebView render process 상태를 주기적으로 로깅하면 사망 시점을 잡을 수
     있는가?
   - (b) `refreshSession()` 직전에 `window.YoungmanBridge` 존재 여부 로깅 →
     undefined이면 cold-start 케이스 확정.
   - (c) bridge.js에 `_refreshInflight` 진입/해제 시 RN에 ping postMessage 추가 →
     stuck 케이스 확정.

## 7. 제약 조건 / 컨텍스트

- **앱팀** = 사장님 + 이 Claude 인스턴스 (RN + Android native 코드).
- **웹팀** = 사장님 + 별도 Claude 인스턴스 (cafe24 호스팅 PHP 사이트 + bridge.js).
- 사장님이 양쪽 모두 결정권자. 코드 변경 사양은 앱팀이 작성해서 웹팀에 전달
  가능.
- **iOS 미출시**. Android-only.
- **현재 미사용 옵션**:
  - Foreground Service (사용자 추가 권한 필요, 가능은 함).
  - 자체 native auth client (Supabase Android SDK 등).
- **운영 중인 폴백 인프라** (인증 통과 후엔 견고):
  - PHP 동기 처리 → Path B cron worker → Railway worker → audio_kept 24h 보존.
  - Idempotency: `audio_sha256` + `client_request_id`.
  - FCM: `call_summary_ready` / `usage_warning` / `overage_charged`.
  - `/job-status.php` 8-status + step_label + progress_pct.

요컨대 **요약 처리 자체는 견고**. **인증 게이팅에서 막혀서 시작도 못 함**이
지금 문제의 근본.

## 8. 영맨이 추구하는 것

- 슬로건: **"단 한 건의 고객정보 누락 없이 관리"**.
- 제품 슬로건: **simple, painless, beautiful, one-tap**.
- 따라서 "장기 미사용 후 첫 통화 실패"는 제품 핵심 가치와 정면 충돌.

## 9. 첨부: 가장 관련 깊은 파일

- `src/services/api/client.ts` — `tryRefreshSession`, `maybeProactiveRefresh`,
  inflight dedup.
- `src/features/webview/WebViewHost.tsx` — `injectSessionRefresh`, 1초 폴백,
  SESSION_DEAD 분기, render-process 핸들러.
- `src/features/webview/bridge/messageHandler.ts` — `auth.login` / `auth.logout`
  처리, 30초 race guard, dedup.
- `src/features/callRecording/headless/autoSubmitTask.ts` — headless 흐름,
  `AUTO_SUBMIT_AUTH_FAIL_FLAG`, `PENDING_JOB_KEY`.
- `src/services/auth/session.ts` — JWT 캐시, `waitForSessionUpdate`.

(코드 풀텍스트가 필요하면 위 경로의 파일을 함께 ChatGPT에 첨부해 주세요.)
