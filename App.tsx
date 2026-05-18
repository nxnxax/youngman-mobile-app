import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useEffect } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ConfirmRecordingScreen } from './src/features/callRecording/screens/ConfirmRecordingScreen';
import { OnboardingDemoScreen } from './src/features/callRecording/screens/OnboardingDemoScreen';
import { SummaryReviewScreen } from './src/features/callRecording/screens/SummaryReviewScreen';
import { SettingsScreen } from './src/features/settings/SettingsScreen';
import {
  attachIncomingCallListener,
  detachIncomingCallListener,
} from './src/features/callRecording/services/incomingCallHandler';
import type { RootStackParamList } from './src/navigation/types';
import { WebViewHost } from './src/features/webview/WebViewHost';

const Stack = createNativeStackNavigator<RootStackParamList>();

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';

  // Subscribe to incoming-call events from the native CallScreeningService.
  // Idempotent inside the helper — safe across React StrictMode double-renders.
  useEffect(() => {
    attachIncomingCallListener();
    return () => detachIncomingCallListener();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor="#FFFFFF"
      />
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="WebView" component={WebViewHost} />
          <Stack.Screen
            name="OnboardingDemo"
            component={OnboardingDemoScreen}
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen
            name="ConfirmRecording"
            component={ConfirmRecordingScreen}
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen
            name="SummaryReview"
            component={SummaryReviewScreen}
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ presentation: 'modal' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default App;
