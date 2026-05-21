import { NativeModules, Platform } from 'react-native';

interface NativeErrorLog {
  append(tag: string, message: string): void;
  read(): Promise<string>;
  readTail(maxBytes: number): Promise<string>;
  clear(): Promise<void>;
}

const native = (NativeModules as { ErrorLog?: NativeErrorLog }).ErrorLog;

function format(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Append an error entry to the persistent on-device log. Safe to call from
 * any JS context (including headless tasks, RN UI, deep-link handlers).
 *
 * The native side also writes its own errors directly via the Kotlin
 * `ErrorLog` singleton — both ends append to the same file.
 */
export function logError(
  tag: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const parts: string[] = [format(error)];
  if (context) {
    try {
      parts.push(`context=${JSON.stringify(context)}`);
    } catch {
      // skip bad context
    }
  }
  const message = parts.join(' | ');
  if (__DEV__) {
    console.warn(`[${tag}]`, message);
  }
  if (Platform.OS === 'android' && native) {
    try {
      native.append(tag, message);
    } catch {
      // swallow — never throw from error logger
    }
  }
}

/** Read the full persistent error log (most recent appended at the bottom). */
export async function readErrorLog(): Promise<string> {
  if (Platform.OS !== 'android' || !native) {
    return '';
  }
  try {
    return await native.read();
  } catch {
    return '';
  }
}

/** Read only the tail of the log (default 500KB) — used by the in-app
 *  viewer to stay safely under the 1MB RN bridge / Android clipboard
 *  limits. Older lines are dropped, the first partial line trimmed. */
export async function readErrorLogTail(
  maxBytes: number = 500_000,
): Promise<string> {
  if (Platform.OS !== 'android' || !native) {
    return '';
  }
  try {
    return await native.readTail(maxBytes);
  } catch {
    return '';
  }
}

export async function clearErrorLog(): Promise<void> {
  if (Platform.OS !== 'android' || !native) {
    return;
  }
  try {
    await native.clear();
  } catch {
    // ignore
  }
}

/**
 * Register a JS global handler that funnels any uncaught error into the
 * persistent log. Call once on app startup.
 *
 * Uses React Native's ErrorUtils (legacy, undocumented but stable). Falls
 * back to a no-op if unavailable.
 */
export function installGlobalErrorHandler(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const utils = (global as any).ErrorUtils as
    | {
        getGlobalHandler?: () => (e: unknown, isFatal: boolean) => void;
        setGlobalHandler?: (
          handler: (e: unknown, isFatal: boolean) => void,
        ) => void;
      }
    | undefined;
  if (!utils?.setGlobalHandler) {
    return;
  }
  const previous = utils.getGlobalHandler?.();
  utils.setGlobalHandler((error, isFatal) => {
    logError(isFatal ? 'js.fatal' : 'js.uncaught', error);
    previous?.(error, isFatal);
  });
}
