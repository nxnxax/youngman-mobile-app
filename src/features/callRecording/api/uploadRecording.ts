import { apiPostMultipart } from '../../../services/api/client';
import type { UploadResponse } from './types';

export interface UploadRecordingInput {
  /** content:// URI from MediaStore */
  contentUri: string;
  displayName: string;
  /** ISO8601 — used for storage path date partitioning */
  recordedAt: string;
  mimeType: string;
}

// RN's FormData accepts {uri, name, type} for file fields — this is the
// undocumented-but-stable RN API. We cast through `unknown` to silence the
// strict FormData type.
interface RNFile {
  uri: string;
  name: string;
  type: string;
}

export async function uploadRecording(
  input: UploadRecordingInput,
): Promise<UploadResponse> {
  const form = new FormData();
  const filePart: RNFile = {
    uri: input.contentUri,
    name: input.displayName,
    type: input.mimeType,
  };
  form.append('file', filePart as unknown as Blob);
  form.append('kind', 'recording');
  form.append('recorded_at', input.recordedAt);
  form.append('original_filename', input.displayName);

  return apiPostMultipart<UploadResponse>('/upload.php', form);
}
