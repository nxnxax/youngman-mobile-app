import { useNavigation, useRoute } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  RouteProp,
} from '@react-navigation/native-stack';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../../navigation/types';
import { ApiError } from '../../../services/api/client';
import { isLoggedIn } from '../../../services/auth/session';
import { lookupContactName } from '../../../services/contacts/lookupContact';
import { deterministicRequestId } from '../../../shared/uuid';
import { processRecording } from '../api/processRecording';
import { fetchLedgerGroups } from '../api/records';
import type { LedgerGroup } from '../api/types';
import { uploadRecording } from '../api/uploadRecording';
import { extractPhoneNumber } from '../scanner/heuristics';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ConfirmRecording'>;
type Route = RouteProp<RootStackParamList, 'ConfirmRecording'>;

type Stage = 'idle' | 'uploading' | 'processing';

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

function formatDate(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${d.getHours()}시 ${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}분`;
}

function toIso8601KST(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offsetMin * 60_000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

export const ConfirmRecordingScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { uri, name, duration, dateAdded, mimeType } = route.params;
  // Start in `uploading` so the screen never flashes the idle button — the
  // recording UX is "one-tap from the modal" and this screen only exists to
  // show progress before SummaryReview opens.
  const [stage, setStage] = useState<Stage>('uploading');
  const startedRef = useRef(false);

  const phoneNumber = extractPhoneNumber(name);
  const recordedAt = toIso8601KST(dateAdded);

  const onProcess = async () => {
    if (!isLoggedIn()) {
      Alert.alert(
        '로그인이 필요해요',
        '영맨 앱을 열고 로그인 후 알림을 다시 눌러주세요.',
        [{ text: '확인', onPress: () => navigation.goBack() }],
      );
      return;
    }
    try {
      setStage('uploading');
      const contactName = await lookupContactName(phoneNumber);
      const uploaded = await uploadRecording({
        contentUri: uri,
        displayName: name,
        mimeType: mimeType || 'audio/mp4',
        recordedAt,
      });

      setStage('processing');
      const processed = await processRecording({
        storage_path: uploaded.storage_path,
        duration_sec: Math.round(duration / 1000),
        original_filename: name,
        recorded_at: recordedAt,
        phone_number: phoneNumber,
        client_request_id: deterministicRequestId(uri),
        customer_name_hint: contactName,
      });

      let groups: ReadonlyArray<LedgerGroup> = [];
      try {
        const res = await fetchLedgerGroups('customer');
        groups = res.groups;
      } catch (err) {
        if (__DEV__) {
          console.log('[ConfirmRecording] fetchLedgerGroups failed', err);
        }
      }

      setStage('idle');
      // Omit groupId so SummaryReview can default to the user's main group.
      navigation.replace('SummaryReview', {
        customerLog: processed.customer_log,
        availableGroups: groups,
      });
    } catch (e) {
      setStage('idle');
      if (e instanceof ApiError && e.code === 'plan_required') {
        Alert.alert(
          'Premium 구독이 필요해요',
          '무료 체험 횟수가 끝났습니다.',
        );
        return;
      }
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert('처리 실패', msg, [
        { text: '확인', onPress: () => navigation.goBack() },
      ]);
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void onProcess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animate the trailing "..." on the loading label so the text itself looks
  // alive (".  " → ".. " → "...").
  const [dots, setDots] = useState('...');
  useEffect(() => {
    let count = 3;
    const id = setInterval(() => {
      count = (count % 3) + 1;
      setDots('.'.repeat(count));
    }, 400);
    return () => clearInterval(id);
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
        >
          <Text style={styles.close}>나중에</Text>
        </Pressable>
      </View>

      <View style={styles.loadingBody}>
        <ActivityIndicator size="large" color="#0066FF" />
        <Text style={styles.loadingText}>AI 요약 중{dots}</Text>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  close: { color: '#666', fontSize: 15 },
  loadingBody: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 80,
    gap: 20,
  },
  loadingText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
});
