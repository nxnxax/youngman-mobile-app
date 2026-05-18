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
import { assertCanRunSummary } from '../../../services/billing/gating';
import { lookupContactName } from '../../../services/contacts/lookupContact';
import { deterministicRequestId } from '../../../shared/uuid';
import { fetchLedgerGroups } from '../api/records';
import type { LedgerGroup } from '../api/types';
import { uploadRecording } from '../api/uploadRecording';
import { extractPhoneNumber } from '../scanner/heuristics';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ConfirmRecording'>;
type Route = RouteProp<RootStackParamList, 'ConfirmRecording'>;

// Upload is the only thing this screen actually waits for now —
// processRecording moved into SummaryReview so the user gets the screen
// transition immediately and stares at the form skeleton instead of a
// 7-second spinner.

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
    // Plan gating — bail before burning upload/server credits if the user
    // can't actually run AI summary right now (Free plan, quota exhausted,
    // past_due, etc.). The gating helper shows its own Alert and provides
    // an upgrade deep link.
    const allowed = await assertCanRunSummary();
    if (!allowed) {
      navigation.goBack();
      return;
    }
    try {
      const contactName = await lookupContactName(phoneNumber);
      // Upload + groups in parallel — groups call is fast (~ms) and the user
      // will need it on the SummaryReview group picker; no reason to defer.
      const [uploaded, groupsRes] = await Promise.all([
        uploadRecording({
          contentUri: uri,
          displayName: name,
          mimeType: mimeType || 'audio/mp4',
          recordedAt,
        }),
        fetchLedgerGroups('customer').catch(err => {
          if (__DEV__) {
            console.log('[ConfirmRecording] fetchLedgerGroups failed', err);
          }
          return { groups: [] as ReadonlyArray<LedgerGroup> };
        }),
      ]);

      // Hand off the rest of the work to SummaryReview as a pendingJob. The
      // user perceives the transition as "tap → form (loading)" instead of
      // "tap → spinner for 7s → form".
      navigation.replace('SummaryReview', {
        pendingJob: {
          storage_path: uploaded.storage_path,
          duration_sec: Math.round(duration / 1000),
          original_filename: name,
          recorded_at: recordedAt,
          phone_number: phoneNumber,
          client_request_id: deterministicRequestId(uri),
          customer_name_hint: contactName,
        },
        availableGroups: groupsRes.groups,
      });
    } catch (e) {
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

  const loadingHeadline = '오디오 업로드 중';
  const loadingHint = '잠시만요…';

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
        <Text style={styles.loadingText}>{loadingHeadline}{dots}</Text>
        <Text style={styles.loadingHint}>{loadingHint}</Text>
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
  loadingHint: {
    fontSize: 14,
    color: '#666666',
    marginTop: 4,
  },
});
