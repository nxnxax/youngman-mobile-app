import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

import {
  type FoundCallRecording,
  type MediaStoreAudio,
  filterAndClassify,
} from './heuristics';

interface NativeRecordingScanner {
  scanAudio(): Promise<MediaStoreAudio[]>;
  simulateCallEnd(): Promise<void>;
}

export async function simulateCallEnd(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  await native.simulateCallEnd();
}

const native = (
  NativeModules as { RecordingScanner?: NativeRecordingScanner }
).RecordingScanner;

function pickAudioPermission(): string {
  // Android 13+ uses scoped media permissions. Below that, legacy storage permission.
  if (Platform.Version >= 33) {
    return PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO;
  }
  return PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
}

export async function ensureAudioPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  const permission = pickAudioPermission();
  const already = await PermissionsAndroid.check(permission);
  if (already) {
    return true;
  }
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export interface ScanResult {
  status: 'ok' | 'no-permission' | 'unavailable' | 'error';
  recordings: ReadonlyArray<FoundCallRecording>;
  totalFound: number;
  error?: string;
}

export interface ScanOptions {
  /** Maximum number of recordings to return (most recent first). */
  limit?: number;
  /** Only include files newer than this many days. */
  maxAgeDays?: number;
}

export async function scanForCallRecordings(
  options: ScanOptions = {},
): Promise<ScanResult> {
  if (Platform.OS !== 'android' || !native) {
    return { status: 'unavailable', recordings: [], totalFound: 0 };
  }
  const permitted = await ensureAudioPermission();
  if (!permitted) {
    return { status: 'no-permission', recordings: [], totalFound: 0 };
  }
  try {
    const all = await native.scanAudio();
    let recordings = filterAndClassify(all);
    const totalFound = recordings.length;

    if (options.maxAgeDays != null) {
      const cutoff = Math.floor(Date.now() / 1000) - options.maxAgeDays * 86_400;
      recordings = recordings.filter(r => r.dateAdded >= cutoff);
    }
    if (options.limit != null) {
      recordings = recordings.slice(0, options.limit);
    }

    return { status: 'ok', recordings, totalFound };
  } catch (e) {
    return {
      status: 'error',
      recordings: [],
      totalFound: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type { FoundCallRecording, MediaStoreAudio };
