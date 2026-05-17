/**
 * @format
 */

import {
  getMessaging,
  onTokenRefresh,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { autoSubmitTask } from './src/features/callRecording/headless/autoSubmitTask';
import { syncLedgerGroupsToNative } from './src/features/callRecording/services/ledgerGroupsSync';
import { isLoggedIn, restoreSession } from './src/services/auth/session';
import { registerFcmTokenWithServer } from './src/services/fcm/registerFcmToken';
import { installGlobalErrorHandler } from './src/services/logger/errorLog';

setBackgroundMessageHandler(getMessaging(), async remoteMessage => {
  if (__DEV__) {
    console.log('[FCM] background message', remoteMessage);
  }
});

// Catch uncaught JS errors and persist them to disk so we can inspect later
// even if Metro / USB was not connected when the error happened.
installGlobalErrorHandler();

// Restore persisted JWT session at JS init time so headless tasks and any
// startup API calls have credentials immediately. Once the JWT is back in
// memory, sync the ledger groups so the post-call glass overlay can show the
// user's main group as the default chip without waiting for AppState changes.
void restoreSession().then(() => {
  if (isLoggedIn()) {
    void syncLedgerGroupsToNative();
  }
});

// Re-register on FCM token rotation. The handler bails when not logged in,
// so it is safe even before the session restore above completes.
try {
  onTokenRefresh(getMessaging(), () => {
    void registerFcmTokenWithServer();
  });
} catch (e) {
  if (__DEV__) {
    console.warn('[FCM] onTokenRefresh setup failed', e);
  }
}

AppRegistry.registerHeadlessTask('AutoSubmitRecording', () => autoSubmitTask);

AppRegistry.registerComponent(appName, () => App);
