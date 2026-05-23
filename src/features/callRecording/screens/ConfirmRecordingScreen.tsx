import { useNavigation, useRoute } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  RouteProp,
} from '@react-navigation/native-stack';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../../navigation/types';
import { ApiError } from '../../../services/api/client';
import { isLoggedIn } from '../../../services/auth/session';
import {
  assertCanRunSummary,
  showPlanGate,
} from '../../../services/billing/gating';
import {
  ensureFreshProfile,
  evaluateSummaryGate,
  getCachedProfile,
} from '../../../services/billing/billingStore';
import { lookupContactName } from '../../../services/contacts/lookupContact';
import { deterministicRequestId } from '../../../shared/uuid';
import { processRecordingAudioPending } from '../api/processRecording';
import { uploadRecording } from '../api/uploadRecording';
import { extractPhoneNumber } from '../scanner/heuristics';
import { LoadingSecretary } from '../components/LoadingSecretary';

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
    // Session restore + short retry — race window after deep-link entry.
    // The WebView's auth.login bridge message may not have re-populated
    // the RN-side session yet (cold start or recent auth.logout race),
    // so we wait up to 3s for the session to arrive before giving up.
    // Without this the user gets a "로그인이 필요해요" modal even though
    // they're actually logged in — the bridge just hasn't caught up.
    if (!isLoggedIn()) {
      const deadline = Date.now() + 3_000;
      while (!isLoggedIn() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
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
      // 사장님 정책 (2026-05-23 spec lazy-STT): 통화 종료 → upload + processRecording
      // 호출 → audio_pending 응답 (job_id 만 받음, STT 자동 시작 X). UnreviewedPreview
      // 진입 시 trigger_summarize 호출로 STT 시작. groups fetch 불필요 (전송 시점은
      // confirm endpoint 가 처리).
      const contactName = await lookupContactName(phoneNumber);
      const uploaded = await uploadRecording({
        contentUri: uri,
        displayName: name,
        mimeType: mimeType || 'audio/mp4',
        recordedAt,
      });
      const res = await processRecordingAudioPending({
        storage_path: uploaded.storage_path,
        duration_sec: Math.round(duration / 1000),
        original_filename: name,
        recorded_at: recordedAt,
        phone_number: phoneNumber,
        client_request_id: deterministicRequestId(uri),
        customer_name_hint: contactName,
      });
      // 사장님 정책 (2026-05-23 웹팀 회신): audio_sha256 dedup hit 시 동일
      // job_id 반환 + duplicate=true. PoC 재시도 케이스라 사용자에게 toast 만.
      if (res.duplicate || res.error_code === 'JOB_DUPLICATE') {
        ToastAndroid.show(
          '이미 처리 중인 통화예요. 기존 요약을 표시합니다.',
          ToastAndroid.LONG,
        );
      }
      navigation.replace('UnreviewedPreview', { jobId: res.job_id });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'plan_required') {
        // Server flipped on us between the pre-call check and upload.
        // Refresh and surface the same styled gate modal.
        await ensureFreshProfile();
        const profile = getCachedProfile();
        navigation.goBack();
        showPlanGate(evaluateSummaryGate(profile), profile);
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

  // 사장님 정책 (v36 2026-05-23): SummaryReview 의 loading 화면과 동일 visual.
  // "오디오 업로드 중" / ActivityIndicator 같은 시스템 표현 노출 X — LoadingSecretary
  // + "AI 요약중..." / "잠시만 기다려주세요" / "내용을 정리하고 있어요" 로 통일.
  // 사용자는 click → 흰 풀스크린 + 캐릭터 가 ConfirmRecording 부터 SummaryReview
  // 까지 끊김 없이 표시됨 (transition animation=none).
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Pressable
        onPress={() => navigation.goBack()}
        hitSlop={14}
        style={styles.loadingCloseTopRight}
        accessibilityLabel="요약 작업 중지"
      >
        <Text style={styles.loadingCloseTopRightText}>×</Text>
      </Pressable>
      <View style={styles.loadingCenterBlock}>
        <Text style={styles.aiSummaryTitle}>AI 요약중...</Text>
        <LoadingSecretary size={165} />
        <Text style={styles.processingHeadline}>잠시만 기다려주세요</Text>
        <Text style={styles.processingHint}>내용을 정리하고 있어요</Text>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  // SummaryReview 의 loadingBackdrop / loadingCenterBlock / 등과 동일 디자인.
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  loadingCloseTopRight: {
    position: 'absolute',
    // 사장님 정책 (v38 2026-05-23): 상단바 겹침 fix.
    top: 32,
    right: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  loadingCloseTopRightText: {
    color: '#444444',
    fontSize: 18,
    lineHeight: 18,
    fontWeight: '400',
    marginTop: -1,
    includeFontPadding: false,
  },
  loadingCenterBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 28,
  },
  aiSummaryTitle: {
    fontSize: 21,
    fontWeight: '600',
    color: '#1F1F23',
    letterSpacing: -0.6,
    textAlign: 'center',
    marginBottom: 8,
  },
  processingHeadline: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F1F23',
    letterSpacing: -0.5,
    marginTop: 4,
  },
  processingHint: {
    fontSize: 13,
    color: '#7A7A80',
    letterSpacing: -0.3,
    marginTop: -6,
  },
});
