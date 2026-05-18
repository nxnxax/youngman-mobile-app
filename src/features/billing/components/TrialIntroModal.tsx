import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
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

const SEEN_KEY = '@youngman/trialIntroSeen.v1';

/**
 * One-shot intro for new users on the trial plan — "통화 AI 요약 5회 체험"
 * card. Surfaces the moment we first observe `plan_status === 'trialing'`
 * for this device, then stays dismissed (AsyncStorage flag).
 *
 * Mounted globally inside WebViewHost so it can fire regardless of which
 * screen the user is on at the time of first-load.
 */
export const TrialIntroModal: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [profile, setProfile] = useState<AuthProfile | null>(
    getCachedProfile(),
  );

  // Track the latest profile — modal is gated on plan_status === 'trialing'.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      BILLING_PROFILE_UPDATED_EVENT,
      (p: AuthProfile) => setProfile(p),
    );
    return () => sub.remove();
  }, []);

  // When a fresh trialing profile arrives, decide whether to show.
  useEffect(() => {
    if (!profile) return;
    if (profile.plan_status !== 'trialing') return;
    void (async () => {
      const seen = await AsyncStorage.getItem(SEEN_KEY);
      if (seen === '1') return;
      setVisible(true);
    })();
  }, [profile]);

  const onDismiss = async () => {
    await AsyncStorage.setItem(SEEN_KEY, '1');
    setVisible(false);
  };

  const onUpgrade = async () => {
    await AsyncStorage.setItem(SEEN_KEY, '1');
    setVisible(false);
    void Linking.openURL('youngman://record/subscribe');
  };

  const remaining =
    profile && profile.summary_limit != null
      ? Math.max(0, profile.summary_limit - profile.summary_used)
      : 5;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => void onDismiss()}
    >
      <Pressable style={styles.backdrop} onPress={() => void onDismiss()}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.heart}>
            <Text style={styles.heartText}>🎁</Text>
          </View>
          <Text style={styles.title}>5회 무료 체험을 드려요</Text>
          <Text style={styles.body}>
            영맨을 처음 시작하셨군요!{'\n'}
            지금부터 통화 AI 요약 기능을 {remaining}회 무료로 사용해보실 수 있어요.
          </Text>
          <View style={styles.featureBox}>
            <Feature text="통화 자동 감지 + 한 번에 양식 전송" />
            <Feature text="고객별 통화 이력 + 핵심 요약 자동 정리" />
            <Feature text="다음 통화 때 상대 정보 자동 표시" />
          </View>
          <Pressable style={styles.primary} onPress={() => void onDismiss()}>
            <Text style={styles.primaryText}>지금 사용해보기</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => void onUpgrade()}>
            <Text style={styles.secondaryText}>요금제 자세히 보기</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const Feature: React.FC<{ text: string }> = ({ text }) => (
  <View style={styles.featureRow}>
    <Text style={styles.featureBullet}>•</Text>
    <Text style={styles.featureText}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  heart: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FFF1E6',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  heartText: { fontSize: 30 },
  title: {
    fontSize: 19,
    fontWeight: '700',
    color: '#111111',
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: '#555555',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  featureBox: {
    width: '100%',
    backgroundColor: '#F5F5F7',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 4 },
  featureBullet: { color: '#0066FF', marginRight: 8, fontSize: 14 },
  featureText: { flex: 1, fontSize: 13, color: '#333333', lineHeight: 18 },
  primary: {
    width: '100%',
    paddingVertical: 13,
    backgroundColor: '#0066FF',
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  secondary: {
    width: '100%',
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 6,
  },
  secondaryText: { color: '#666666', fontSize: 13 },
});
