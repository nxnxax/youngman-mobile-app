import { NativeModules, Platform } from 'react-native';

import { logError } from '../../../services/logger/errorLog';
import { fetchLedgerGroups } from '../api/records';
import type { LedgerGroup } from '../api/types';

interface NativeCache {
  write(json: string): Promise<void>;
  clear(): Promise<void>;
}

const native = (NativeModules as { LedgerGroupsCache?: NativeCache })
  .LedgerGroupsCache;

/**
 * Fetch the user's ledger groups from the server and push the list into the
 * native SharedPreferences cache so the post-call glass overlay can render
 * the chip selector synchronously without a JS bridge round-trip.
 *
 * Safe to call repeatedly — silently no-ops on iOS (no native bridge).
 * Failures are logged but never throw.
 */
export async function syncLedgerGroupsToNative(): Promise<
  ReadonlyArray<LedgerGroup>
> {
  if (Platform.OS !== 'android' || !native) {
    return [];
  }
  try {
    const res = await fetchLedgerGroups('customer');
    const json = JSON.stringify({ groups: res.groups });
    await native.write(json);
    if (__DEV__) {
      console.log(
        '[LedgerGroupsSync] wrote',
        res.groups.length,
        'groups to native cache',
      );
    }
    return res.groups;
  } catch (e) {
    logError('LedgerGroupsSync', e);
    return [];
  }
}

export async function clearLedgerGroupsCache(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    await native.clear();
  } catch {
    // ignore
  }
}
