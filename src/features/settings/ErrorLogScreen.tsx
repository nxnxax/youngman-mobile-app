import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  NativeModules,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../navigation/types';
import {
  clearErrorLog,
  readErrorLogTail,
} from '../../services/logger/errorLog';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ErrorLog'>;

interface NativeClipboard {
  setString(text: string): Promise<void>;
}

const clipboard = (
  NativeModules as { ClipboardBridge?: NativeClipboard }
).ClipboardBridge;

/**
 * In-app viewer for the persistent native error log
 * (`<app_files>/errors.log`). Release APKs disable `adb run-as`, so this is
 * the simplest way for the user to share log contents with the developer
 * without rebuilding to a debug variant.
 *
 * Implementation uses a non-editable TextInput rather than a plain Text so
 * Android's long-press text selection + copy menu reliably works for large
 * dumps. The "전체 복사" button is the primary path; long-press selection
 * is the fallback when the user wants just one line.
 */
export const ErrorLogScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [content, setContent] = useState<string>('읽는 중…');
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 500KB ≈ 1000 lines — large enough for 24h monitoring, small enough
      // to stay under both the RN bridge transfer limit (1MB binder) and
      // the Android clipboard limit. Older entries are dropped.
      const log = await readErrorLogTail(500_000);
      setContent(log.trim() === '' ? '(로그가 비어 있어요)' : log);
    } catch (e) {
      setContent(`(로그를 읽지 못했어요: ${String(e)})`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCopy = useCallback(async () => {
    if (!clipboard) {
      Alert.alert('복사 실패', '클립보드 모듈을 찾을 수 없어요.');
      return;
    }
    try {
      await clipboard.setString(content);
      ToastAndroid.show('전체 로그가 복사되었어요', ToastAndroid.SHORT);
    } catch (e) {
      Alert.alert('복사 실패', String(e));
    }
  }, [content]);

  const onShare = useCallback(async () => {
    try {
      // Big logs sometimes fail to share via intent on some apps — copy is
      // the reliable path. Share remains for users who specifically want
      // it (smaller logs, file managers that handle large text).
      await Share.share({
        message: content,
        title: 'errors.log',
      });
    } catch {
      // user cancelled or app rejected — fine
    }
  }, [content]);

  const onClear = useCallback(() => {
    Alert.alert('로그 비우기', '저장된 에러 로그를 전부 삭제할까요?', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: async () => {
          await clearErrorLog();
          await load();
        },
      },
    ]);
  }, [load]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable
          style={styles.headerSideBtn}
          onPress={() => navigation.goBack()}
          hitSlop={12}
        >
          <Text style={styles.headerClose}>닫기</Text>
        </Pressable>
        <Text style={styles.headerTitle}>에러 로그</Text>
        <Pressable
          style={[styles.headerSideBtn, styles.headerSideBtnRight]}
          onPress={load}
          hitSlop={12}
        >
          <Text style={styles.headerAction}>새로고침</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        아래 텍스트를 길게 눌러 선택하거나, 하단 "전체 복사" 버튼을 누르세요.
      </Text>

      {/* TextInput (editable=false) is more reliable than <Text selectable>
          for long-press selection on Android, especially with large content. */}
      <TextInput
        style={styles.log}
        value={content}
        editable={false}
        multiline
        scrollEnabled
        textAlignVertical="top"
      />

      <View style={styles.footer}>
        <Pressable style={styles.footerBtn} onPress={onCopy} disabled={loading}>
          <Text style={styles.footerBtnPrimary}>전체 복사</Text>
        </Pressable>
        <View style={styles.footerDivider} />
        <Pressable style={styles.footerBtn} onPress={onShare} disabled={loading}>
          <Text style={styles.footerBtnNeutral}>공유</Text>
        </Pressable>
        <View style={styles.footerDivider} />
        <Pressable style={styles.footerBtn} onPress={onClear} disabled={loading}>
          <Text style={styles.footerBtnDanger}>비우기</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0B' },
  headerRow: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#161616',
    borderBottomWidth: 1,
    borderBottomColor: '#262626',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  headerSideBtn: {
    position: 'absolute',
    left: 16,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  headerSideBtnRight: { left: undefined, right: 16 },
  headerClose: { color: '#FF453A', fontSize: 15 },
  headerAction: { color: '#0A84FF', fontSize: 15, fontWeight: '600' },
  hint: {
    color: '#888888',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#0B0B0B',
  },
  log: {
    flex: 1,
    color: '#E5E5E5',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#0B0B0B',
  },
  footer: {
    flexDirection: 'row',
    height: 50,
    backgroundColor: '#161616',
    borderTopWidth: 1,
    borderTopColor: '#262626',
  },
  footerBtn: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  footerDivider: { width: 1, backgroundColor: '#262626' },
  footerBtnPrimary: { color: '#0A84FF', fontSize: 15, fontWeight: '700' },
  footerBtnNeutral: { color: '#E5E5E5', fontSize: 15 },
  footerBtnDanger: { color: '#FF453A', fontSize: 15 },
});
