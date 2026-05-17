/**
 * @format
 */

import {
  getMessaging,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

setBackgroundMessageHandler(getMessaging(), async remoteMessage => {
  if (__DEV__) {
    console.log('[FCM] background message', remoteMessage);
  }
});

AppRegistry.registerComponent(appName, () => App);
