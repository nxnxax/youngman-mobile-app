import { apiGet, apiPost } from '../../../services/api/client';
import type {
  CustomerLogPatch,
  CustomerLogRow,
  LedgerGroup,
  LedgerGroupsResponse,
  SendToGroupResponse,
} from './types';

interface OkRow {
  status: 'ok';
  customer_log: CustomerLogRow;
}

interface ListResponse {
  items: ReadonlyArray<CustomerLogRow>;
  next_before: string | null;
}

export async function updateCustomerLog(
  id: string,
  patch: CustomerLogPatch,
): Promise<OkRow> {
  return apiPost<OkRow>('/records.php?resource=customer-log', {
    action: 'customer_log_update',
    id,
    patch,
  });
}

export async function deleteCustomerLog(
  id: string,
): Promise<{ status: 'ok' }> {
  return apiPost('/records.php?resource=customer-log', {
    action: 'customer_log_delete',
    id,
  });
}

/** 사장님 정책 (2026-05-22 웹팀 commit 671177e): 통화 취소 / 요약 폐기 시 server
 *  cascade 삭제 (customer_log + recording_jobs + ledger_records mirror + audio
 *  파일). 잔해 데이터 누적 방지. callback 은 UPDATE only 라 Railway worker 가
 *  처리 중이라도 안전 (silent 무시). */
interface CancelResponse {
  status: 'ok';
  deleted: {
    customer_log: number;
    recording_jobs: number;
    ledger_records: number;
    audio_files: number;
  };
}
export async function cancelCustomerLog(id: string): Promise<CancelResponse> {
  return apiPost<CancelResponse>('/records.php?resource=customer-log', {
    action: 'customer_log_cancel',
    id,
  });
}

export async function listCustomerLogs(
  opts: { limit?: number; before?: string | null } = {},
): Promise<ListResponse> {
  return apiPost<ListResponse>('/records.php?resource=customer-log', {
    action: 'customer_log_list',
    limit: opts.limit ?? 50,
    before: opts.before ?? null,
  });
}

/**
 * Fetch customer_logs that have NOT yet been pushed to a ledger group
 * (`linked_ledger_record_id` is explicitly `null`). Used by the daily catch-up
 * reminder. We use STRICT equality on purpose — if the server omits the field
 * we treat the row as "unknown" rather than "pending" and skip it, so the
 * modal never lists already-processed rows just because the API response was
 * silent about that column.
 */
export async function listPendingCustomerLogs(
  limit = 100,
): Promise<ReadonlyArray<CustomerLogRow>> {
  const res = await listCustomerLogs({ limit });
  if (__DEV__) {
    const breakdown = res.items.map(r => ({
      id: r.id.slice(0, 8),
      name: r.customer_name,
      consult: r.consult_at,
      link: r.linked_ledger_record_id,
      crid: r.client_request_id,
    }));
    console.log(
      '[PendingDiag] total=',
      res.items.length,
      'rows=',
      JSON.stringify(breakdown),
    );
  }
  return res.items.filter(row => row.linked_ledger_record_id === null);
}

export async function getCustomerLog(
  id: string,
): Promise<{ customer_log: CustomerLogRow }> {
  return apiPost('/records.php?resource=customer-log', {
    action: 'customer_log_get',
    id,
  });
}

/**
 * Send a customer_log to a ledger group. If group_id is null, the server
 * creates (or reuses) a default group titled '그룹제목을 설정해주세요'.
 * Server schema: customer_log_send_to_group action (web team commit 7b06d97).
 */
export async function sendCustomerLogToGroup(opts: {
  id: string;
  group_id: string | null;
  override?: CustomerLogPatch;
}): Promise<SendToGroupResponse> {
  return apiPost<SendToGroupResponse>('/records.php?resource=customer-log', {
    action: 'customer_log_send_to_group',
    id: opts.id,
    group_id: opts.group_id,
    override: opts.override ?? null,
  });
}

interface RawLedgerGroup {
  id?: number | string;
  pageType?: string;
  page_type?: string;
  name?: string;
  title?: string;
  sortOrder?: number;
  position?: number;
  is_main?: boolean;
  isDefault?: boolean;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

interface RawLedgerGroupsResponse {
  ok?: boolean;
  status?: string;
  items?: ReadonlyArray<RawLedgerGroup>;
  groups?: ReadonlyArray<RawLedgerGroup>;
}

/**
 * Normalizes the server's records.php ledger-groups response (which uses
 * camelCase keys + `items`/`name`/`sortOrder`/numeric `id`) into our internal
 * LedgerGroup shape (string id, `title`, `position`). Server-side rename is
 * the right long-term fix, but adapter-here is the lowest-friction option.
 */
export async function fetchLedgerGroups(
  pageType: 'customer' = 'customer',
): Promise<LedgerGroupsResponse> {
  const raw = await apiGet<RawLedgerGroupsResponse>(
    `/records.php?resource=ledger-groups&page_type=${pageType}`,
  );
  const items = raw.items ?? raw.groups ?? [];
  const groups = items.map<LedgerGroup>((r, idx) => ({
    id: String(r.id ?? ''),
    page_type: r.pageType ?? r.page_type ?? pageType,
    title: r.name ?? r.title ?? '',
    position: r.sortOrder ?? r.position ?? idx,
    is_main: r.is_main === true,
    created_at: r.createdAt ?? r.created_at ?? '',
    updated_at: r.updatedAt ?? r.updated_at ?? '',
  }));
  return { status: 'ok', groups };
}
