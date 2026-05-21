import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ConfirmRecordingScreen } from './src/features/callRecording/screens/ConfirmRecordingScreen';
import { OnboardingDemoScreen } from './src/features/callRecording/screens/OnboardingDemoScreen';
import { SummaryReviewScreen } from './src/features/callRecording/screens/SummaryReviewScreen';
import { ErrorLogScreen } from './src/features/settings/ErrorLogScreen';
import { ManufacturerGuideScreen } from './src/features/settings/ManufacturerGuideScreen';
import { SettingsScreen } from './src/features/settings/SettingsScreen';
import { UnreviewedPreviewScreen } from './src/features/unreviewedSummaries/UnreviewedPreviewScreen';
import { UnreviewedSummariesScreen } from './src/features/unreviewedSummaries/UnreviewedSummariesScreen';
import {
  attachIncomingCallListener,
  detachIncomingCallListener,
} from './src/features/callRecording/services/incomingCallHandler';
import { OnboardingScreen } from './src/features/onboarding/OnboardingScreen';
import { isAllGranted } from './src/features/onboarding/permissions';
import { usePermissionStatus } from './src/features/onboarding/usePermissionStatus';
import type { RootStackParamList } from './src/navigation/types';
import { restoreSession } from './src/services/auth/session';
import { WebViewHost } from './src/features/webview/WebViewHost';

// 사장님 정책 (2026-05-21): cold start 자동로그인 가속 + "세션 만료" alert
// 차단. 이전엔 WebView 가 cafe24 페이지 fetch + Supabase JS 실행 + bridge
// auth.login post 의 3-5초 chain 이 끝나야 RN session 이 생겼음. 그동안 API
// 호출이 401 나면 SESSION_DEAD → alert 폭주.
//
// restoreSession() 은 AsyncStorage 의 직전 session 을 ~100ms 안에 메모리로
// 복원 → WebView 안 기다리고 즉시 isLoggedIn=true. App import 시점에 한 번만
// fire-and-forget — 중복 호출 시 idempotent (current!=null 이면 return).
void restoreSession();

const Stack = createNativeStackNavigator<RootStackParamList>();

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';
  const { status, refresh } = usePermissionStatus();
  // 사용자가 OnboardingScreen 에서 "나중에 설정" 누르면 true. 메인 화면
  // 진입을 허용하고, 그 후엔 메인 화면 PermissionBanner 가 항목별로 계속
  // 유도. 세션 범위 (앱 cold start 시 false 로 초기화) — 다음 cold start
  // 에서도 권한 빠져있으면 1회 풀스크린 안내가 다시 한 번 노출됨. 사장님
  // 정책 ([[project-main-service-4]]) 상 메인서비스 4종 활성화 유도는
  // 반복적으로 노출되어야 함.
  const [onboardingSkipped, setOnboardingSkipped] = useState(false);
  const handleOnboardingSkip = useCallback(() => {
    setOnboardingSkipped(true);
  }, []);

  // Subscribe to incoming-call events from the native CallScreeningService.
  // Idempotent inside the helper — safe across React StrictMode double-renders.
  useEffect(() => {
    attachIncomingCallListener();
    return () => detachIncomingCallListener();
  }, []);

  // 권한 상태 첫 read 가 끝나기 전까진 splash 유지. 1프레임짜리 깜빡임이
  // 사용자에게 WebView 가 잠시 떴다 사라지는 것처럼 보이는 걸 방지.
  if (status == null) {
    return (
      <SafeAreaProvider>
        <StatusBar
          barStyle={isDarkMode ? 'light-content' : 'dark-content'}
          backgroundColor="#FFFFFF"
        />
        <View style={styles.splash}>
          <ActivityIndicator color="#0066FF" />
        </View>
      </SafeAreaProvider>
    );
  }

  // 권한이 하나라도 빠졌고 사용자가 아직 skip 안 했으면 OnboardingScreen
  // 풀스크린. 사용자가 "나중에" 누르거나 모든 권한 통과되면 메인 화면 진입.
  // 메인 화면에서는 PermissionBanner 가 부족한 항목별로 카드 stack 노출.
  if (!isAllGranted(status) && !onboardingSkipped) {
    return (
      <SafeAreaProvider>
        <StatusBar
          barStyle={isDarkMode ? 'light-content' : 'dark-content'}
          backgroundColor="#FFFFFF"
        />
        <OnboardingScreen
          status={status}
          onRefresh={refresh}
          onSkip={handleOnboardingSkip}
        />
      </SafeAreaProvider>
    );
  }

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
          <Stack.Screen
            name="ErrorLog"
            component={ErrorLogScreen}
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen
            name="ManufacturerGuide"
            component={ManufacturerGuideScreen}
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen
            name="UnreviewedSummaries"
            component={UnreviewedSummariesScreen}
          />
          <Stack.Screen
            name="UnreviewedPreview"
            component={UnreviewedPreviewScreen}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default App;
