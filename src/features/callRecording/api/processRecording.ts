import { apiPost } from '../../../services/api/client';
import type { ProcessRecordingResponse } from './types';

export interface ProcessRecordingInput {
  storage_path: string;
  duration_sec: number;
  original_filename: string;
  recorded_at: string;
  phone_number: string | null;
  client_request_id: string;
}

export async function processRecording(
  input: ProcessRecordingInput,
): Promise<ProcessRecordingResponse> {
  return apiPost<ProcessRecordingResponse>('/process-recording.php', input);
}
