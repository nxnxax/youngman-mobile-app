// 사장님 정책 (2026-05-21): Play Store 정식 출시 전 테스트 기간. 메인 화면의
// 결제 권유 자리에서 이 화면으로 이동. APK 직접 다운로드만 간단히 안내.

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TESTER_APK_URL } from '../../config/env';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Tester'>;

export const TesterScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();

  const onDownload = useCallback(async () => {
    if (!TESTER_APK_URL) {
      ToastAndroid.show(
        '다운로드 링크 준비 중입니다. 잠시 후 다시 시도해주세요.',
        ToastAndroid.LONG,
      );
      return;
    }
    try {
      await Linking.openURL(TESTER_APK_URL);
    } catch {
      ToastAndroid.show(
        '브라우저 열기에 실패했어요.',
        ToastAndroid.LONG,
      );
    }
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          hitSlop={12}
        >
          <Text style={styles.backArrow}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>테스터</Text>
        <View style={styles.backButton} />
      </View>

      <View style={styles.body}>
        <Text style={styles.title}>테스트기간 무료 이벤트</Text>
        <Text style={styles.subtitle}>
          정식 출시 전 베타 기간입니다.{'\n'}
          설치 파일을 받아 무료로 사용해 보세요.
        </Text>

        <Pressable
          onPress={() => void onDownload()}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>설치 파일 다운로드</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backArrow: { fontSize: 28, color: '#0066FF', lineHeight: 28 },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  body: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 64,
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 12,
    fontSize: 14,
    color: '#666666',
    lineHeight: 22,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 40,
    backgroundColor: '#0066FF',
    borderRadius: 12,
    paddingVertical: 15,
    paddingHorizontal: 48,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});
