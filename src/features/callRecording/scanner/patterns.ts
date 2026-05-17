// Patterns used to detect call recording files in MediaStore.Audio.
// Path patterns match the directory the file lives in (relative_path on Q+).
// Name patterns match common recorder-generated filenames as a fallback when
// the path is generic (e.g. user moved a file into /Music/).
//
// Each pattern carries a `source` tag so we can ship anonymized telemetry
// showing which patterns hit in the wild — this is how the list evolves.

export type RecorderFamily =
  | 'samsung'
  | 'xiaomi'
  | 'oppo'
  | 'vivo'
  | 'acr'
  | 'cube'
  | 'callapp'
  | 't-phone'
  | 'other';

export interface PathPattern {
  readonly pattern: RegExp;
  readonly source: string;
  readonly family: RecorderFamily;
}

export const RECORDING_PATH_PATTERNS: ReadonlyArray<PathPattern> = [
  { pattern: /(^|\/)Recordings\/Call(\/|$)/i, source: 'samsung-default', family: 'samsung' },
  { pattern: /(^|\/)Recordings\/Call Recordings(\/|$)/i, source: 'oppo-default', family: 'oppo' },
  { pattern: /(^|\/)MIUI\/sound_recorder\/call_rec(\/|$)/i, source: 'miui', family: 'xiaomi' },
  { pattern: /(^|\/)recordings\/MIUI(\/|$)/i, source: 'hyperos', family: 'xiaomi' },
  { pattern: /(^|\/)Record\/Call(\/|$)/i, source: 'vivo', family: 'vivo' },
  { pattern: /(^|\/)PhoneRecord(\/|$)/i, source: 'oem-generic', family: 'other' },
  { pattern: /(^|\/)CallRecordings(\/|$)/i, source: 'acr-new', family: 'acr' },
  { pattern: /(^|\/)ACR(\/|$)/i, source: 'acr-legacy', family: 'acr' },
  { pattern: /(^|\/)CubeCallRecorder\/All(\/|$)/i, source: 'cube-acr', family: 'cube' },
  { pattern: /(^|\/)CallApp(\/|$)/i, source: 'callapp', family: 'callapp' },
  { pattern: /(^|\/)Recordings\/TPhoneCallRecords(\/|$)/i, source: 't-phone-skt', family: 't-phone' },
  { pattern: /(^|\/)TCallRecord(\/|$)/i, source: 't-phone-legacy', family: 't-phone' },
  { pattern: /(^|\/)Documents\/CallRecordings(\/|$)/i, source: 'acr-saf', family: 'acr' },
];

export interface NamePattern {
  readonly pattern: RegExp;
  readonly source: string;
}

export const RECORDING_NAME_PATTERNS: ReadonlyArray<NamePattern> = [
  { pattern: /^통화\s*녹음.*\.(m4a|amr|3gp|mp3|opus|wav|aac)$/i, source: 'samsung-ko' },
  { pattern: /^Call_.*\.(m4a|amr|opus|mp3|aac)$/i, source: 'generic-en' },
  { pattern: /^Recording_.*\.(m4a|amr|opus|wav)$/i, source: 'generic-rec' },
  { pattern: /^REC\d+\.(m4a|amr|wav)$/i, source: 'oem-rec' },
  { pattern: /^\d{2,4}[- _]?\d{3,4}[- _]?\d{4}.*\.(m4a|amr|mp3|opus|aac)$/i, source: 'phone-prefix' },
];

export const RECORDING_AUDIO_EXTS: ReadonlyArray<string> = [
  '.m4a', '.amr', '.3gp', '.opus', '.mp3', '.wav', '.aac',
];
