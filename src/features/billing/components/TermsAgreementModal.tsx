import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { AuthProfile } from '../../../services/billing/api';
import {
  BILLING_PROFILE_UPDATED_EVENT,
  getCachedProfile,
} from '../../../services/billing/billingStore';

const ACCEPT_KEY = '@youngman/termsAccepted.v1';

interface AgreeState {
  terms: boolean;
  privacy: boolean;
  recurring: boolean;
}

/**
 * One-time terms acceptance gate. Surfaces the first time a logged-in
 * profile arrives in the cache and stays mandatory until the user accepts
 * all three required checkboxes. Tapping a row title opens the matching
 * policy page in the WebView (Linking → linkRouter → WebViewHost).
 *
 * Compliance: required for Korean PG / app store (이용약관, 개인정보처리방침,
 * 자동결제 동의). Versioned key (`.v1`) lets us re-prompt when terms change.
 */
export const TermsAgreementModal: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [profile, setProfile] = useState<AuthProfile | null>(
    getCachedProfile(),
  );
  const [agreed, setAgreed] = useState<AgreeState>({
    terms: false,
    privacy: false,
    recurring: false,
  });

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      BILLING_PROFILE_UPDATED_EVENT,
      (p: AuthProfile) => setProfile(p),
    );
    return () => sub.remove();
  }, []);

  // Gate: visible only when we have a logged-in profile AND haven't seen
  // acceptance for this terms version yet.
  useEffect(() => {
    if (!profile) return;
    void (async () => {
      const accepted = await AsyncStorage.getItem(ACCEPT_KEY);
      if (accepted === '1') return;
      setVisible(true);
    })();
  }, [profile]);

  const allAgreed = agreed.terms && agreed.privacy && agreed.recurring;

  const onAcceptAll = () => {
    setAgreed({ terms: true, privacy: true, recurring: true });
  };

  const onSubmit = async () => {
    if (!allAgreed) return;
    await AsyncStorage.setItem(ACCEPT_KEY, '1');
    setVisible(false);
  };

  const onDecline = () => {
    Alert.alert(
      '동의가 필요해요',
      '필수 약관에 동의하지 않으면 영맨을 사용하실 수 없습니다. 동의 후 이용해주세요.',
      [{ text: '확인' }],
    );
  };

  const openPolicy = (page: string) => {
    void Linking.openURL(`youngman://record/policy?page=${page}`);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>약관 동의</Text>
          <Text style={styles.subtitle}>
            영맨 사용을 위해 아래 약관 동의가 필요해요.
          </Text>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
          >
            <Pressable
              style={[styles.allRow, allAgreed && styles.allRowAgreed]}
              onPress={onAcceptAll}
            >
              <View style={[styles.box, allAgreed && styles.boxChecked]}>
                {allAgreed && <Text style={styles.boxCheck}>✓</Text>}
              </View>
              <Text style={[styles.allLabel, allAgreed && styles.allLabelAgreed]}>
                모두 동의합니다
              </Text>
            </Pressable>

            <CheckRow
              checked={agreed.terms}
              label="(필수) 이용약관 동의"
              onToggle={() => setAgreed(a => ({ ...a, terms: !a.terms }))}
              onView={() => openPolicy('terms')}
            />
            <CheckRow
              checked={agreed.privacy}
              label="(필수) 개인정보 수집·이용 동의"
              onToggle={() => setAgreed(a => ({ ...a, privacy: !a.privacy }))}
              onView={() => openPolicy('privacy')}
            />
            <CheckRow
              checked={agreed.recurring}
              label="(필수) 정기결제 (자동결제) 동의"
              onToggle={() =>
                setAgreed(a => ({ ...a, recurring: !a.recurring }))
              }
              onView={() => openPolicy('auto-billing')}
            />

            <Text style={styles.footer}>
              구독 후 매월 자동으로 결제됩니다. 언제든 해지할 수 있으며,
              해지 시 다음 결제일부터 결제가 중단됩니다.
            </Text>
          </ScrollView>

          <Pressable
            style={[styles.primary, !allAgreed && styles.primaryDisabled]}
            onPress={() => void onSubmit()}
            disabled={!allAgreed}
          >
            <Text style={styles.primaryText}>
              {allAgreed ? '동의하고 시작하기' : '필수 항목에 모두 동의해주세요'}
            </Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={onDecline}>
            <Text style={styles.secondaryText}>나중에</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

interface CheckRowProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
  onView: () => void;
}

const CheckRow: React.FC<CheckRowProps> = ({
  checked,
  label,
  onToggle,
  onView,
}) => (
  <View style={styles.row}>
    <Pressable style={styles.rowMain} onPress={onToggle}>
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked && <Text style={styles.boxCheck}>✓</Text>}
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
    </Pressable>
    <Pressable onPress={onView} hitSlop={12}>
      <Text style={styles.rowView}>보기 ›</Text>
    </Pressable>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingTop: 22,
    paddingHorizontal: 22,
    paddingBottom: 18,
    maxHeight: '85%',
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    color: '#111111',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    color: '#666666',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 16,
  },
  list: { maxHeight: 360 },
  listContent: { paddingBottom: 8 },
  allRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5F5F7',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 6,
  },
  allRowAgreed: { backgroundColor: '#EFF4FF' },
  allLabel: { fontSize: 15, fontWeight: '700', color: '#111111', marginLeft: 10 },
  allLabelAgreed: { color: '#0066FF' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  rowLabel: { fontSize: 14, color: '#222222', marginLeft: 10 },
  rowView: { fontSize: 13, color: '#0066FF' },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#CCCCCC',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  boxChecked: { backgroundColor: '#0066FF', borderColor: '#0066FF' },
  boxCheck: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  footer: {
    fontSize: 11,
    color: '#999999',
    marginTop: 8,
    paddingHorizontal: 4,
    lineHeight: 16,
  },
  primary: {
    marginTop: 14,
    paddingVertical: 13,
    backgroundColor: '#0066FF',
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryDisabled: { backgroundColor: '#C5D6FF' },
  primaryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondary: { marginTop: 4, paddingVertical: 10, alignItems: 'center' },
  secondaryText: { color: '#999999', fontSize: 13 },
});
