# 영맨 사이트 — 앱팀 → 웹팀 작업 요청 (2026-05-20)

> **수신**: 영맨 웹팀 (cafe24 호스팅, `youngman-biz.com`, PHP + bridge.js)
> **발신**: 앱팀 (RN + Android Native)
> **컨텍스트**: 2026-05-20 비상 상황 분석 결과 + 앱 구조 대전환 결정
> **요지**: 영맨 앱이 **WebView 의존 인증** 구조를 버리고 **Native 중심**으로 옮겨갑니다.
> 그에 맞춰 서버 측에서 보강/표준화해야 할 항목 정리.

---

## 0. 왜 이 변경이 필요한가 (1분 요약)

사장님이 8시간 미사용 후 통화 PoC 테스트 → **첫 2통 완전 무반응 / 3통째 통화 후 모달
은 떴으나 "처리 실패 HTTP 401"** → 시스템 모달 "다시 로그인이 필요해요" 떨어짐.

ErrorLog 분석 결과:
- `refreshSession()` Promise **6연속 timeout** (10s / 20s 번갈아).
- WebView → RN `auth.login` postMessage **수동 재로그인 전까지 0건**.
- 즉 **WebView가 백그라운드 idle 8시간 동안 죽거나 paused 됨** → bridge.js가 동작 자체를
  못 함 → RN은 통신 응답을 영영 못 받음.

**경쟁사 모모콜**은 WebView 의존이 0%. 한 달 미사용 폰에서도 즉시 작동.

**결론**: 영맨도 통화 감지 / 인증 복구 / 업로드 / 재시도를 **Native 책임**으로 옮긴다.
WebView는 화면 표시 + 세션 sync 보조 역할로 격하.

전체 원본 분석: [`URGENT_AUTH_TIMEOUT_2026-05-20.md`](URGENT_AUTH_TIMEOUT_2026-05-20.md)
에 ErrorLog 풀텍스트 + 후보 6개 원인 + 6중 안전망 한계까지 정리되어 있음.

---

## 1. 웹팀이 해줄 일 (작업 항목)

### 1.1 `recording_jobs` 테이블 — 필드 보강 (1순위)

앱팀이 **Native Outbox** 를 새로 만든다. 업로드 성공 후 서버 job_id를 받아서 상태
추적하는 흐름. 그러려면 서버 측 `recording_jobs` 테이블이 다음 필드를 모두 가지고
있어야 함:

```
id                  -- UUID
user_id             -- 영맨 사용자 ID (Supabase user.id)
storage_path        -- 업로드된 audio 파일 경로
audio_sha256        -- 64자 hex
client_request_id   -- 앱이 deterministicRequestId(uri)로 생성
duration_seconds    -- 통화 길이
status              -- enum (아래 참조)
retry_count         -- 재시도 횟수
last_error          -- 마지막 에러 메시지 (텍스트)
transcript          -- STT 결과
summary_json        -- LLM 결과 (JSON)
created_at
updated_at
```

**status enum (확정)**:
```
queued              -- 업로드만 끝남, STT 대기
uploaded            -- 동의어 (queued 와 같이 써도 됨)
stt_processing      -- 음성 → 텍스트 변환 중
llm_processing      -- LLM 요약 중
ready_to_review     -- 결과 준비됨, 사용자 검토 대기
saved               -- 사용자가 customer_log에 저장 완료
failed_retryable    -- 일시 실패 (cron worker / Railway worker 가 다시 시도 가능)
failed_permanent    -- 영구 실패 (사용자 알림 필요)
```

**참고**: 영맨 commit `1069ef7`에서 이미 8-status + step_label + progress_pct 도입.
이름이 다르면 통일 부탁드림. 위 8개 enum을 우선 기준으로 잡고, 기존 명명이 더 좋다면
앱팀도 거기 맞춤. 사장님 결정.

### 1.2 Idempotency 강화 (1순위)

**중복 처리 방지 기준**:
- `audio_sha256 + user_id` 동일 → 기존 job 반환
- 또는 `client_request_id` 동일 → 기존 job 반환

**서버 응답 규약**:

| 케이스 | 응답 |
|---|---|
| 신규 업로드 | `200 / 201` + 새 `job_id` |
| 중복 업로드 (job 진행 중) | `200` + 기존 `job_id` + `status` |
| 중복 업로드 (job 완료됨) | `200` + 기존 `job_id` + 기존 결과 + `status: saved` |
| customer_log 중복 저장 시도 | **저장 금지** + 기존 row 반환 |

**왜**: Native Outbox가 앱 종료 / 네트워크 끊김 / 401 등에서 같은 파일을 여러 번 보낼
수 있음. 서버가 막아줘야 사장님 고객관리대장에 중복 row 안 생김.

**이미 일부 존재**: PROJECT_CONTEXT 9번에 "audio_sha256 (24h 안 같은 파일 차단) +
client_request_id (서버 dedup)" 적혀 있음. **24h 제한을 풀고 영구 dedup으로 강화**
부탁드림 — 사장님이 어제 통화한 동일 파일을 오늘 우연히 재처리해도 중복 row 절대
생기면 안 됨.

### 1.3 API 401 error_code 표준화 (1순위)

현재 `upload.php` / `process-recording.php` / `records.php` 가 401 떨어질 때 응답
바디가 들쭉날쭉. 앱이 케이스 분기하려면 **표준 error_code** 필수.

**응답 포맷 (모든 API)**:

```json
{
  "ok": false,
  "error_code": "AUTH_EXPIRED",
  "message": "토큰이 만료되었습니다. refresh 후 재시도하세요.",
  "http_status": 401
}
```

**error_code 표준**:

| code | 의미 | 앱 동작 |
|---|---|---|
| `AUTH_EXPIRED` | access_token 만료, refresh 가능 | native refresh fallback → 재시도 |
| `AUTH_INVALID` | refresh_token도 무효, 재로그인 필요 | SESSION_DEAD 모달 |
| `AUTH_REQUIRED` | 토큰 자체 없음 | 로그인 화면 유도 |
| `JOB_DUPLICATE` | 같은 파일 이미 처리 중 (sha256/client_request_id 충돌) | 기존 job 채택 |
| `JOB_EXISTS` | 같은 파일 처리 완료됨 | 기존 결과 사용 |
| `RETRYABLE_SERVER_ERROR` | 5xx 부류 일시 실패 | outbox `failed_retryable` 마킹 |

**핵심**: `AUTH_EXPIRED` vs `AUTH_INVALID` **구분이 가장 중요**. 지금처럼 둘 다 401
바닐라로 떨어지면 앱이 무조건 SESSION_DEAD 모달 띄움 → 사장님 새벽 1-3시 통화 전부
유실됨.

### 1.4 `job-status.php` 응답 강화 (1순위)

앱 Outbox가 주기적으로 폴링하는 엔드포인트.

**응답 필수 필드**:

```json
{
  "ok": true,
  "job_id": "uuid…",
  "status": "stt_processing",
  "step_label": "음성을 텍스트로 변환 중입니다",
  "progress_pct": 45,
  "retryable": true,
  "audio_kept": false,
  "result_url": null,
  "error_code": null,
  "updated_at": "2026-05-20T16:02:10Z"
}
```

- `retryable` — `false`면 앱이 outbox에서 `failed_permanent` 로 마킹 + 사장님께 알림
- `audio_kept` — `true`면 24h 보존 모드 (4차 폴백) — 사장님 수동 재처리 옵션 노출
- `step_label` — 사용자에게 그대로 보여줄 한국어
- `progress_pct` — 0-100, 단조증가 보장

**기존 commit `1069ef7`에서 이미 한 부분 있다면 위 필드명에 맞춰 통일**해 주세요.

### 1.5 ★ `bridge.js` Heartbeat 신규 (1순위)

**가장 중요한 신규 작업**. 앱팀의 Native Fallback Refresh 로직이 안전하게 작동하려면
"WebView가 살아있는지" 를 RN이 확실히 알아야 함. 현재는 timeout으로만 추측.

**구현 사양**:

WebView (`bridge.js`) → RN 방향으로 일정 주기 + 상태 변화 시 `bridge.heartbeat`
postMessage 발송.

```javascript
// bridge.js 안쪽
function sendHeartbeat() {
  if (!window.ReactNativeWebView) return;
  try {
    var session = /* 현재 supabase 세션 또는 null */;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'bridge.heartbeat',
      bridgeReady: true,
      hasSession: !!session,
      expiresAt: session ? session.expires_at : null,
      refreshInflight: !!window._refreshInflight,
      timestamp: Date.now()
    }));
  } catch (e) {}
}

// 트리거:
// 1) 페이지 로드 직후 1회
// 2) 30초마다 setInterval
// 3) supabase auth state 변경 시 (SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT)
// 4) _refreshInflight 진입/해제 시
```

**RN 측 동작 (앱팀 작업)**:
- `lastBridgeHeartbeatAt` 저장
- `refreshInflight` 플래그가 30초 이상 stuck이면 native fallback 발동
- heartbeat 60초 이상 안 옴 = WebView 사망 가정 → 다음 refresh부터 native fallback 우선

**왜 중요**: 영맨 commit `15f0959` 의 `_refreshInflight` 락이 stuck 되는 케이스를
RN이 감지할 유일한 방법.

### 1.6 ★ `notifyLogout` 정책 재확인 (2순위)

영맨 commit `7917f43` 에서 `notifyLogout cooldown 30초` + `logout.html?explicit=1`
가드 도입함. 잘 작동 중.

**추가 요청**: 다음 케이스에서는 **절대로 `notifyLogout` 호출 금지**:
- supabase `_refreshInflight` 타임아웃 (응답 못 받음)
- network error
- TOKEN_REFRESHED 실패 (단, refresh_token 자체 만료가 아닌 경우)
- localStorage 일시 비어있음

**오직 다음일 때만 `notifyLogout`**:
- 사용자가 명시적으로 `logout.html?explicit=1` 진입
- supabase가 `invalid_grant` 명시적으로 응답
- `SIGNED_OUT` 이벤트가 명시적 로그아웃 후 발생

### 1.7 `TOKEN_REFRESHED` 시 RN 전달 (2순위, 기존 유지)

이미 작동 중. **단**, Native Fallback Refresh가 새 토큰을 발급한 경우, RN이 WebView에
역방향으로 토큰 sync 요청을 보낼 수 있음 (앱팀이 별도 메시지 타입 제안 예정).

가칭:
```javascript
// RN → WebView (앱팀이 보냄)
{ type: 'session.syncFromNative', accessToken, refreshToken, expiresAt }

// bridge.js 측에서 받아서 처리:
// 1) supabase.auth.setSession({ accessToken, refreshToken })
// 2) localStorage 업데이트 확인
```

이 부분 사양은 앱팀이 native fallback 구현하면서 확정 후 별도 문서로 드림. 지금은
**받을 메시지 타입만 미리 추가**해 두시면 됨.

---

## 2. 정리 — 웹팀 변경 체크리스트

| # | 항목 | 우선순위 | 영향 파일 (추정) |
|---|---|---|---|
| 1 | `recording_jobs` 테이블 필드/status 8개 통일 | 1 | DB 스키마, `process-recording.php`, `job-status.php` |
| 2 | Idempotency: 24h 제한 제거, 영구 dedup | 1 | `process-recording.php`, `upload.php`, `records.php?resource=customer-log` |
| 3 | API 401 응답에 `error_code` 표준화 (6종) | 1 | 모든 API entrypoint |
| 4 | `job-status.php` 응답 필드 보강 | 1 | `job-status.php` |
| 5 | `bridge.js` heartbeat postMessage 신규 | 1 | `bridge.js` |
| 6 | `notifyLogout` 호출 조건 좁히기 | 2 | `bridge.js`, `auth-shared.js` |
| 7 | `session.syncFromNative` 메시지 수신 핸들러 | 2 | `bridge.js` (앱팀 사양 확정 후) |

---

## 3. 앱팀이 동시 진행하는 작업 (웹팀 참고용)

웹팀 변경이 헛돌지 않게, 앱팀이 같은 시기에 하는 작업도 공유:

1. **Native Outbox** — 통화녹음 발견 즉시 로컬 DB 저장. 서버 업로드 성공 전까지 절대
   삭제 안 함. 401/네트워크/앱 종료 모두 견딤.
2. **Native Refresh Fallback** — `POST https://<project>.supabase.co/auth/v1/token?grant_type=refresh_token`
   을 RN에서 직접 호출. WebView 죽어도 인증 복구 가능.
3. **Refresh Mutex** — WebView refresh + Native refresh 동시 실행 금지. 단일 lock.
4. **Headless 401 → pending_auth** — 즉시 실패 종료 금지. outbox 보존 + 재시도 큐.
5. **WorkManager 재시도** — 네트워크 복구 / 인증 복구 / 부팅 후 자동 재실행.
6. **Foreground Service** — 통화 종료 후 녹음 탐색/업로드 구간에만 한시적으로.
   24/7 아님.
7. **Bridge Heartbeat 수신** — 위 1.5 의 짝.
8. **SESSION_DEAD 발동 조건 강화** — refresh_token 자체 무효 / explicit logout /
   native fallback까지 실패한 경우에만.

---

## 4. 핵심 원칙 (양 팀 공통)

1. **WebView 생존 여부에 핵심 기능이 의존하면 안 된다.**
2. **녹음 발견 후에는 반드시 local outbox에 남긴다.**
3. **인증 실패는 작업 실패가 아니라 `pending_auth` 상태로 처리한다.**
4. **네트워크 실패는 작업 실패가 아니라 `failed_retryable` 상태로 처리한다.**
5. **사용자 재로그인 또는 native refresh 성공 후 자동 재시도한다.**
6. **upload / process / customer_log 중복 저장을 막는다.**
7. **"다시 로그인 필요"는 최후의 최후에만 띄운다.**
8. **목표는 장시간 미사용 후 첫 통화도 반드시 감지/보존/재시도되는 구조다.**

---

## 5. 의문/협의가 필요한 부분

웹팀이 작업 들어가기 전에 사장님(또는 답신)으로 확정 필요한 항목:

1. `recording_jobs.status` enum 8종 — 기존 commit `1069ef7` 의 이름과 위 1.1 이름이
   충돌하는가? 다르면 어느 쪽으로 통일?
2. Idempotency 24h 제한 풀어도 되는가? (혹시 같은 파일 의도적으로 재처리할 케이스가
   있는지)
3. `bridge.heartbeat` 메시지 타입 이름이 기존 메시지와 충돌 없는가? (예: 다른 다이
   agnostic 채널이 있다면 prefix 협의)
4. 영맨 사이트가 `bridge.js`에서 `_refreshInflight` 락을 finally 블록으로 항상
   해제하는지 확인 — timeout / network error / abort 케이스 포함.

---

## 6. 참고 자료

- 원본 비상 분석: [`URGENT_AUTH_TIMEOUT_2026-05-20.md`](URGENT_AUTH_TIMEOUT_2026-05-20.md)
- 영맨 ErrorLog 풀텍스트는 위 문서 §3 참조
- 영맨 사이트 기존 commit 참조:
  - `15f0959` — `_refreshInflight + 25s cooldown`
  - `7917f43` — `logout.html?explicit=1` + `notifyLogout 30s cooldown`
  - `e8de91d` — `SIGNED_OUT recent-refresh guard 60s`
  - `1069ef7` — `job-status.php` 도입
  - `ee2f396` — `recording_jobs.group_id`
  - `e5b9276` — STT/LLM 분기 (CLOVA/Whisper, Claude Sonnet 4.6)
  - `3417a19` / `6528d10` — Railway worker

질문 / 우선순위 조정 / 사양 확장 필요 시 사장님 통해서 앱팀에 회신 부탁드립니다.
