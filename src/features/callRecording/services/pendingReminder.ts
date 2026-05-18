import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@youngman/pending-reminder-last-shown';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Returns true if at least 24h has passed since the last reminder was shown
 *  (or it has never been shown). Used to throttle the daily catch-up modal. */
export async function shouldShowPendingReminder(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return true;
    }
    const lastShown = Number(raw);
    if (Number.isNaN(lastShown)) {
      return true;
    }
    return Date.now() - lastShown >= ONE_DAY_MS;
  } catch {
    return true;
  }
}

/** Stamp the last-shown timestamp. Called when the modal opens (regardless of
 *  the user's eventual choice) so we don't keep popping it on every foreground. */
export async function markPendingReminderShown(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // ignore — worst case the modal pops again tomorrow
  }
}
