import { useNavigation, useRoute } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  RouteProp,
} from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  DeviceEventEmitter,
  KeyboardAvoidingView,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../../navigation/types';
import {
  ensureFreshProfile,
  evaluateSummaryGate,
  getCachedProfile,
} from '../../../services/billing/billingStore';
import { showPlanGate } from '../../../services/billing/gating';
import { processRecording } from '../api/processRecording';
import {
  cancelCustomerLog,
  getCustomerLog,
  sendCustomerLogToGroup,
} from '../api/records';
import type {
  CustomerLogPatch,
  CustomerLogRow,
  LedgerGroup,
} from '../api/types';
import { ApiError } from '../../../services/api/client';
import { logError } from '../../../services/logger/errorLog';
import { showSuccessOverlay } from '../../../services/overlay/showSuccessOverlay';
import { LoadingSecretary } from '../components/LoadingSecretary';

type Nav = NativeStackNavigationProp<RootStackParamList, 'SummaryReview'>;
type Route = RouteProp<RootStackParamList, 'SummaryReview'>;

interface FieldDef {
  key: keyof CustomerLogPatch;
  label: string;
  multiline?: boolean;
  placeholder?: string;
}

const FIELDS: ReadonlyArray<FieldDef> = [
  { key: 'customer_name', label: '고객명', placeholder: '예: 김상우' },
  { key: 'phone_number', label: '전화번호', placeholder: '010-1234-5678' },
  { key: 'summary', label: '통화 요약', multiline: true },
  { key: 'agent_memo', label: '담당자 메모', multiline: true, placeholder: '본인 메모 (선택)' },
];

function rowToFormValues(row: CustomerLogRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    out[f.key] = (row[f.key] ?? '') as string;
  }
  return out;
}

function emptyFormValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    out[f.key] = '';
  }
  return out;
}

function diff(
  original: Record<string, string>,
  current: Record<string, string>,
): CustomerLogPatch {
  const patch: CustomerLogPatch = {};
  for (const f of FIELDS) {
    const before = original[f.key] ?? '';
    const after = current[f.key] ?? '';
    if (before !== after) {
      (patch as Record<string, string | null>)[f.key] =
        after.length === 0 ? null : after;
    }
  }
  return patch;
}

export const SummaryReviewScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const params = route.params;
  const availableGroups: ReadonlyArray<LedgerGroup> = params.availableGroups ?? [];

  // The form is in one of two modes:
  //  - "ready": customerLog was passed in (history → review, demo flow).
  //  - "pending": ConfirmRecording uploaded the audio and handed off the
  //    job to us. We run processRecording here so the user sees the form
  //    screen during the ~7s wait instead of staring at a ConfirmRecording
  //    spinner.
  // 사장님 정책 (2026-05-21 비상 fix R2, ChatGPT 권고 + 사장님 PoC 보고):
  // navigation 이 SummaryReview instance 재사용 시 useState 의 initializer 는
  // 첫 mount 만 실행. params.pendingJob 이 바뀌어도 customerLog state 가 stale
  // (이전 통화의 row) 로 남아 사용자 화면에 "이전 통화 요약"으로 표시되는 케이스
  // 보고됨. render 직전 reqId mismatch 검사로 stale 차단.
  const [customerLog, setCustomerLog] = useState<CustomerLogRow | null>(
    params.customerLog ?? null,
  );
  const [processing, setProcessing] = useState<boolean>(
    params.pendingJob !== undefined && params.customerLog === undefined,
  );
  // Tick during processing so we can rotate "AI 분석 중" → "거의 다 됐어요"
  // after 5s. Same UX trick as the old ConfirmRecording, just relocated.
  const [processingElapsedMs, setProcessingElapsedMs] = useState(0);

  const original = useMemo(
    () => (customerLog ? rowToFormValues(customerLog) : emptyFormValues()),
    [customerLog],
  );
  const [values, setValues] = useState<Record<string, string>>(original);
  // Track whether the user has typed into the form yet — if they have, we
  // must NOT clobber their edits when processRecording finishes. (Unlikely
  // since fields are blank during processing, but cheap to guard.)
  const userEditedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(() => {
    if (params.groupId !== undefined) {
      return params.groupId;
    }
    const main = availableGroups.find((g: LedgerGroup) => g.is_main);
    return main?.id ?? null;
  });
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  // 사장님 정책 (2026-05-21 비상 fix): 같은 instance 재사용 시 새 reqId 면 다시
  // processRecording 호출되도록 마지막 처리된 client_request_id 보관.
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    if (__DEV__ && customerLog) {
      console.log('[SummaryReview] customer_log.id', customerLog.id);
    }
  }, [customerLog]);

  // 사장님 정책 (2026-05-21 비상 fix, ChatGPT 권고): navigation 이 같은
  // SummaryReview instance 를 재사용하는 케이스 대비. pendingJob.client_request_id
  // 가 바뀌면 fresh start — 이전 통화 잔재 표시 차단. deps 에 reqId 포함.
  // ref guard 는 strict mode double-invoke 방지용.
  const pendingReqId = params.pendingJob?.client_request_id;
  // 사장님 정책 (2026-05-22 PM race 진단): T5 = SummaryReview mount.
  // CallPostActivity 의 T4 (review click) 와 비교해 RN navigation latency 측정.
  useEffect(() => {
    logError(
      'raceTrace',
      new Error(`T5 SummaryReview mount ts=${Date.now()}`),
    );
  }, []);

  useEffect(() => {
    if (!params.pendingJob || params.customerLog) return;
    if (startedRef.current === pendingReqId) return;  // 같은 reqId 재진입 dedup
    startedRef.current = pendingReqId ?? null;
    setCustomerLog(null);
    setProcessing(true);
    // 새 reqId 진입 — form 의 user 편집 이전 잔재 clear. userEditedRef 도 reset.
    userEditedRef.current = false;
    setValues(emptyFormValues());
    let cancelled = false;
    (async () => {
      try {
        const t1 = Date.now();
        logError('raceTrace', new Error(`T1 processRecording call ts=${t1}`));
        const res = await processRecording(params.pendingJob!);
        const t2 = Date.now();
        logError(
          'raceTrace',
          new Error(`T2 processRecording response ts=${t2} elapsed=${t2 - t1}ms`),
        );
        if (cancelled) return;
        // server 가 dedup 으로 다른 통화의 customer_log 반환하는 케이스 차단.
        // 응답의 client_request_id 가 호출 시 보낸 ID 와 일치하지 않으면 reject
        // — "이전 통화 요약 표시" 회귀 방지.
        const expected = params.pendingJob!.client_request_id;
        const got = res.customer_log?.client_request_id;
        if (expected && got && expected !== got) {
          if (__DEV__) {
            console.warn(
              '[SummaryReview] client_request_id mismatch — rejecting',
              { expected, got },
            );
          }
          setProcessing(false);
          Alert.alert(
            '처리 실패',
            '다른 통화의 요약이 반환됐어요. 잠시 후 다시 시도해주세요.',
            [{ text: '확인', onPress: () => navigation.popToTop() }],
          );
          return;
        }
        setCustomerLog(res.customer_log);
        if (!userEditedRef.current) {
          setValues(rowToFormValues(res.customer_log));
        }
        setProcessing(false);
      } catch (e) {
        if (cancelled) return;
        setProcessing(false);
        if (e instanceof ApiError && e.code === 'plan_required') {
          // Defense-in-depth: pre-call gating in ConfirmRecording should
          // have caught this, but the user's quota may have shifted in
          // the gap between screens. Refresh the profile and surface the
          // styled plan-gate modal at the root — same component the
          // entry-level check uses, so the messaging is consistent.
          await ensureFreshProfile();
          const profile = getCachedProfile();
          const gate = evaluateSummaryGate(profile);
          navigation.popToTop();
          showPlanGate(gate, profile);
          return;
        }
        const msg = e instanceof ApiError ? e.message : String(e);
        Alert.alert('처리 실패', msg, [
          { text: '확인', onPress: () => navigation.popToTop() },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReqId]);

  useEffect(() => {
    // 사장님 정책 (2026-05-22 UX): processing (sync 호출 중) + placeholder polling
    // (background) 둘 다 동안 elapsed 카운트. 5초+ 면 "거의 다 됐어요" 전환.
    if (!processing && !isPlaceholderLog) {
      setProcessingElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setProcessingElapsedMs(Date.now() - startedAt);
    }, 500);
    return () => clearInterval(id);
  }, [processing, isPlaceholderLog]);

  // 사장님 정책 (2026-05-22 §7 placeholder INSERT): server 가 sync 응답에 즉시
  // placeholder customer_log 반환 (summary='AI 분석 중'). callback 후 UPDATE 진행.
  // client 가 placeholder 받으면 polling 으로 fresh summary 받기.
  useEffect(() => {
    if (!customerLog) return;
    // 사장님 정책 (2026-05-22 §7 + 웹팀 답신 §4): server 가 placeholder 마킹에
    // ai_model='pending' / customer_name='처리중...' / summary='AI 분석 중' 사용.
    // 하나라도 일치하면 polling. callback 후 fresh data 받으면 종료.
    const isPlaceholder =
      customerLog.ai_model === 'pending' ||
      customerLog.customer_name === '처리중...' ||
      customerLog.summary === 'AI 분석 중' ||
      (customerLog.summary?.trim() ?? '') === '';
    if (!isPlaceholder) return;
    let cancelled = false;
    let tries = 0;
    const MAX_TRIES = 30;  // 30 * 3s = 90s budget
    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      try {
        const res = await getCustomerLog(customerLog.id);
        if (cancelled) return;
        const fresh = res.customer_log;
        // 사장님 정책 (2026-05-22 웹팀 인계 [4]): callback 순서 N→N-1 역전 또는
        // server cache/cluster lag 로 polling 응답이 stale row 일 가능성 방어.
        // fresh.updated_at < 현재 updated_at 이면 무시하고 다음 tick 으로.
        if (
          fresh.updated_at &&
          customerLog.updated_at &&
          fresh.updated_at < customerLog.updated_at
        ) {
          if (__DEV__) {
            console.log(
              '[SummaryReview] poll stale (updated_at 역전) — skip',
              { fresh: fresh.updated_at, current: customerLog.updated_at },
            );
          }
        } else {
          const stillPlaceholder =
            fresh.ai_model === 'pending' ||
            fresh.customer_name === '처리중...' ||
            fresh.summary === 'AI 분석 중' ||
            (fresh.summary?.trim() ?? '') === '';
          if (!stillPlaceholder) {
            setCustomerLog(fresh);
            if (!userEditedRef.current) {
              setValues(rowToFormValues(fresh));
            }
            return;
          }
        }
      } catch (e) {
        logError('SummaryReview.poll', e, { id: customerLog.id, tries });
      }
      if (tries < MAX_TRIES) {
        setTimeout(() => void tick(), 3000);
      }
    };
    const handle = setTimeout(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [customerLog]);

  // 사장님 정책 (2026-05-21 비상 fix R2): customerLog state 가 stale (다른 통화)
  // 인 경우 render 단에서 차단. useState 가 navigation reuse 에 의해 reset 안 되는
  // 케이스의 final 안전망.
  const displayLog = useMemo<CustomerLogRow | null>(() => {
    if (!customerLog) return null;
    const expected = pendingReqId ?? null;
    const got = customerLog.client_request_id ?? null;
    if (expected && got && expected !== got) {
      return null;  // stale — 이전 통화 잔재
    }
    return customerLog;
  }, [customerLog, pendingReqId]);

  const isPlaceholderLog = useMemo(() => {
    if (!customerLog) return false;
    return (
      customerLog.ai_model === 'pending' ||
      customerLog.customer_name === '처리중...' ||
      customerLog.summary === 'AI 분석 중' ||
      (customerLog.summary?.trim() ?? '') === ''
    );
  }, [customerLog]);
  // 사장님 정책 (v35): "처리중" / "AI 분석 중" placeholder 텍스트 사장님 눈에
  // 노출 X. placeholder polling 동안에도 LoadingSecretary 유지 → fresh data
  // 받으면 form 표시. CallPostActivity 의 native loading 삭제 + RN LoadingSecretary
  // 단일 loading UI 정책과 짝.
  const showLoading = processing || isPlaceholderLog;

  const dirty = useMemo(() => {
    return Object.keys(diff(original, values)).length > 0;
  }, [original, values]);

  const updateField = useCallback((key: string, val: string) => {
    userEditedRef.current = true;
    setValues(v => ({ ...v, [key]: val }));
  }, []);

  const selectedGroupTitle = useMemo(() => {
    if (!groupId) {
      return '기본 그룹 (자동 생성)';
    }
    const hit = availableGroups.find(g => g.id === groupId);
    return hit?.title ?? '선택된 그룹';
  }, [availableGroups, groupId]);

  const onSave = useCallback(async () => {
    // 사장님 정책 (2026-05-21 비상 fix R2): stale customer_log 로 sendCustomerLogToGroup
    // 호출 차단. displayLog (= reqId 일치 통과한 row) 만 허용. 이전 통화 row 의 id
    // 가 사장님 그룹에 mirror 되는 회귀 방지.
    if (!displayLog) {
      Alert.alert('요약 준비 중', '요약 처리가 완료되면 다시 시도해주세요.');
      return;
    }
    setSaving(true);
    try {
      const override = diff(original, values);
      await sendCustomerLogToGroup({
        id: displayLog.id,
        group_id: groupId,
        override: Object.keys(override).length > 0 ? override : undefined,
      });
      // Native shows the success overlay; it will fire
      // 'successOverlayDismissed' on auto-timeout or "확인" tap, and our
      // listener below pops SummaryReview at the same instant.
      showSuccessOverlay();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert('저장 실패', msg);
    } finally {
      setSaving(false);
    }
  }, [groupId, displayLog, original, values]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      'successOverlayDismissed',
      (returnToHome: boolean) => {
        navigation.popToTop();
        // After confirm or auto-dismiss, send Youngman to the background so
        // the user lands back on whatever app they were in before the call.
        // (The "고객관리 바로가기" path keeps Youngman in the foreground —
        // emits returnToHome=false.)
        if (returnToHome && Platform.OS === 'android') {
          const bridge = (
            NativeModules as { AppBridge?: { moveToBackground: () => void } }
          ).AppBridge;
          try {
            bridge?.moveToBackground();
          } catch {
            // ignore — at worst the user stays in the WebView
          }
        }
      },
    );
    return () => sub.remove();
  }, [navigation]);

  // 사장님 정책 (2026-05-22 UX): "분석 중" / "처리 중" 같은 시스템 상태 표현
  // 노출 금지. 부드러운 비서 어조로.
  const processingHeadline =
    processingElapsedMs > 5000 ? '거의 다 됐어요' : '잠시만 기다려주세요';
  const processingHint =
    processingElapsedMs > 5000 ? '마무리 중이에요…' : '내용을 정리하고 있어요';

  // 사장님 정책 (2026-05-22): 닫기 / 양식전송 후 영맨앱도 같이 background.
  // 사용자 폰 홈으로 자동 — 영맨 사이트 안 보이게.
  const closeAndBackground = useCallback(() => {
    navigation.popToTop();
    if (Platform.OS === 'android') {
      const bridge = (
        NativeModules as { AppBridge?: { moveToBackground: () => void } }
      ).AppBridge;
      try {
        bridge?.moveToBackground();
      } catch {
        // ignore
      }
    }
  }, [navigation]);

  // 사장님 정책 (2026-05-22 웹팀 commit 671177e): form state "닫기" (좌측 헤더,
  // showLoading=false 시점) 시 요약 폐기 확인 alert. "네" → cancel + 닫기,
  // "아니요" → 그냥 닫기.
  const onClose = useCallback(() => {
    const targetId = displayLog?.id;
    if (!targetId) {
      closeAndBackground();
      return;
    }
    Alert.alert(
      '요약내용을 폐기하시겠습니까?',
      '폐기하면 통화 요약과 관련 데이터가 모두 삭제됩니다.',
      [
        { text: '아니요', style: 'cancel', onPress: () => closeAndBackground() },
        {
          text: '네',
          style: 'destructive',
          onPress: () => {
            cancelCustomerLog(targetId).catch(e => {
              logError('SummaryReview.cancel', e, { id: targetId });
            });
            closeAndBackground();
          },
        },
      ],
    );
  }, [displayLog, closeAndBackground]);

  // 사장님 정책 (2026-05-22 PM): loading state 의 캐릭터 우측 상단 X 버튼.
  // 확인 alert 없이 즉시 요약 작업 중지 (cancel endpoint 호출) + 모달 닫기.
  // customerLog (placeholder 든 fresh 든) 있으면 cancel — placeholder 면 server
  // 측 cascade 삭제로 잔해 정리. displayLog 가 아닌 customerLog 사용 (loading
  // 중엔 displayLog 가 placeholder reqId 일치 통과 후 row 라 같음).
  const onLoadingClose = useCallback(() => {
    const targetId = customerLog?.id;
    if (targetId) {
      cancelCustomerLog(targetId).catch(e => {
        logError('SummaryReview.loadingCancel', e, { id: targetId });
      });
    }
    closeAndBackground();
  }, [customerLog, closeAndBackground]);

  // 사장님 정책 (2026-05-22 PM 2차): loading state = 전체 화면 dim + 가운데 카드.
  // form state = 일반 흰 배경. 두 흐름 wrapper 완전 분리해 stack 아래 layer 가
  // 비치는 현상 차단.
  if (showLoading) {
    return (
      <SafeAreaView style={styles.loadingBackdrop} edges={['top', 'bottom']}>
        <Pressable
          onPress={onLoadingClose}
          hitSlop={14}
          style={styles.loadingCloseTopRight}
          accessibilityLabel="요약 작업 중지"
        >
          <Text style={styles.loadingCloseTopRightText}>×</Text>
        </Pressable>
        <View style={styles.loadingCenterBlock}>
          <Text style={styles.aiSummaryTitle}>AI 요약중...</Text>
          <LoadingSecretary size={165} />
          <Text style={styles.processingHeadline}>{processingHeadline}</Text>
          <Text style={styles.processingHint}>{processingHint}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>닫기</Text>
        </Pressable>
        <Pressable onPress={onSave} disabled={saving} hitSlop={12}>
          <Text style={styles.save}>양식 전송</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text style={styles.title}>AI 요약 결과</Text>
        <Text style={styles.subtitle}>
          AI가 정리한 내용이에요. 필요하면 수정해주세요.
        </Text>
        {displayLog && (
          <View style={styles.metaCard}>
            <Text style={styles.metaText}>
              상담일시{' '}
              {new Date(displayLog.consult_at).toLocaleString('ko-KR')}
            </Text>
          </View>
        )}
        {!displayLog && customerLog && (
          <View style={styles.metaCard}>
            <Text style={styles.metaText}>
              이전 통화 정보입니다. 요약 처리가 완료되면 새로 표시됩니다.
            </Text>
          </View>
        )}

        <Text style={styles.groupPickerLabel}>양식을 전송할 그룹</Text>
        <Pressable
          style={styles.groupChip}
          onPress={() => setGroupPickerOpen(true)}
        >
          <Text style={styles.groupChipValue} numberOfLines={1}>
            {selectedGroupTitle}
          </Text>
          <Text style={styles.groupChipChevron}>▾</Text>
        </Pressable>

        {FIELDS.map(f => (
          <View key={f.key} style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>{f.label}</Text>
            <TextInput
              style={[
                styles.input,
                f.multiline ? styles.inputMulti : undefined,
              ]}
              value={values[f.key]}
              onChangeText={t => updateField(f.key, t)}
              placeholder={f.placeholder ?? ''}
              placeholderTextColor="#999"
              multiline={f.multiline}
              textAlignVertical={f.multiline ? 'top' : 'center'}
            />
          </View>
        ))}

        {saving && (
          <View style={styles.savingOverlay}>
            <ActivityIndicator />
            <Text style={styles.savingText}>저장 중…</Text>
          </View>
        )}
      </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={groupPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupPickerOpen(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setGroupPickerOpen(false)}
        >
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>전송 그룹 선택</Text>
            <Text style={styles.sheetSubtitle}>
              고객관리대장의 어느 그룹에 기록할까요?
            </Text>
            <ScrollView style={styles.sheetList} bounces={false}>
              <Pressable
                style={[
                  styles.sheetItem,
                  groupId === null && styles.sheetItemActive,
                ]}
                onPress={() => {
                  setGroupId(null);
                  setGroupPickerOpen(false);
                }}
              >
                <Text style={styles.sheetItemText}>기본 그룹 (자동 생성)</Text>
                {groupId === null && (
                  <Text style={styles.sheetItemCheck}>✓</Text>
                )}
              </Pressable>
              {availableGroups.map(g => (
                <Pressable
                  key={g.id}
                  style={[
                    styles.sheetItem,
                    groupId === g.id && styles.sheetItemActive,
                  ]}
                  onPress={() => {
                    setGroupId(g.id);
                    setGroupPickerOpen(false);
                  }}
                >
                  <Text style={styles.sheetItemText} numberOfLines={1}>
                    {g.title}
                  </Text>
                  {groupId === g.id && (
                    <Text style={styles.sheetItemCheck}>✓</Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  // 사장님 정책 (v36 2026-05-23): 흰 배경 풀스크린. 카드 디자인 제거 (사장님 명시).
  // LoadingSecretary + 텍스트가 화면 중앙. X 버튼 우상단.
  loadingBackdrop: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  loadingCenterBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 28,
  },
  loadingCloseTopRight: {
    position: 'absolute',
    // 사장님 정책 (v38 2026-05-23): 상단바 겹침 fix. SafeAreaView edges=top
    // 안이지만 추가 여백으로 더 아래로.
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
  // 사장님 정책 (2026-05-22 PM 폰트 다듬기): "AI 요약중..." 메인 타이틀.
  // fontWeight 700 → 600, letterSpacing -0.6 (한글에 부드러운 압축), 색상
  // 살짝 부드러운 톤.
  aiSummaryTitle: {
    fontSize: 21,
    fontWeight: '600',
    color: '#1F1F23',
    letterSpacing: -0.6,
    textAlign: 'center',
    marginBottom: 8,
  },
  flex: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  close: { color: '#FF3B30', fontSize: 15 },
  save: { color: '#0066FF', fontSize: 15, fontWeight: '700' },
  saveInactive: { color: '#999' },
  body: { padding: 24, paddingBottom: 64 },
  title: { fontSize: 22, fontWeight: '700', color: '#111' },
  subtitle: { fontSize: 14, color: '#666666', marginTop: 6, lineHeight: 20 },
  metaCard: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#F5F5F7',
    borderRadius: 8,
  },
  metaText: { color: '#666666', fontSize: 13, marginVertical: 1 },
  // 사장님 정책 (2026-05-22 PM): 캐릭터 + 텍스트를 화면 중앙. ScrollView 의
  // contentContainerStyle 이 flexGrow:1 + justifyContent:center 면 화면 중앙
  // 정렬 가능. processingBody 자체는 alignItems center 만.
  processingBody: {
    alignItems: 'center',
    gap: 16,
  },
  // showLoading 일 때 ScrollView body 가 화면 전체 차지 + 자식 중앙 정렬.
  bodyLoading: {
    flexGrow: 1,
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  // 사장님 정책 (2026-05-22 PM 폰트 다듬기): 부드러운 semibold + 압축 자간.
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
  fieldBlock: { marginTop: 16 },
  fieldLabel: { fontSize: 13, color: '#666666', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#DCDCDC',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
    backgroundColor: '#FFFFFF',
  },
  inputMulti: { minHeight: 80, paddingVertical: 12 },
  savingOverlay: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
    gap: 8,
  },
  savingText: { color: '#666' },
  groupPickerLabel: {
    marginTop: 16,
    fontSize: 13,
    color: '#666666',
    marginBottom: 6,
  },
  groupChip: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DCDCDC',
    backgroundColor: '#F5F5F7',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  groupChipValue: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#111111',
  },
  groupChipChevron: { fontSize: 13, color: '#888888' },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: '#111' },
  sheetSubtitle: { marginTop: 4, fontSize: 13, color: '#666' },
  sheetList: { marginTop: 16 },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  sheetItemActive: { backgroundColor: '#EFF4FF' },
  sheetItemText: { flex: 1, fontSize: 15, color: '#111' },
  sheetItemCheck: { fontSize: 16, color: '#0066FF', fontWeight: '700' },
});
