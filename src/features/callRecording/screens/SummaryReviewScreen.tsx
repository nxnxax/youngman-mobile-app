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
import { processRecording } from '../api/processRecording';
import { sendCustomerLogToGroup } from '../api/records';
import type {
  CustomerLogPatch,
  CustomerLogRow,
  LedgerGroup,
} from '../api/types';
import { ApiError } from '../../../services/api/client';
import { showSuccessOverlay } from '../../../services/overlay/showSuccessOverlay';

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
  const startedRef = useRef(false);

  useEffect(() => {
    if (__DEV__ && customerLog) {
      console.log('[SummaryReview] customer_log.id', customerLog.id);
    }
  }, [customerLog]);

  // Kick off processRecording exactly once when we land in pending mode.
  useEffect(() => {
    if (!params.pendingJob || customerLog) return;
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await processRecording(params.pendingJob!);
        if (cancelled) return;
        setCustomerLog(res.customer_log);
        if (!userEditedRef.current) {
          setValues(rowToFormValues(res.customer_log));
        }
        setProcessing(false);
      } catch (e) {
        if (cancelled) return;
        setProcessing(false);
        if (e instanceof ApiError && e.code === 'plan_required') {
          Alert.alert(
            'Premium 구독이 필요해요',
            '무료 체험 횟수가 끝났습니다.',
            [{ text: '확인', onPress: () => navigation.popToTop() }],
          );
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
  }, []);

  useEffect(() => {
    if (!processing) {
      setProcessingElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setProcessingElapsedMs(Date.now() - startedAt);
    }, 500);
    return () => clearInterval(id);
  }, [processing]);

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
    if (!customerLog) return; // guard: form is not interactive while pending
    setSaving(true);
    try {
      const override = diff(original, values);
      await sendCustomerLogToGroup({
        id: customerLog.id,
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
  }, [groupId, customerLog, original, values]);

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

  const processingHeadline =
    processingElapsedMs > 5000 ? '거의 다 됐어요' : 'AI가 통화 내용 분석 중';
  const processingHint =
    processingElapsedMs > 5000 ? '마무리 중이에요…' : '약 7초 정도 걸려요';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => navigation.popToTop()} hitSlop={12}>
          <Text style={styles.close}>닫기</Text>
        </Pressable>
        {!processing && (
          <Pressable onPress={onSave} disabled={saving} hitSlop={12}>
            <Text style={styles.save}>양식 전송</Text>
          </Pressable>
        )}
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
          {processing
            ? 'AI가 통화를 분석하고 있어요. 잠시만 기다려주세요.'
            : 'AI가 정리한 내용이에요. 필요하면 수정해주세요.'}
        </Text>

        {processing ? (
          <View style={styles.processingBody}>
            <ActivityIndicator size="large" color="#0066FF" />
            <Text style={styles.processingHeadline}>{processingHeadline}</Text>
            <Text style={styles.processingHint}>{processingHint}</Text>
          </View>
        ) : (
          <>
            {customerLog && (
              <View style={styles.metaCard}>
                <Text style={styles.metaText}>
                  상담일시{' '}
                  {new Date(customerLog.consult_at).toLocaleString('ko-KR')}
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
          </>
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
  processingBody: {
    marginTop: 48,
    alignItems: 'center',
    gap: 16,
  },
  processingHeadline: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  processingHint: {
    fontSize: 14,
    color: '#666666',
    marginTop: -8,
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
