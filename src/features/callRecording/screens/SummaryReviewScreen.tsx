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
  Modal,
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
import { sendCustomerLogToGroup } from '../api/records';
import type {
  CustomerLogPatch,
  CustomerLogRow,
  LedgerGroup,
} from '../api/types';
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
  const availableGroups: ReadonlyArray<LedgerGroup> =
    route.params.availableGroups ?? [];
  const original = useMemo(() => rowToFormValues(initialRow), [initialRow]);
  const [values, setValues] = useState<Record<string, string>>(original);
  const [saving, setSaving] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(() => {
    if (route.params.groupId !== undefined) {
      return route.params.groupId;
    }
    const main = (route.params.availableGroups ?? []).find(g => g.is_main);
    return main?.id ?? null;
  });
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);

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

  const selectedGroupTitle = useMemo(() => {
    if (!groupId) {
      return '기본 그룹 (자동 생성)';
    }
    const hit = availableGroups.find(g => g.id === groupId);
    return hit?.title ?? '선택된 그룹';
  }, [availableGroups, groupId]);

  const onSave = useCallback(async () => {
    setSaving(true);
    try {
      const override = diff(original, values);
      await sendCustomerLogToGroup({
        id: initialRow.id,
        group_id: groupId,
        override: Object.keys(override).length > 0 ? override : undefined,
      });
      Alert.alert('저장됨', '고객관리대장에 반영됐어요.', [
        { text: '확인', onPress: () => navigation.popToTop() },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      Alert.alert('저장 실패', msg);
    } finally {
      setSaving(false);
    }
  }, [groupId, initialRow.id, navigation, original, values]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => navigation.popToTop()} hitSlop={12}>
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
          AI가 정리한 내용이에요. 필요하면 수정하고 [저장] 누르세요.
        </Text>

        <View style={styles.metaCard}>
          <Text style={styles.metaText}>
            상담일시 {new Date(initialRow.consult_at).toLocaleString('ko-KR')}
          </Text>
          <Text style={styles.metaText}>모델 {initialRow.ai_model}</Text>
        </View>

        <Pressable
          style={styles.groupChip}
          onPress={() => setGroupPickerOpen(true)}
        >
          <Text style={styles.groupChipLabel}>전송 그룹</Text>
          <Text style={styles.groupChipValue} numberOfLines={1}>
            {selectedGroupTitle}
          </Text>
          <Text style={styles.groupChipChevron}>▾</Text>
        </Pressable>

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
  groupChip: {
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  groupChipLabel: { fontSize: 13, color: '#666' },
  groupChipValue: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#0066FF',
  },
  groupChipChevron: { fontSize: 14, color: '#999' },
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
