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

export async function listCustomerLogs(
  opts: { limit?: number; before?: string | null } = {},
): Promise<ListResponse> {
  return apiPost<ListResponse>('/records.php?resource=customer-log', {
    action: 'customer_log_list',
    limit: opts.limit ?? 50,
    before: opts.before ?? null,
  });
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
