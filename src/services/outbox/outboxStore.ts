// Durable outbox for in-flight call-recording jobs.
//
// 2026-05-20 비상 원칙: 통화녹음 발견 후에는 반드시 local outbox 에 먼저
// 저장한다. 서버 업로드 성공 전까지 절대 삭제하지 않는다. 401 / 네트워크 /
// 앱 종료 / WebView 죽음 어떤 상황에서도 작업이 보존되어야 함.
//
// Persistence: AsyncStorage 단일 키 + JSON. 항목 수가 1000건 단위로 늘기
// 전까진 충분히 빠름 — Phase 2 에서 SQLite 로 마이그레이션 가능 (key/value
// 모양만 유지하면 호환).
//
// 동시성: outboxStore 의 모든 변경은 mutateLocked() 로 serialize 한다.
// AsyncStorage 자체가 read-modify-write 단위로 atomicity 를 제공하지 않으므로
// (headless task + foreground app + workmanager retry 가 같은 키에 접근),
// in-memory promise chain 으로 직렬화.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { logError } from '../logger/errorLog';

const STORAGE_KEY = '@youngman/outbox_v1';

/** outbox 항목 상태 머신.
 *
 *  사장님 정책 (2026-05-20 late): 모든 이벤트 → 명확한 transition. 같은
 *  작업이 여러 경로로 트리거되는 race 차단.
 *
 *  Lifecycle (정상 진행 순서):
 *    detected
 *      → modal_shown            (native OverlayService 표시 직후)
 *      → user_selected_summary  (사용자가 요약보기)
 *      → user_selected_submit   (사용자가 전송 또는 자동 전송 카운트다운 후)
 *      → [pending_auth]         (authReady 못 충족 시. Auth.login 후 자동 resume)
 *      → uploading
 *      → uploaded
 *      → processing             (process-recording.php 호출 후 server job 진행)
 *      → ready_to_review        (서버 처리 완료, customer_log 저장 대기)
 *      → saved                  (customer_log 저장 완료, 작업 종료)
 *
 *  Off-path:
 *    → dismissed         (사용자가 모달에서 취소 또는 auto-dismiss)
 *    → failed_retryable  (일시 실패, 자동 재시도 대상)
 *    → failed_permanent  (영구 실패, 자동 재시도 X)
 */
export type OutboxStatus =
  /** 녹음 파일 감지 직후, 아무 외부 요청도 안 한 상태. */
  | 'detected'
  /** native OverlayService 가 모달 표시함. 사용자 액션 대기 중. 같은 작업에
   *  대해 모달 다시 표시 금지 (사장님 정책). */
  | 'modal_shown'
  /** 사용자가 요약보기 선택. */
  | 'user_selected_summary'
  /** 사용자가 전송 선택 (수동 또는 자동 카운트다운). */
  | 'user_selected_submit'
  /** 401 만나서 인증 복구 대기 중. Auth.login / native refresh 성공 시
   *  outboxProcessor 가 자동 재개. */
  | 'pending_auth'
  /** upload.php 호출 진행. */
  | 'uploading'
  /** 업로드 완료, process-recording.php job 생성 전. */
  | 'uploaded'
  /** process-recording.php 호출 후 job_id 발급됨. 서버 처리 진행 중.
   *  FCM call_summary_ready / job-status.php 폴링이 결과 알림. */
  | 'processing'
  /** 서버 처리 완료, customer_log 저장 대기. */
  | 'ready_to_review'
  /** 사용자가 모달에서 취소 또는 auto-dismiss. 자동 재표시 금지. */
  | 'dismissed'
  /** customer_log 저장 완료. 작업 종료. */
  | 'saved'
  /** 일시 실패 (5xx / 네트워크). cron / WorkManager / 다음 foreground 에서
   *  재시도. */
  | 'failed_retryable'
  /** 영구 실패. 사용자가 수동 처리하지 않는 한 더 시도 하지 않음. */
  | 'failed_permanent'
  /** Deprecated alias for ready_to_review (기존 코드 호환). */
  | 'ready';

export interface OutboxItem {
  /** 앱 측 식별자. uri 기반 deterministic 으로 만들어 같은 파일이 두 번
   *  들어와도 같은 localId 가 나오게 — Outbox 자체의 dedup. */
  localId: string;
  fileUri: string;
  displayName: string;
  durationSec: number;
  mimeType: string;
  /** Heuristics 로 추출한 전화번호. 없을 수 있음. */
  phoneNumber: string | null;
  /** 주소록에서 매칭된 이름. 없을 수 있음. */
  contactName: string | null;
  /** Outbox 에 처음 들어온 시각 (ms epoch). */
  detectedAt: number;
  /** 업로드 후 서버가 매핑하는 deterministic 키. uploadRecording 전엔 null. */
  audioSha256: string | null;
  status: OutboxStatus;
  /** 재시도 횟수. exponential backoff 의 기준. */
  retryCount: number;
  /** 마지막 시도 에러. 사용자 노출 X, 디버깅용. */
  lastError: string | null;
  /** 서버가 발급한 recording_jobs.id. uploaded 단계 이후로만 채워짐. */
  serverJobId: string | null;
  /** 통화 후 모달에서 선택한 ledger group. */
  groupId: string | null;
  /** ISO8601 local + offset. process-recording.php 가 그대로 사용. */
  recordedAt: string;
  /** 마지막 상태 변경 시각. */
  updatedAt: number;
}

interface OutboxFile {
  version: 1;
  items: OutboxItem[];
}

// === Serialization queue ====================================================

let mutationChain: Promise<unknown> = Promise.resolve();

/** Serialize all mutations through one promise chain so headless task +
 *  foreground app + WorkManager retry can't clobber each other on AsyncStorage
 *  read-modify-write. */
function mutateLocked<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  // chain은 항상 resolved 로 이어지게 — 한 mutation 의 실패가 다음 mutation 을
  // 막아선 안 됨.
  mutationChain = next.catch(() => undefined);
  return next;
}

// === Persistence ===========================================================

async function readFile(): Promise<OutboxFile> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, items: [] };
    const parsed = JSON.parse(raw) as OutboxFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch (e) {
    logError('Outbox.read', e);
  }
  return { version: 1, items: [] };
}

async function writeFile(file: OutboxFile): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch (e) {
    logError('Outbox.write', e);
    throw e;
  }
}

// === Public API =============================================================

/** Insert a new item (or no-op if localId already present). Returns the
 *  resulting item (existing or newly inserted). Idempotent — calling this
 *  twice with the same localId returns the original row, status untouched. */
export async function putIfAbsent(
  item: Omit<OutboxItem, 'updatedAt'>,
): Promise<OutboxItem> {
  return mutateLocked(async () => {
    const file = await readFile();
    const existing = file.items.find(i => i.localId === item.localId);
    if (existing) return existing;
    const inserted: OutboxItem = { ...item, updatedAt: Date.now() };
    file.items.push(inserted);
    await writeFile(file);
    return inserted;
  });
}

export async function update(
  localId: string,
  patch: Partial<Omit<OutboxItem, 'localId' | 'detectedAt'>>,
): Promise<OutboxItem | null> {
  return mutateLocked(async () => {
    const file = await readFile();
    const idx = file.items.findIndex(i => i.localId === localId);
    if (idx < 0) return null;
    const merged: OutboxItem = {
      ...file.items[idx],
      ...patch,
      localId: file.items[idx].localId,
      detectedAt: file.items[idx].detectedAt,
      updatedAt: Date.now(),
    };
    file.items[idx] = merged;
    await writeFile(file);
    return merged;
  });
}

export async function remove(localId: string): Promise<void> {
  await mutateLocked(async () => {
    const file = await readFile();
    const next = file.items.filter(i => i.localId !== localId);
    if (next.length !== file.items.length) {
      await writeFile({ ...file, items: next });
    }
  });
}

export async function list(): Promise<OutboxItem[]> {
  const file = await readFile();
  return file.items;
}

export async function listByStatus(
  ...statuses: OutboxStatus[]
): Promise<OutboxItem[]> {
  const items = await list();
  return items.filter(i => statuses.includes(i.status));
}

export async function getById(localId: string): Promise<OutboxItem | null> {
  const items = await list();
  return items.find(i => i.localId === localId) ?? null;
}

/** Mark every pending_auth row as detected so the outbox processor (or next
 *  foreground retry) picks them up. Called after a successful refresh —
 *  whether WebView or native — so the backlog drains immediately instead of
 *  waiting for natural retry cadence. */
export async function rearmPendingAuth(): Promise<number> {
  return mutateLocked(async () => {
    const file = await readFile();
    let count = 0;
    for (const item of file.items) {
      if (item.status === 'pending_auth') {
        item.status = 'detected';
        item.updatedAt = Date.now();
        count += 1;
      }
    }
    if (count > 0) await writeFile(file);
    return count;
  });
}

/** Play Store 안정화 (2026-05-21 audit): outbox 가 무한 누적 방지. 종료 상태
 *  (saved / failed_permanent / dismissed) 의 항목 중 updatedAt 가 일정 시간
 *  이상 옛이면 자동 삭제. 사용자 데이터 손실 X — 모두 종료된 작업.
 *
 *  - saved: customer_log 에 이미 저장 완료
 *  - failed_permanent: 자동 재시도 안 함, 사용자 무시한 작업
 *  - dismissed: 사용자가 모달에서 cancel
 *
 *  WebViewHost mount 시 한 번 호출 권장 (cold start 안 막음 — fire-and-forget). */
const TERMINAL_STATUSES: OutboxStatus[] = [
  'saved',
  'failed_permanent',
  'dismissed',
];
const TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

export async function cleanupTerminalItems(): Promise<number> {
  return mutateLocked(async () => {
    const file = await readFile();
    const cutoff = Date.now() - TERMINAL_TTL_MS;
    const before = file.items.length;
    const next = file.items.filter(
      i => !(TERMINAL_STATUSES.includes(i.status) && i.updatedAt < cutoff),
    );
    const removed = before - next.length;
    if (removed > 0) {
      await writeFile({ ...file, items: next });
    }
    return removed;
  });
}
