// 미확인 요약 상세 화면. 카드 형태로 summary 의 모든 필드를 표시 +
// "이대로 저장" 버튼. 사장님 정책 (2026-05-21): PlanGateModal 톤 — 글래스
// 카드 + 영맨 AI비서 ❤️ 헤더 + iOS 스타일 정렬.

import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../../services/api/client';
import { logError } from '../../services/logger/errorLog';
import {
  confirmUnreviewed,
  discardUnreviewed,
  previewUnreviewed,
  triggerSummarize,
  type UnreviewedDetail,
} from '../callRecording/api/unreviewed';
import type { RootStackParamList } from '../../navigation/types';

function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}분 ${String(s).padStart(2, '0')}초`;
}

function formatRecordedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return '';
  }
}

const Field: React.FC<{ label: string; value: string | null | undefined }> = ({
  label,
  value,
}) => {
  if (!value || value.trim() === '') return null;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
};

export const UnreviewedPreviewScreen: React.FC = () => {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'UnreviewedPreview'>>();
  const jobId = route.params.jobId;
  const insets = useSafeAreaInsets();

  const [detail, setDetail] = useState<UnreviewedDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    // 사장님 정책 (v48 2026-05-23 영맨 commit f0b9524): trigger_summarize 응답에
    // ok / processing 필드 명시. preview endpoint 로 polling.
    //   r.ok=false → 에러 표시 (r.message)
    //   r.ok=true & r.processing=true → preview endpoint 2초 polling (ready 까지)
    //   r.ok=true & r.processing=false (ready_to_review) → 즉시 preview endpoint 호출
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const POLL_MAX_TRIES = 150; // 5min budget @ 2sec interval

    // 사장님 정책 (v49 2026-05-23 영맨 회신): preview endpoint 응답에는
    // ok/processing 필드 없음 (영맨 webteam 이 trigger_summarize 만 fix 함).
    // job_status 기반으로 분기 — 영맨 응답 형태와 무관하게 작동.
    //   ready_to_review / saved → 완료 (summary 표시)
    //   failed_permanent → 실패
    //   그 외 (audio_pending/queued/stt_processing/llm_processing) → polling 계속
    const startPolling = (delaySec: number, tries: number) => {
      if (cancelled || tries >= POLL_MAX_TRIES) return;
      timer = setTimeout(async () => {
        if (cancelled) return;
        try {
          const detail = await previewUnreviewed(jobId);
          if (cancelled) return;
          logError(
            'diag.preview',
            new Error(`jobId=${jobId} tries=${tries} response=${JSON.stringify(detail)}`),
          );
          setDetail(detail);
          const js = detail.job_status;
          if (js === 'ready_to_review' || js === 'saved') {
            setLoading(false);
            return;
          }
          if (js === 'failed_permanent') {
            setLoading(false);
            return;
          }
          // audio_pending / queued / stt_processing / llm_processing → polling 계속
          startPolling(2, tries + 1);
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'auth_pending')) {
            logError('UnreviewedPreview.poll', e, { jobId, tries });
          }
          startPolling(2, tries + 1);
        }
      }, delaySec * 1000);
    };

    const fetchPreviewImmediate = async () => {
      try {
        const detail = await previewUnreviewed(jobId);
        if (cancelled) return;
        logError(
          'diag.preview.immediate',
          new Error(`jobId=${jobId} response=${JSON.stringify(detail)}`),
        );
        setDetail(detail);
        setLoading(false);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'auth_pending')) {
          logError('UnreviewedPreview.previewImmediate', e, { jobId });
        }
        setLoading(false);
      }
    };

    void (async () => {
      try {
        const res = await triggerSummarize(jobId);
        if (cancelled) return;
        logError(
          'diag.triggerSummarize',
          new Error(`jobId=${jobId} response=${JSON.stringify(res)}`),
        );
        setDetail(res);
        if (!res.ok) {
          setLoading(false);
          return;
        }
        if (res.processing) {
          startPolling(2, 0);
        } else {
          await fetchPreviewImmediate();
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'auth_pending')) {
          logError('UnreviewedPreview.load', e, { jobId });
        }
        if (!cancelled) {
          ToastAndroid.show(
            '요약을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.',
            ToastAndroid.LONG,
          );
          navigation.goBack();
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, navigation]);

  const onConfirm = useCallback(async () => {
    if (confirming || discarding) return;
    setConfirming(true);
    try {
      const res = await confirmUnreviewed(jobId);
      if (res.duplicate || res.error_code === 'JOB_EXISTS') {
        ToastAndroid.show('이미 저장된 통화입니다.', ToastAndroid.LONG);
      } else {
        ToastAndroid.show('고객관리대장에 전송됐습니다.', ToastAndroid.LONG);
      }
      navigation.goBack();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'auth_pending')) {
        logError('UnreviewedPreview.confirm', e, { jobId });
      }
      ToastAndroid.show('저장에 실패했어요. 잠시 후 다시 시도해주세요.', ToastAndroid.LONG);
    } finally {
      setConfirming(false);
    }
  }, [confirming, discarding, jobId, navigation]);

  // 사장님 정책 (2026-05-23 spec C): "요약 폐기" → discard endpoint.
  const onDiscard = useCallback(() => {
    if (confirming || discarding) return;
    Alert.alert(
      '요약내용을 폐기하시겠습니까?',
      '폐기하면 통화 요약과 관련 데이터가 모두 삭제됩니다.',
      [
        { text: '아니요', style: 'cancel' },
        {
          text: '네',
          style: 'destructive',
          onPress: () => {
            setDiscarding(true);
            discardUnreviewed(jobId)
              .catch(e => logError('UnreviewedPreview.discard', e, { jobId }))
              .finally(() => {
                setDiscarding(false);
                navigation.goBack();
              });
          },
        },
      ],
    );
  }, [confirming, discarding, jobId, navigation]);

  // 사장님 정책 (2026-05-23 spec B): X 버튼 → "폐기/보류" Alert.
  //   폐기 → discard endpoint, 보류 → goBack (백그라운드 STT 계속, 미확인 요약 자동 추가)
  const onCloseX = useCallback(() => {
    Alert.alert('요약을 어떻게 할까요?', '', [
      { text: '취소', style: 'cancel' },
      {
        text: '보류 (미확인 요약에 보관)',
        onPress: () => navigation.goBack(),
      },
      {
        text: '폐기',
        style: 'destructive',
        onPress: () => {
          discardUnreviewed(jobId).catch(e =>
            logError('UnreviewedPreview.xDiscard', e, { jobId }),
          );
          navigation.goBack();
        },
      },
    ]);
  }, [jobId, navigation]);

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
        <View style={styles.headerCenter}>
          <View style={styles.brandRow}>
            <Text style={styles.brand}>영맨 AI비서</Text>
            <Text style={styles.heart}> ❤️</Text>
          </View>
          <Text style={styles.headerSubtitle}>요약 검토</Text>
        </View>
        <Pressable onPress={onCloseX} style={styles.backButton} hitSlop={12}>
          <Text style={styles.xButton}>×</Text>
        </Pressable>
      </View>

      {!detail ? (
        <View style={styles.center}>
          <ActivityIndicator color="#0066FF" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.card}>
            <Text style={styles.customerName}>
              {(detail.customer_name ??
                detail.summary?.customer_name ??
                '').trim() || '이름 없음'}
            </Text>
            <Text style={styles.meta}>
              {[
                formatRecordedAt(detail.recorded_at),
                formatDuration(detail.duration_sec),
                detail.phone_number,
              ]
                .filter(s => s && s.length > 0)
                .join(' · ')}
            </Text>

            <View style={styles.hairline} />

            {/* 사장님 정책 (v49 2026-05-23): preview 응답에 ok/processing 필드
                없음 (영맨 webteam fix 누락). job_status 기반 분기 — 영맨 응답
                형태와 무관하게 작동. */}
            {!detail.summary ? (
              detail.job_status === 'failed_permanent' ? (
                <Text style={styles.placeholderNote}>
                  요약 처리에 실패했어요.
                  {detail.last_error ? `\n(${detail.last_error})` : ''}
                </Text>
              ) : (
                <View style={styles.statusBlock}>
                  <ActivityIndicator color="#0066FF" />
                  <Text style={styles.placeholderNote}>
                    AI 가 요약 중입니다.{'\n'}
                    잠시만 기다려주세요.
                  </Text>
                </View>
              )
            ) : null}

            {detail.summary ? (
              <>
                <Field label="요약" value={detail.summary.summary} />
                <Field label="관심사" value={detail.summary.interest} />
                <Field label="문의 내용" value={detail.summary.inquiry} />
                <Field label="예산·조건" value={detail.summary.budget_condition} />
                <Field label="다음 액션" value={detail.summary.next_action} />

                {detail.summary.transcript && detail.summary.transcript.length > 0 ? (
                  <View style={styles.transcriptBlock}>
                    <Text style={styles.fieldLabel}>전체 대화</Text>
                    <Text style={styles.transcript}>{detail.summary.transcript}</Text>
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        </ScrollView>
      )}

      {detail ? (
        <View style={[styles.footerBar, { paddingBottom: 12 + insets.bottom }]}>
          <Pressable
            onPress={onDiscard}
            disabled={confirming || discarding}
            style={[styles.discardButton, (confirming || discarding) && styles.submitDisabled]}
          >
            <Text style={styles.discardText}>요약 폐기</Text>
          </Pressable>
          <Pressable
            onPress={() => void onConfirm()}
            disabled={confirming || discarding}
            style={[styles.submitButton, (confirming || discarding) && styles.submitDisabled]}
          >
            {confirming ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.submitText}>고객관리대장 전송</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F7F7F8' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backArrow: { fontSize: 28, color: '#0066FF', lineHeight: 28 },
  headerCenter: { flex: 1, alignItems: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  brand: { fontSize: 15, fontWeight: '700', color: '#111111', letterSpacing: -0.2 },
  heart: { fontSize: 13 },
  headerSubtitle: { fontSize: 12, color: '#666666', marginTop: 2 },
  scroll: { padding: 12, paddingBottom: 100 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 18,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
  },
  customerName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.3,
  },
  meta: { fontSize: 12, color: '#888888', marginTop: 6 },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5E5',
    marginVertical: 14,
  },
  field: { marginBottom: 14 },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#666666',
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  fieldValue: { fontSize: 14, color: '#222222', lineHeight: 21 },
  transcriptBlock: {
    marginTop: 8,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5E5',
  },
  transcript: {
    fontSize: 12,
    color: '#555555',
    lineHeight: 19,
    marginTop: 6,
  },
  placeholderNote: {
    fontSize: 13,
    color: '#888888',
    lineHeight: 19,
    textAlign: 'center',
    paddingVertical: 12,
  },
  statusBlock: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  footerBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    paddingBottom: 24,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5E5',
    flexDirection: 'row',
    gap: 10,
  },
  submitButton: {
    flex: 1,
    backgroundColor: '#0066FF',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  // 사장님 정책 (2026-05-23 spec C): "요약 폐기" 버튼 — 좌측. discard endpoint.
  discardButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 15,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E5E5',
  },
  discardText: { color: '#FF3B30', fontSize: 15, fontWeight: '600' },
  // 사장님 정책 (2026-05-23 spec B): 헤더 우측 X 버튼.
  xButton: {
    fontSize: 24,
    color: '#666666',
    lineHeight: 28,
    fontWeight: '300',
  },
});
