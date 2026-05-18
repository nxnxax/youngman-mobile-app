import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  Linking,
  Modal,
  Pressable,
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
}

/**
 * One-time terms acceptance gate. Surfaces the first time a logged-in
 * profile arrives in the cache and stays mandatory until the user accepts
 * the two basic compliance items (이용약관 + 개인정보처리방침).
 *
 * Does NOT collect 자동결제 동의 here — PortOne checkout itself includes the
 * recurring-billing consent step inside its 토스 결제창. Asking up front
 * would scare off free-tier users who aren't ready to commit to billing.
 *
 * Versioned key (`.v1`) so future terms revisions can re-prompt by bumping.
 *
 * Visual: matches the post-call overlay (overlay_recording_found.xml) —
 * 14dp rounded white card, hairline-divided horizontal action buttons at
 * the bottom, iOS-alert aesthetic.
 */
export const TermsAgreementModal: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [profile, setProfile] = useState<AuthProfile | null>(
    getCachedProfile(),
  );
  const [agreed, setAgreed] = useState<AgreeState>({
    terms: false,
    privacy: false,
  });

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      BILLING_PROFILE_UPDATED_EVENT,
      (p: AuthProfile) => setProfile(p),
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!profile) return;
    void (async () => {
      const accepted = await AsyncStorage.getItem(ACCEPT_KEY);
      if (accepted === '1') return;
      setVisible(true);
    })();
  }, [profile]);

  const allAgreed = agreed.terms && agreed.privacy;

  const onToggleAll = () => {
    const next = !allAgreed;
    setAgreed({ terms: next, privacy: next });
  };

  const onSubmit = async () => {
    if (!allAgreed) {
      Alert.alert('동의가 필요해요', '필수 항목에 모두 동의해주세요.');
      return;
    }
    await AsyncStorage.setItem(ACCEPT_KEY, '1');
    setVisible(false);
  };

  const onLater = () => {
    Alert.alert(
      '동의가 필요해요',
      '필수 약관에 동의하지 않으면 영맨을 사용하실 수 없습니다.',
      [{ text: '확인' }],
    );
  };

  const openPolicy = (page: string) => {
    void Linking.openURL(`youngman://record/policy?page=${page}`);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onLater}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.body}>
            <Text style={styles.title}>영맨 시작 전 안내</Text>
            <Text style={styles.subtitle}>아래 약관을 확인하고 동의해주세요.</Text>

            <Pressable style={styles.allRow} onPress={onToggleAll}>
              <View style={[styles.box, allAgreed && styles.boxChecked]}>
                {allAgreed && <Text style={styles.boxCheck}>✓</Text>}
              </View>
              <Text style={styles.allLabel}>전체 동의</Text>
            </Pressable>

            <View style={styles.hairlineLight} />

            <CheckRow
              checked={agreed.terms}
              label="이용약관 동의 (필수)"
              onToggle={() => setAgreed(a => ({ ...a, terms: !a.terms }))}
              onView={() => openPolicy('terms')}
            />
            <CheckRow
              checked={agreed.privacy}
              label="개인정보 수집·이용 동의 (필수)"
              onToggle={() => setAgreed(a => ({ ...a, privacy: !a.privacy }))}
              onView={() => openPolicy('privacy')}
            />
          </View>

          <View style={styles.hairline} />

          <View style={styles.buttonRow}>
            <Pressable style={styles.button} onPress={onLater}>
              <Text style={styles.buttonCancel}>나중에</Text>
            </Pressable>
            <View style={styles.verticalHairline} />
            <Pressable style={styles.button} onPress={() => void onSubmit()}>
              <Text
                style={[
                  styles.buttonPrimary,
                  !allAgreed && styles.buttonDisabled,
                ]}
              >
                동의하고 시작
              </Text>
            </Pressable>
          </View>
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
      <Text style={styles.rowView}>보기</Text>
    </Pressable>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    overflow: 'hidden',
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    color: '#666666',
    textAlign: 'center',
    marginTop: 4,
    letterSpacing: -0.1,
  },
  allRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingVertical: 4,
  },
  allLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111111',
    marginLeft: 10,
  },
  hairlineLight: {
    height: 1,
    backgroundColor: '#EEEEEE',
    marginVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  rowLabel: { fontSize: 13, color: '#333333', marginLeft: 10 },
  rowView: { fontSize: 12, color: '#0066FF' },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#CCCCCC',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  boxChecked: { backgroundColor: '#0066FF', borderColor: '#0066FF' },
  boxCheck: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  hairline: { height: 1, backgroundColor: '#E5E5E5' },
  verticalHairline: { width: 1, backgroundColor: '#E5E5E5' },
  buttonRow: { flexDirection: 'row', height: 46 },
  button: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonCancel: { fontSize: 15, color: '#666666' },
  buttonPrimary: { fontSize: 15, fontWeight: '700', color: '#0066FF' },
  buttonDisabled: { color: '#B0C7E8' },
});
