// Server response types — must match cafe24 PHP backend spec.
// See docs/BACKEND_CALL_RECORDING_SPEC.md for the contract.

export interface CustomerLogRow {
  id: string;
  owner_email: string;
  customer_phone_lookup: string | null;
  customer_name: string | null;
  phone_number: string | null;
  consult_at: string;
  summary: string;
  interest: string | null;
  inquiry: string | null;
  budget_condition: string | null;
  next_action: string | null;
  agent_memo: string | null;
  audio_storage_path: string | null;
  audio_kept: boolean;
  transcript: string | null;
  ai_model: string;
  ai_generated_at: string;
  source: string;
  client_request_id: string;
  created_at: string;
  updated_at: string;
}

export interface PlanInfo {
  plan: 'free' | 'premium';
  free_summaries_used: number;
  free_quota: number;
}

export interface UploadResponse {
  status: 'ok';
  storage_path: string;
  bytes: number;
  mime: string;
}

export interface ProcessRecordingResponse {
  status: 'ok';
  customer_log: CustomerLogRow;
  plan: PlanInfo;
}

export type CustomerLogPatch = Partial<
  Pick<
    CustomerLogRow,
    | 'customer_name'
    | 'phone_number'
    | 'summary'
    | 'interest'
    | 'inquiry'
    | 'budget_condition'
    | 'next_action'
    | 'agent_memo'
  >
>;

export interface LedgerGroup {
  id: string;
  page_type: 'customer' | string;
  title: string;
  position: number;
  /** User-designated "main" group. Modal picker defaults to this one. */
  is_main?: boolean;
  created_at: string;
  updated_at: string;
}

export interface LedgerGroupsResponse {
  status: 'ok';
  groups: ReadonlyArray<LedgerGroup>;
}

export interface SendToGroupResponse {
  status: 'ok';
  group_id: string;
  group_title: string;
  ledger_record_id: string;
  created_group: boolean;
}
