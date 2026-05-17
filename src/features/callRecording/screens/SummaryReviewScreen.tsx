import { useNavigation, useRoute } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  RouteProp,
} from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
import { updateCustomerLog } from '../api/records';
import type { CustomerLogPatch, CustomerLogRow } from '../api/types';
import { ApiError } from '../../../services/api/client';

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
  { key: 'interest', label: '관심 내용', multiline: true },
  { key: 'inquiry', label: '문의 사항', multiline: true },
  { key: 'budget_condition', label: '예산/희망 조건', multiline: true },
  { key: 'next_action', label: '다음 액션', multiline: true },
  { key: 'agent_memo', label: '담당자 메모', multiline: true, placeholder: '본인 메모 (선택)' },
];

function rowToFormValues(row: CustomerLogRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    out[f.key] = (row[f.key] ?? '') as string;
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
  const initialRow = route.params.customerLog;
  const original = useMemo(() => rowToFormValues(initialRow), [initialRow]);
  const [values, setValues] = useState<Record<string, string>>(original);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (__DEV__) {
      console.log('[SummaryReview] customer_log.id', initialRow.id);
    }
  }, [initialRow.id]);

  const dirty = useMemo(() => {
    return Object.keys(diff(original, values)).length > 0;
  }, [original, values]);

  const updateField = useCallback((key: string, val: string) => {
    setValues(v => ({ ...v, [key]: val }));
  }, []);

  const onSave = useCallback(async () => {
    if (!dirty) {
      navigation.popToTop();
      return;
    }
    setSaving(true);
    try {
      await updateCustomerLog(initialRow.id, diff(original, values));
      Alert.alert('저장됨', '고객관리대장에 반영됐어요.', [
        { text: '확인', onPress: () => navigation.popToTop() },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert('저장 실패', msg);
    } finally {
      setSaving(false);
    }
  }, [dirty, initialRow.id, navigation, original, values]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => navigation.popToTop()} hitSlop={12}>
          <Text style={styles.close}>닫기</Text>
        </Pressable>
        <Pressable onPress={onSave} disabled={saving} hitSlop={12}>
          <Text style={[styles.save, !dirty && styles.saveInactive]}>
            {dirty ? '저장' : '완료'}
          </Text>
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
          AI가 정리한 내용이에요. 필요하면 수정하고 [저장] 누르세요.
        </Text>

        <View style={styles.metaCard}>
          <Text style={styles.metaText}>
            상담일시 {new Date(initialRow.consult_at).toLocaleString('ko-KR')}
          </Text>
          <Text style={styles.metaText}>모델 {initialRow.ai_model}</Text>
        </View>

        {FIELDS.map(f => (
          <View key={f.key} style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>{f.label}</Text>
            <TextInput
              style={[styles.input, f.multiline ? styles.inputMulti : undefined]}
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
  },
  close: { color: '#666', fontSize: 15 },
  save: { color: '#0066FF', fontSize: 15, fontWeight: '700' },
  saveInactive: { color: '#999' },
  body: { padding: 24, paddingBottom: 64 },
  title: { fontSize: 22, fontWeight: '700', color: '#111' },
  subtitle: { fontSize: 14, color: '#555', marginTop: 6, lineHeight: 20 },
  metaCard: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#F6F8FB',
    borderRadius: 8,
  },
  metaText: { color: '#555', fontSize: 13, marginVertical: 1 },
  fieldBlock: { marginTop: 16 },
  fieldLabel: { fontSize: 13, color: '#444', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#DDD',
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
});
