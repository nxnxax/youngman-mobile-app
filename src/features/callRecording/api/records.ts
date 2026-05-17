import { apiPost } from '../../../services/api/client';
import type { CustomerLogPatch, CustomerLogRow } from './types';

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
