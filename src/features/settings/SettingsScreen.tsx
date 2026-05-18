import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../navigation/types';
import {
  BILLING_PROFILE_UPDATED_EVENT,
  ensureFreshProfile,
  getCachedProfile,
  usageDisplayString,
} from '../../services/billing/billingStore';
import type { AuthProfile } from '../../services/billing/api';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ModalDwell,
  type ModalSound,
  type PopupFrequency,
  getSettings,
  isCallScreeningRoleHeld,
  requestCallScreeningRole,
  updateSettings,
} from '../../services/settings/settings';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Settings'>;

const DWELL_OPTIONS: ReadonlyArray<{ value: ModalDwell; label: string }> = [
  { value: 10, label: '10초' },
  { value: 15, label: '15초' },
  { value: 20, label: '20초' },
];

const SOUND_OPTIONS: ReadonlyArray<{ value: ModalSound; label: string }> = [
  { value: 'on', label: '알림음' },
  { value: 'off', label: '무음' },
];

const FREQUENCY_OPTIONS: ReadonlyArray<{
  value: PopupFrequency;
  label: string;
  hint?: string;
}> = [
  { value: 'always', label: '항상 (현재 동작)' },
  {
    value: 'formal',
    label: '존댓말을 사용한 통화만',
    hint: '통화 분석 후 모달이 떠서 30~60초 지연됩니다',
  },
  {
    value: 'keyword',
    label: '특정 단어 인식 시',
    hint: '아래 단어 목록 중 하나라도 통화에서 나오면 모달 표시',
  },
];

export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [keywordsDraft, setKeywordsDraft] = useState<string>(
    DEFAULT_SETTINGS.keywords,
  );
  const [screeningRoleHeld, setScreeningRoleHeld] = useState<boolean>(false);
  const [profile, setProfile] = useState<AuthProfile | null>(
    getCachedProfile(),
  );

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setSettings(s);
      setKeywordsDraft(s.keywords);
      setScreeningRoleHeld(await isCallScreeningRoleHeld());
      // Refresh plan/usage so the indicator on this screen matches reality —
      // user may have just upgraded or used their last summary.
      const fresh = await ensureFreshProfile();
      if (fresh) setProfile(fresh);
    })();
  }, []);

  // Subscribe to billing updates — covers the case where the user upgrades
  // via /billing.html?success=1 while this screen is open in the background.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      BILLING_PROFILE_UPDATED_EVENT,
      (p: AuthProfile) => setProfile(p),
    );
    return () => sub.remove();
  }, []);

  // Re-check the screener role whenever the screen comes back into view —
  // the user may have flipped it in system Settings.
  useEffect(() => {
    const unsub = navigation.addListener('focus', async () => {
      setScreeningRoleHeld(await isCallScreeningRoleHeld());
    });
    return unsub;
  }, [navigation]);

  const onOpenBilling = useCallback(() => {
    // Hand off to WebViewHost via deep link. The host pops back to the
    // root WebView screen and navigates the WebView to /billing.html where
    // the web team renders the plan + subscription management page.
    void Linking.openURL('youngman://record/billing');
  }, []);

  const onOpenSubscribe = useCallback(() => {
    void Linking.openURL('youngman://record/subscribe');
  }, []);

  const onOpenPolicy = useCallback((page: string) => {
    void Linking.openURL(`youngman://record/policy?page=${page}`);
  }, []);

  const onRequestScreening = useCallback(async () => {
    await requestCallScreeningRole();
    // Refresh — RoleManager dialog returns asynchronously; the focus listener
    // above will recheck when the user returns from the system dialog too.
    setTimeout(async () => {
      setScreeningRoleHeld(await isCallScreeningRoleHeld());
    }, 500);
  }, []);

  const patch = useCallback(async (next: Partial<AppSettings>) => {
    const saved = await updateSettings(next);
    setSettings(saved);
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>설정</Text>
        <Pressable
          style={styles.headerCloseBtn}
          onPress={() => navigation.goBack()}
          hitSlop={12}
        >
          <Text style={styles.close}>저장 및 닫기</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Section
          title="내 플랜 / 구독 관리"
          footer={planSectionFooter(profile)}
        >
          <Pressable style={styles.row} onPress={onOpenBilling}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{planRowLabel(profile)}</Text>
              <Text style={styles.rowHint}>
                {usageDisplayString(profile) ?? '결제 정보 확인'}
              </Text>
            </View>
            <Text style={styles.rowCheck}>›</Text>
          </Pressable>
          {shouldShowUpgrade(profile) && (
            <Pressable style={styles.row} onPress={onOpenSubscribe}>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, styles.rowLabelAccent]}>
                  요금제 비교 / 업그레이드
                </Text>
                <Text style={styles.rowHint}>
                  Plus 월 19,000원 · Pro 월 39,000원
                </Text>
              </View>
              <Text style={styles.rowCheck}>›</Text>
            </Pressable>
          )}
        </Section>

        <Section title="모달 자동 닫힘 시간">
          {DWELL_OPTIONS.map(opt => (
            <Row
              key={opt.value}
              label={opt.label}
              selected={settings.modalDwellSec === opt.value}
              onPress={() => patch({ modalDwellSec: opt.value })}
            />
          ))}
        </Section>

        <Section title="모달 알림음">
          {SOUND_OPTIONS.map(opt => (
            <Row
              key={opt.value}
              label={opt.label}
              selected={settings.modalSound === opt.value}
              onPress={() => patch({ modalSound: opt.value })}
            />
          ))}
        </Section>

        <Section
          title="통화종료 후 모달 빈도"
          footer="존댓말 / 특정 단어 옵션은 통화 분석 후 모달을 띄우므로 30~60초 정도 늦게 표시됩니다."
        >
          {FREQUENCY_OPTIONS.map(opt => (
            <View key={opt.value}>
              <Row
                label={opt.label}
                hint={opt.hint}
                selected={settings.popupFrequency === opt.value}
                onPress={() => patch({ popupFrequency: opt.value })}
              />
              {settings.popupFrequency === 'keyword' &&
                opt.value === 'keyword' && (
                  <View style={styles.keywordBlock}>
                    <Text style={styles.keywordLabel}>
                      인식할 단어 (쉼표로 구분)
                    </Text>
                    <TextInput
                      style={styles.keywordInput}
                      value={keywordsDraft}
                      onChangeText={setKeywordsDraft}
                      onBlur={() => patch({ keywords: keywordsDraft.trim() })}
                      placeholder="사장님, 사모님"
                      placeholderTextColor="#999"
                    />
                  </View>
                )}
            </View>
          ))}
        </Section>

        <Section
          title="영맨 실시간 통화 감지"
          footer="끄면 통화가 끝나도 모달이 뜨지 않습니다. 추후 직접 영맨을 열어 처리하실 수 있습니다."
        >
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>
              {settings.realtimeDetection ? 'ON' : 'OFF'}
            </Text>
            <Switch
              value={settings.realtimeDetection}
              onValueChange={v => patch({ realtimeDetection: v })}
              trackColor={{ false: '#DCDCDC', true: '#FFCC00' }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Section>

        <Section
          title="수신 통화 식별"
          footer={
            screeningRoleHeld
              ? '활성화됨. 저장된 고객 번호로 전화가 오면 화면 상단에 작은 카드가 표시됩니다.'
              : '활성화하려면 영맨을 기본 발신번호 표시 앱으로 지정해야 합니다. (시스템 설정 화면의 카테고리명에 다른 표현이 섞여있어도, 영맨은 차단 기능을 쓰지 않고 오직 고객 식별용으로만 사용합니다.)'
          }
        >
          <Pressable style={styles.row} onPress={onRequestScreening}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>
                {screeningRoleHeld
                  ? '✓ 활성화됨 — 다시 설정하기'
                  : '활성화하기'}
              </Text>
              <Text style={styles.rowHint}>
                {screeningRoleHeld
                  ? '필요하면 시스템 설정에서 해제 가능'
                  : '시스템 dialog 또는 기본 앱 설정 화면이 열립니다'}
              </Text>
            </View>
            <Text style={styles.rowCheck}>›</Text>
          </Pressable>
        </Section>

        <Section
          title="약관 / 정책"
          footer="어센트라(Ascentra) · 사업자등록번호 393-39-01518 · 대표 장동훈 · 경기도 화성시 효행로 30, 202호 · nxnxax@gmail.com"
        >
          <PolicyRow label="이용약관" onPress={() => onOpenPolicy('terms')} />
          <PolicyRow
            label="개인정보처리방침"
            onPress={() => onOpenPolicy('privacy')}
          />
          <PolicyRow label="환불정책" onPress={() => onOpenPolicy('refund')} />
          <PolicyRow
            label="자동결제 안내"
            onPress={() => onOpenPolicy('auto-billing')}
          />
        </Section>

        <View style={styles.spacer} />
      </ScrollView>
    </SafeAreaView>
  );
};

// === plan helpers ===================================================

function planLabel(profile: AuthProfile | null): string {
  if (!profile) return '플랜 정보 확인 중…';
  switch (profile.plan) {
    case 'free':
      return 'Free 플랜';
    case 'plus':
      return 'Plus 플랜';
    case 'pro':
      return 'Pro 플랜';
    case 'premium':
      // Legacy users grandfathered from pre-PortOne — treat as Pro.
      return 'Pro 플랜';
    case 'trialing':
      return '무료 체험 중';
    default:
      return '플랜 정보 확인 중…';
  }
}

function planRowLabel(profile: AuthProfile | null): string {
  return `현재 플랜 · ${planLabel(profile)}`;
}

function planSectionFooter(profile: AuthProfile | null): string {
  if (!profile) return '결제 시스템 연결 중입니다.';
  if (profile.plan_status === 'past_due') {
    return '결제가 처리되지 않았습니다. 결제 정보를 업데이트해주세요.';
  }
  if (profile.plan_status === 'cancelled') {
    if (profile.current_period_end) {
      return `해지 예정 — ${profile.current_period_end}까지 사용 가능`;
    }
    return '구독이 해지되었습니다.';
  }
  if (profile.plan === 'free' || profile.plan === 'trialing') {
    return 'Plus 또는 Pro 구독으로 통화 AI 요약을 사용할 수 있어요.';
  }
  if (profile.current_period_end) {
    return `다음 결제일 · ${profile.current_period_end}`;
  }
  return '';
}

function shouldShowUpgrade(profile: AuthProfile | null): boolean {
  if (!profile) return false;
  // Show upgrade CTA whenever the user is not already on Pro and not in a
  // past_due/cancelled state where they need to fix billing first.
  if (profile.plan === 'pro' || profile.plan === 'premium') return false;
  if (profile.plan_status === 'past_due') return false;
  return true;
}

interface SectionProps {
  title: string;
  footer?: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, footer, children }) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.sectionCard}>{children}</View>
    {footer && <Text style={styles.sectionFooter}>{footer}</Text>}
  </View>
);

interface RowProps {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}

const Row: React.FC<RowProps> = ({ label, hint, selected, onPress }) => (
  <Pressable style={styles.row} onPress={onPress}>
    <View style={styles.rowText}>
      <Text style={styles.rowLabel}>{label}</Text>
      {hint && <Text style={styles.rowHint}>{hint}</Text>}
    </View>
    {selected && <Text style={styles.rowCheck}>✓</Text>}
  </Pressable>
);

interface PolicyRowProps {
  label: string;
  onPress: () => void;
}

const PolicyRow: React.FC<PolicyRowProps> = ({ label, onPress }) => (
  <Pressable style={styles.row} onPress={onPress}>
    <View style={styles.rowText}>
      <Text style={styles.rowLabel}>{label}</Text>
    </View>
    <Text style={styles.rowCheck}>›</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F7' },
  headerRow: {
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  headerCloseBtn: {
    position: 'absolute',
    left: 16,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  close: { color: '#FF3B30', fontSize: 15 },
  body: { paddingVertical: 16 },
  section: { marginBottom: 24, paddingHorizontal: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666666',
    paddingHorizontal: 4,
    paddingBottom: 6,
    letterSpacing: -0.1,
  },
  sectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    overflow: 'hidden',
  },
  sectionFooter: {
    fontSize: 12,
    color: '#888888',
    paddingHorizontal: 4,
    paddingTop: 6,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, color: '#111111' },
  rowLabelAccent: { color: '#0066FF', fontWeight: '600' },
  rowHint: { fontSize: 12, color: '#888888', marginTop: 3 },
  rowCheck: { fontSize: 16, color: '#0066FF', fontWeight: '700' },
  keywordBlock: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    paddingTop: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  keywordLabel: { fontSize: 12, color: '#666666', marginBottom: 6 },
  keywordInput: {
    borderWidth: 1,
    borderColor: '#DCDCDC',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: '#111',
    backgroundColor: '#FFFFFF',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  switchLabel: { fontSize: 15, color: '#111', fontWeight: '600' },
  spacer: { height: 40 },
});
