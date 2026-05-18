// Tiny non-cryptographic UUIDv4 — sufficient for idempotency keys and local
// request identifiers. Don't use this for security-sensitive identifiers.
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Deterministic idempotency key for a single audio recording. The same audio
 * file URI must always produce the same key so that the server's
 * (owner_email, client_request_id) UNIQUE constraint dedups retries — catch-up
 * scans, ConfirmRecording re-entries, etc. — into a single customer_log row
 * instead of creating one per attempt.
 *
 * Format: `audio-<MediaStore numeric id>`. Falls back to a hash of the URI
 * when no trailing id is present (rare).
 */
export function deterministicRequestId(audioUri: string): string {
  const tail = audioUri.split('/').pop();
  const safe = (tail ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  if (safe.length > 0) {
    return `audio-${safe}`;
  }
  // Fallback: FNV-1a 32-bit hash of the URI.
  let hash = 0x811c9dc5;
  for (let i = 0; i < audioUri.length; i++) {
    hash ^= audioUri.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `audio-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
