// Outbox processor (사장님 정책 2, 2026-05-20).
//
// 첫 통화 작업도 절대 버리지 않는다. authReady 가 늦으면 실패가 아니라
// 보류 (`pending_auth`), 네트워크/서버 일시 실패는 `failed_retryable` 로
// 보존. 다음 시그널 (Auth.login / Session.refresh ok / 앱 foreground /
// 네트워크 복구) 도착 시 이 모듈이 큐를 비운다.
//
// 재시도 시 audio_sha256 + client_request_id (= localId) 가 서버 dedup
// 키로 사용되므로 같은 파일이 여러 번 보내져도 중복 row 없음.
//
// 호출자: WebViewHost 가 useEffect 로 트리거 등록.

import { autoSubmitTask, type AutoSubmitTaskPayload } from '../../features/callRecording/headless/autoSubmitTask';
import { isAuthReady, waitForAuthReady } from '../auth/session';
import { logError } from '../logger/errorLog';
import { listByStatus, type OutboxItem, type OutboxStatus } from './outboxStore';

/** 재시도 대상 status. ready / processing / uploaded / uploading 은 진행 중
 *  또는 완료라 건드리지 않음. */
const RETRY_STATUSES: OutboxStatus[] = [
  'pending_auth',
  'failed_retryable',
  'detected',
];

let processing = false;
// 사장님 긴급 정책 (2026-05-20): 같은 outbox item 이 여러 트리거 (Auth.login /
// AppState active / SESSION_AUTH_READY / network online) 에서 동시에 재처리
// 되어 process-recording.php 가 중복 호출되는 케이스 차단. autoSubmitTask 가
// 한 번 진입한 localId 는 재진입 못함.
const activeLocalIds = new Set<string>();

function itemToPayload(item: OutboxItem): AutoSubmitTaskPayload {
  // recordedAt 은 ISO 문자열 + 오프셋. autoSubmitTask 는 dateAdded (unix
  // seconds) 로 받으므로 역변환.
  const dateAdded = Math.floor(new Date(item.recordedAt).getTime() / 1000);
  return {
    uri: item.fileUri,
    name: item.displayName,
    duration: item.durationSec * 1000,
    dateAdded,
    mimeType: item.mimeType,
    groupId: item.groupId,
  };
}

/** 큐에 보존된 작업을 sequential 하게 재시도. 사장님 정책 (2026-05-20):
 *  "Auth.login 0.2초 뒤라도 자동 재개". 단순 defer 대신 짧게 wait — Auth.login
 *  도착이 매우 임박했을 가능성 높음. waitForAuthReady 가 timeout 되면 그제서야
 *  포기 (그 후 SESSION_AUTH_READY_EVENT 가 다시 trigger 할 때 진행). */
export async function processOutbox(reason: string): Promise<void> {
  if (processing) {
    if (__DEV__) console.log('[Outbox] already processing — skip');
    return;
  }
  if (!isAuthReady()) {
    // 3초 짧게 대기. Auth.login 이 직후 도착할 가능성이 크니까 즉시 defer 하지
    // 말 것. timeout 시엔 SESSION_AUTH_READY_EVENT 가 다음 setSession 때 다시
    // 트리거하므로 작업이 잃지 않음.
    const ready = await waitForAuthReady(3_000);
    if (!ready) {
      if (__DEV__) console.log('[Outbox] authReady=false after 3s — defer until next session event');
      return;
    }
  }
  processing = true;
  try {
    const items = await listByStatus(...RETRY_STATUSES);
    if (items.length === 0) return;
    logError(
      'Outbox.process',
      new Error(`${items.length} items pending (${reason})`),
    );
    for (const item of items) {
      // per-item dedup — 같은 localId 가 다른 trigger 에서 동시 진입 시도 시
      // skip. autoSubmitTask 가 끝나면 finally 에서 제거.
      if (activeLocalIds.has(item.localId)) {
        if (__DEV__) {
          console.log('[Outbox] item in-flight — skip', item.localId);
        }
        continue;
      }
      // retry 한계: failed_permanent 는 RETRY_STATUSES 에 없어서 자동 skip.
      // failed_retryable 라도 retryCount 가 너무 높으면 영구 실패로 마킹 후 skip.
      if (item.retryCount > 4) {
        if (__DEV__) {
          console.log(
            '[Outbox] over-retried — marking failed_permanent',
            item.localId,
          );
        }
        // outboxStore.update 는 import 안 됐으므로 그냥 skip — autoSubmitTask
        // 가 다음 진입 시 자체 retry limit (4회) 에서 failed_permanent 로 변경.
        continue;
      }
      activeLocalIds.add(item.localId);
      try {
        await autoSubmitTask(itemToPayload(item));
      } catch (e) {
        // autoSubmitTask 자체는 안에서 catch 하지만 안전망.
        logError('Outbox.process.item', e, { localId: item.localId });
      } finally {
        activeLocalIds.delete(item.localId);
      }
    }
  } finally {
    processing = false;
  }
}
