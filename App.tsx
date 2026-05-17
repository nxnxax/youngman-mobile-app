import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OnboardingDemoScreen } from './src/features/callRecording/screens/OnboardingDemoScreen';
import { SummaryReviewScreen } from './src/features/callRecording/screens/SummaryReviewScreen';
import type { RootStackParamList } from './src/navigation/types';
import { WebViewHost } from './src/features/webview/WebViewHost';

const Stack = createNativeStackNavigator<RootStackParamList>();

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';

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
            name="SummaryReview"
            component={SummaryReviewScreen}
            options={{ presentation: 'modal' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default App;
