import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
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
import { uuidv4 } from '../../../shared/uuid';
import { processRecording } from '../api/processRecording';
import { uploadRecording } from '../api/uploadRecording';
import { extractPhoneNumber } from '../scanner/heuristics';
import type { FoundCallRecording } from '../scanner/heuristics';
import { scanForCallRecordings } from '../scanner/recordingScanner';

type Nav = NativeStackNavigationProp<RootStackParamList, 'OnboardingDemo'>;

type ScanState =
  | { status: 'loading' }
  | { status: 'ok'; recording: FoundCallRecording; totalFound: number }
  | { status: 'empty' }
  | { status: 'no-permission' }
  | { status: 'error'; message: string };

type ProcessStage = 'idle' | 'uploading' | 'processing';

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
  // Default toISOString is UTC. We want the same instant expressed in KST so
  // the backend's yyyy-mm-dd partitioning aligns with the user's day.
  const offsetMin = -d.getTimezoneOffset(); // device local; KST = +540
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offsetMin * 60_000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

export const OnboardingDemoScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [scan, setScan] = useState<ScanState>({ status: 'loading' });
  const [stage, setStage] = useState<ProcessStage>('idle');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await scanForCallRecordings({ limit: 1, maxAgeDays: 30 });
      if (cancelled) return;
      if (result.status === 'no-permission') {
        setScan({ status: 'no-permission' });
      } else if (result.status === 'error') {
        setScan({ status: 'error', message: result.error ?? 'unknown' });
      } else if (result.recordings.length === 0) {
        setScan({ status: 'empty' });
      } else {
        setScan({
          status: 'ok',
          recording: result.recordings[0],
          totalFound: result.totalFound,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onProcess = async (rec: FoundCallRecording) => {
    if (!isLoggedIn()) {
      Alert.alert(
        '로그인이 필요해요',
        '영맨 로그인 후 다시 시도해주세요.',
        [{ text: '확인', onPress: () => navigation.goBack() }],
      );
      return;
    }
    try {
      setStage('uploading');
      const recordedAt = toIso8601KST(rec.dateAdded);
      const phoneNumber = extractPhoneNumber(rec.displayName);
      const contactName = await lookupContactName(phoneNumber);
      const uploaded = await uploadRecording({
        contentUri: rec.uri,
        displayName: rec.displayName,
        mimeType: rec.mimeType || 'audio/mp4',
        recordedAt,
      });

      setStage('processing');
      const processed = await processRecording({
        storage_path: uploaded.storage_path,
        duration_sec: Math.round(rec.duration / 1000),
        original_filename: rec.displayName,
        recorded_at: recordedAt,
        phone_number: phoneNumber,
        client_request_id: uuidv4(),
        customer_name_hint: contactName,
      });

      setStage('idle');
      navigation.replace('SummaryReview', {
        customerLog: processed.customer_log,
      });
    } catch (e) {
      setStage('idle');
      if (e instanceof ApiError && e.code === 'plan_required') {
        Alert.alert(
          'Premium 구독이 필요해요',
          '무료 체험 횟수가 끝났습니다. Premium 구독 후 무제한으로 사용하실 수 있어요.',
        );
        return;
      }
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert('처리 실패', msg);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          disabled={stage !== 'idle'}
        >
          <Text style={[styles.close, stage !== 'idle' && styles.closeDisabled]}>닫기</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={styles.title}>AI 통화 요약 체험</Text>
        <Text style={styles.subtitle}>
          가장 최근 통화 1건을 AI가 요약해서{'\n'}
          고객관리대장에 어떻게 들어가는지 보여드릴게요.
        </Text>

        {scan.status === 'loading' && (
          <View style={styles.card}>
            <ActivityIndicator />
            <Text style={styles.muted}>통화녹음을 찾는 중…</Text>
          </View>
        )}

        {scan.status === 'ok' && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>최근 통화</Text>
            <Text style={styles.cardValue}>
              {extractPhoneNumber(scan.recording.displayName) ??
                scan.recording.displayName}
            </Text>
            <Text style={styles.meta}>
              {formatDate(scan.recording.dateAdded)} ·{' '}
              {formatDuration(scan.recording.duration)}
            </Text>
            <Text style={styles.muted}>
              폰에서 통화녹음 {scan.totalFound.toLocaleString()}건이 감지됐어요.
              {'\n'}그중 가장 최근 1건으로 시작합니다.
            </Text>

            {stage === 'idle' ? (
              <>
                <Pressable
                  style={styles.primaryButton}
                  onPress={() => onProcess(scan.recording)}
                >
                  <Text style={styles.primaryButtonText}>이 통화 요약해보기</Text>
                </Pressable>
                <Pressable onPress={() => navigation.goBack()}>
                  <Text style={styles.secondaryButtonText}>다음에 할게요</Text>
                </Pressable>
              </>
            ) : (
              <View style={styles.progressBlock}>
                <ActivityIndicator />
                <Text style={styles.progressText}>
                  {stage === 'uploading'
                    ? '오디오 업로드 중…'
                    : 'AI 분석 중 (보통 30~60초)…'}
                </Text>
              </View>
            )}
          </View>
        )}

        {scan.status === 'empty' && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>최근 통화녹음이 없어요</Text>
            <Text style={styles.muted}>
              한 통화 녹음하시고 다시 열어주세요.{'\n'}
              새 녹음이 생기면 자동으로 알려드릴게요.
            </Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.primaryButtonText}>확인</Text>
            </Pressable>
          </View>
        )}

        {scan.status === 'no-permission' && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>오디오 권한 필요</Text>
            <Text style={styles.muted}>
              통화녹음 파일을 찾으려면 "음악 및 오디오" 권한이 필요해요.{'\n'}
              설정에서 허용 후 다시 열어주세요.
            </Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.primaryButtonText}>확인</Text>
            </Pressable>
          </View>
        )}

        {scan.status === 'error' && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>오류</Text>
            <Text style={styles.muted}>{scan.message}</Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.primaryButtonText}>닫기</Text>
            </Pressable>
          </View>
        )}
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
  close: { color: '#666666', fontSize: 15 },
  closeDisabled: { color: '#CCC' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 12 },
  title: { fontSize: 24, fontWeight: '700', color: '#111111' },
  subtitle: { fontSize: 15, color: '#444444', marginTop: 8, lineHeight: 22 },
  card: {
    marginTop: 32,
    padding: 20,
    backgroundColor: '#F6F8FB',
    borderRadius: 14,
    gap: 8,
  },
  cardLabel: { fontSize: 13, color: '#666666' },
  cardValue: { fontSize: 22, fontWeight: '700', color: '#0066FF' },
  meta: { fontSize: 14, color: '#444444' },
  muted: { fontSize: 13, color: '#666666', marginTop: 8, lineHeight: 20 },
  primaryButton: {
    marginTop: 20,
    backgroundColor: '#0066FF',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  secondaryButtonText: {
    textAlign: 'center',
    color: '#666666',
    marginTop: 12,
    fontSize: 14,
  },
  progressBlock: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  progressText: { color: '#444', fontSize: 14 },
});
