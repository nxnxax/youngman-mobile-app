// Background-time tracker for session-health gating.
//
// 사장님 정책 (2026-05-22 "찰거머리" 슬로건):
//   "365일 만에 접속해도 영맨은 사용자한테 딱붙어서 AI 정보를 흐트러짐 없이
//    보여줘야 한다."
//
// 7+ 시간 백그라운드 → WebView/RN 양쪽 refresh_token 휘발 사례 (사장님
// 2026-05-22 비상) 의 첫 도미노 = "오래 idle 후 자동 복구 trigger 가 없음".
// 이 모듈은 그 도미노를 차단한다:
//   1. AppState change 를 listen 해서 background 진입/이탈 시점 기록
//   2. foreground 복귀 시 idle 시간 산출 → 임계치 (기본 6시간) 초과면 게이트
//      true → caller (WebViewHost) 가 silent re-auth + WebView reload 발동
//   3. consume 패턴 — 한 번 처리되면 reset. 같은 idle 로 여러 번 재발동 X.
//
// AppState listener 는 모듈 import 시 자동 install (init() 명시 호출 불필요)
// — singleton. App.tsx 가 이 모듈을 한 번 import 만 하면 됨.

import { AppState, type AppStateStatus } from 'react-native';

const LONG_IDLE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6시간

let backgroundedAt = 0;
let pendingIdleMs = 0;
let currentStatus: AppStateStatus = AppState.currentState;

function onChange(next: AppStateStatus): void {
  const prev = currentStatus;
  currentStatus = next;
  if (next === 'background' || next === 'inactive') {
    if (prev === 'active') {
      backgroundedAt = Date.now();
    }
    return;
  }
  if (next === 'active') {
    if (backgroundedAt > 0) {
      const elapsed = Date.now() - backgroundedAt;
      // foreground 복귀 시점에 elapsed 누적. consumeIdleSinceBackground 가
      // 읽어가지 않은 잔여분은 다음 idle 과 합산해서 보존하지 않음 — 매번
      // 가장 최근 idle 만 의미가 있다.
      pendingIdleMs = elapsed;
      backgroundedAt = 0;
    }
  }
}

AppState.addEventListener('change', onChange);

/** 마지막 background→active 전환 시점의 idle 시간 (ms). foreground 직후
 *  한 번만 의미 있는 값이라 호출 후 reset. caller 가 0 으로 받으면 "최근
 *  idle 없음" 으로 해석. */
export function consumeIdleSinceBackground(): number {
  const ms = pendingIdleMs;
  pendingIdleMs = 0;
  return ms;
}

/** 위 consume 의 boolean wrapper. 기본 임계치 6시간. */
export function consumeLongIdle(thresholdMs: number = LONG_IDLE_THRESHOLD_MS): boolean {
  const ms = consumeIdleSinceBackground();
  return ms >= thresholdMs;
}

/** 진단/로깅용. consume 하지 않고 현재 상태만 들여다본다. */
export function peekIdleSinceBackground(): number {
  if (backgroundedAt > 0) {
    return Date.now() - backgroundedAt;
  }
  return pendingIdleMs;
}
