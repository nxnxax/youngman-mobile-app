import {
  RECORDING_AUDIO_EXTS,
  RECORDING_NAME_PATTERNS,
  RECORDING_PATH_PATTERNS,
} from './patterns';

export interface MediaStoreAudio {
  id: string;
  uri: string;
  displayName: string;
  relativePath: string; // empty string on pre-Q (we don't get this column)
  dateAdded: number; // unix seconds
  duration: number; // milliseconds
  mimeType: string;
  size: number; // bytes
}

export interface ClassificationResult {
  isCallRecording: boolean;
  confidence: 'high' | 'medium' | 'low';
  source: string | null;
  reason: string;
}

const MIN_DURATION_MS = 10_000;
const MAX_DURATION_MS = 2 * 60 * 60_000;

function hasAudioExt(name: string): boolean {
  const lower = name.toLowerCase();
  return RECORDING_AUDIO_EXTS.some(ext => lower.endsWith(ext));
}

export function classifyAudio(file: MediaStoreAudio): ClassificationResult {
  if (!hasAudioExt(file.displayName)) {
    return { isCallRecording: false, confidence: 'high', source: null, reason: 'non-audio extension' };
  }
  if (file.duration < MIN_DURATION_MS) {
    return { isCallRecording: false, confidence: 'high', source: null, reason: 'too short' };
  }
  if (file.duration > MAX_DURATION_MS) {
    return { isCallRecording: false, confidence: 'medium', source: null, reason: 'too long' };
  }

  const pathMatch = RECORDING_PATH_PATTERNS.find(p => p.pattern.test(file.relativePath));
  if (pathMatch) {
    return {
      isCallRecording: true,
      confidence: 'high',
      source: pathMatch.source,
      reason: 'known recording folder',
    };
  }

  const nameMatch = RECORDING_NAME_PATTERNS.find(p => p.pattern.test(file.displayName));
  if (nameMatch) {
    return {
      isCallRecording: true,
      confidence: 'medium',
      source: nameMatch.source,
      reason: 'filename pattern',
    };
  }

  return { isCallRecording: false, confidence: 'low', source: null, reason: 'no pattern match' };
}

export interface FoundCallRecording extends MediaStoreAudio {
  classification: ClassificationResult;
}

export function filterAndClassify(
  files: ReadonlyArray<MediaStoreAudio>,
): ReadonlyArray<FoundCallRecording> {
  const out: FoundCallRecording[] = [];
  for (const file of files) {
    const c = classifyAudio(file);
    if (c.isCallRecording) {
      out.push({ ...file, classification: c });
    }
  }
  out.sort((a, b) => b.dateAdded - a.dateAdded);
  return out;
}

// Best-effort phone number extraction from a filename. Returns formatted
// "010-1234-5678" or null. Conservative — only matches when the digits look
// like a Korean phone number so we don't falsely "match" timestamp strings
// like 20241225-103022.m4a.
//
// Patterns are tried in order from most specific to least, so a contiguous
// 11-digit string starting with 01X parses as a mobile number (3-4-4) rather
// than greedily consuming the first 4 digits.
const PHONE_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean mobile: 010 / 011 / 016 / 017 / 018 / 019
  /(?<![\d])(01[016789])[- _]?(\d{3,4})[- _]?(\d{4})(?![\d])/,
  // Seoul landline: 02
  /(?<![\d])(02)[- _]?(\d{3,4})[- _]?(\d{4})(?![\d])/,
  // Other landlines: 0XX (031, 032, 042, 051, 053, 062, 063, ...)
  /(?<![\d])(0\d{2})[- _]?(\d{3,4})[- _]?(\d{4})(?![\d])/,
];

export function extractPhoneNumber(name: string): string | null {
  for (const re of PHONE_PATTERNS) {
    const m = name.match(re);
    if (m) {
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return null;
}
