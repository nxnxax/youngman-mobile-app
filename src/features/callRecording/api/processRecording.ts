import { apiPost } from '../../../services/api/client';
import type { ProcessRecordingResponse } from './types';

export interface ProcessRecordingInput {
  storage_path: string;
  duration_sec: number;
  original_filename: string;
  recorded_at: string;
  phone_number: string | null;
  client_request_id: string;
  /** Optional: app-resolved contact name from phone book lookup. Server uses
   *  this as ground truth and overrides LLM customer_name extraction. */
  customer_name_hint?: string | null;
}

export async function processRecording(
  input: ProcessRecordingInput,
): Promise<ProcessRecordingResponse> {
  return apiPost<ProcessRecordingResponse>('/process-recording.php', input);
}
