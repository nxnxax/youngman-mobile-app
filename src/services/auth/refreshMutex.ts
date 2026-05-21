// Single source of truth for session-refresh concurrency state.
//
// Why this exists (2026-05-20 비상): WebView 의존 refresh가 8h idle 후
// timeout만 6연속 떨어진 ErrorLog 케이스. WebView가 살았는지/죽었는지
// 추측만 가능했음. 이 모듈은:
//   1) WebView refresh + native fallback 이 동시에 refresh_token을 소비하지
//      않게 막는 mutex
//   2) bridge.heartbeat 수신 시각을 기록해서 "WebView 살아있나" 판단 근거 제공
//   3) refresh 직후 짧은 cooldown 으로 401 burst 가 cascade refresh 폭주
//      시키는 걸 방지
//
// 모든 상태는 in-memory. AsyncStorage에 persist 하지 않는다 — 프로세스 재시작
// 시 mutex 가 자동으로 리셋되는 게 안전한 기본값.

type RefreshOwner = 'webview' | 'native';

interface MutexState {
  inflight: boolean;
  owner: RefreshOwner | null;
  startedAt: number;
  lastSuccessAt: number;
  lastError: string | null;
  /** 마지막으로 bridge.heartbeat 메시지를 받은 시각. 0 = 받은 적 없음.
   *  cold start 직후엔 0이므로 isBridgeAlive 가 false 를 반환해 native
   *  fallback 이 즉시 발동 — 의도된 동작. */
  lastBridgeHeartbeatAt: number;
  /** 마지막 heartbeat 시점에 WebView가 본인 세션이 살아있다고 신고했는지.
   *  false 면 fast path (localStorage 직독)도 의미가 없으므로 native fallback
   *  우선. */
  bridgeHasSession: boolean;
  /** WebView 자체 _refreshInflight 락 진입 여부 (heartbeat payload). 30초
   *  이상 stuck이면 bridge가 사실상 죽은 것으로 간주하는 기준 신호. */
  bridgeRefreshInflight: boolean;
  bridgeRefreshInflightSince: number;
}

const state: MutexState = {
  inflight: false,
  owner: null,
  startedAt: 0,
  lastSuccessAt: 0,
  lastError: null,
  lastBridgeHeartbeatAt: 0,
  bridgeHasSession: false,
  bridgeRefreshInflight: false,
  bridgeRefreshInflightSince: 0,
};

/** Threshold: heartbeat 가 이 시간 이상 안 오면 WebView 사망 가정. */
const BRIDGE_DEAD_AFTER_MS = 90_000;

/** WebView 자체 refresh 락이 이 시간 이상 stuck이면 죽은 것으로 간주. */
const BRIDGE_REFRESH_STUCK_AFTER_MS = 30_000;

/** refresh 성공 직후 같은 owner 가 재진입 못하게 막는 cooldown. 동시 N건의
 *  401 burst (auth-profile + customer-log + ledger-groups + upload 가 거의
 *  같은 ms에 떨어지는 사장님 케이스)가 각자 refresh를 또 트리거하는 cascade
 *  방지. */
const POST_SUCCESS_COOLDOWN_MS = 5_000;

export function tryAcquire(owner: RefreshOwner): boolean {
  if (state.inflight) return false;
  state.inflight = true;
  state.owner = owner;
  state.startedAt = Date.now();
  return true;
}

export function release(result: 'success' | 'failure', error?: string): void {
  if (!state.inflight) return;
  state.inflight = false;
  state.owner = null;
  state.startedAt = 0;
  if (result === 'success') {
    state.lastSuccessAt = Date.now();
    state.lastError = null;
  } else {
    state.lastError = error ?? 'unknown';
  }
}

export function isInflight(): boolean {
  return state.inflight;
}

export function currentOwner(): RefreshOwner | null {
  return state.owner;
}

export function inPostSuccessCooldown(): boolean {
  if (state.lastSuccessAt === 0) return false;
  return Date.now() - state.lastSuccessAt < POST_SUCCESS_COOLDOWN_MS;
}

export interface BridgeHeartbeatPayload {
  bridgeReady: boolean;
  hasSession: boolean;
  expiresAt: number | null;
  refreshInflight: boolean;
  timestamp: number;
}

export function noteBridgeHeartbeat(payload: BridgeHeartbeatPayload): void {
  state.lastBridgeHeartbeatAt = Date.now();
  state.bridgeHasSession = !!payload.hasSession;
  // edge-trigger: track when the WebView's internal _refreshInflight first
  // turned on, so we can detect stuck-lock cases (webview reports inflight
  // for >30s = its own refresh hung, native fallback should take over).
  if (payload.refreshInflight && !state.bridgeRefreshInflight) {
    state.bridgeRefreshInflightSince = Date.now();
  } else if (!payload.refreshInflight) {
    state.bridgeRefreshInflightSince = 0;
  }
  state.bridgeRefreshInflight = !!payload.refreshInflight;
}

/** WebView 가 살아 있고 refresh 를 맡길 만한 상태인지 판정. */
export function isBridgeAlive(): boolean {
  // heartbeat 한 번도 못 받았으면 사망 가정 (cold start 직후 native trigger 케이스).
  if (state.lastBridgeHeartbeatAt === 0) return false;
  const sinceHeartbeat = Date.now() - state.lastBridgeHeartbeatAt;
  if (sinceHeartbeat > BRIDGE_DEAD_AFTER_MS) return false;
  // bridge가 자기 refresh 락에 갇혀 있으면 또 부탁해도 답을 못 함.
  if (state.bridgeRefreshInflight && state.bridgeRefreshInflightSince > 0) {
    const stuckFor = Date.now() - state.bridgeRefreshInflightSince;
    if (stuckFor > BRIDGE_REFRESH_STUCK_AFTER_MS) return false;
  }
  return true;
}

/** Snapshot for logging. Avoid mutating state externally. */
export function snapshot(): Readonly<MutexState> & {
  bridgeAlive: boolean;
  postSuccessCooldown: boolean;
} {
  return {
    ...state,
    bridgeAlive: isBridgeAlive(),
    postSuccessCooldown: inPostSuccessCooldown(),
  };
}

/** Reset everything. Used on explicit logout to clear lingering lock state
 *  so a fresh login session starts clean. */
export function reset(): void {
  state.inflight = false;
  state.owner = null;
  state.startedAt = 0;
  state.lastSuccessAt = 0;
  state.lastError = null;
  state.lastBridgeHeartbeatAt = 0;
  state.bridgeHasSession = false;
  state.bridgeRefreshInflight = false;
  state.bridgeRefreshInflightSince = 0;
}
