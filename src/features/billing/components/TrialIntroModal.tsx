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
 * One-shot intro for new users with plan_status === 'trialing'. AsyncStorage
 * flag ensures one-time display per device. Visual matches the post-call
 * overlay style (overlay_recording_found.xml): white card, 14dp radius,
 * hairline-divided bottom buttons.
 */
export const TrialIntroModal: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [profile, setProfile] = useState<AuthProfile | null>(
    getCachedProfile(),
  );

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      BILLING_PROFILE_UPDATED_EVENT,
      (p: AuthProfile) => setProfile(p),
    );
    return () => sub.remove();
  }, []);

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
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.body}>
            <Text style={styles.title}>{remaining}회 무료 체험을 드려요</Text>
            <Text style={styles.subtitle}>
              영맨을 처음 시작하셨군요!{'\n'}
              통화 AI 요약 기능을 {remaining}회 무료로 사용해보세요.
            </Text>
          </View>

          <View style={styles.hairline} />

          <View style={styles.buttonRow}>
            <Pressable style={styles.button} onPress={() => void onDismiss()}>
              <Text style={styles.buttonNeutral}>지금 사용해보기</Text>
            </Pressable>
            <View style={styles.verticalHairline} />
            <Pressable style={styles.button} onPress={() => void onUpgrade()}>
              <Text style={styles.buttonPrimary}>요금제 보기</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

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
    paddingTop: 22,
    paddingBottom: 20,
    alignItems: 'center',
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
    marginTop: 8,
    lineHeight: 19,
    letterSpacing: -0.1,
  },
  hairline: { height: 1, backgroundColor: '#E5E5E5' },
  verticalHairline: { width: 1, backgroundColor: '#E5E5E5' },
  buttonRow: { flexDirection: 'row', height: 46 },
  button: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonNeutral: { fontSize: 15, color: '#666666' },
  buttonPrimary: { fontSize: 15, fontWeight: '700', color: '#0066FF' },
});
