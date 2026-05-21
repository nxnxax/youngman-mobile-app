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
  gateCopy,
  PLAN_GATE_SHOW_EVENT,
  type SummaryGate,
} from '../../../services/billing/gating';

/**
 * Plan-gate modal — replaces the bare `Alert.alert` that used to fire when a
 * blocked user tapped 요약보기 / 양식에 전송. Visual matches the post-call
 * overlay (overlay_recording_found.xml): "영맨 고객관리 비서 ❤️" brand header,
 * gate-specific subtitle/body, and a hairline-divided two-button row.
 *
 * Mounted once at WebViewHost root. Callers fire `showPlanGate(gate, profile)`
 * from anywhere on the JS thread (see services/billing/gating.ts).
 */

interface ShowPayload {
  gate: SummaryGate;
  profile: AuthProfile | null;
}

export const PlanGateModal: React.FC = () => {
  const [payload, setPayload] = useState<ShowPayload | null>(null);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      PLAN_GATE_SHOW_EVENT,
      (p: ShowPayload) => setPayload(p),
    );
    return () => sub.remove();
  }, []);

  const onDismiss = () => setPayload(null);

  const onCta = () => {
    const link = payload && gateCopy(payload.gate, payload.profile).ctaDeepLink;
    setPayload(null);
    if (link) void Linking.openURL(link);
  };

  if (!payload) return null;

  const copy = gateCopy(payload.gate, payload.profile);
  const hasCta = !!copy.cta && !!copy.ctaDeepLink;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.body}>
            <View style={styles.brandRow}>
              <Text style={styles.brand}>영맨 고객관리 비서</Text>
              <Text style={styles.heart}> ❤️</Text>
            </View>
            <Text style={styles.title}>{copy.title}</Text>
            <Text style={styles.subtitle}>{copy.body}</Text>
          </View>

          <View style={styles.hairline} />

          <View style={styles.buttonRow}>
            <Pressable style={styles.button} onPress={onDismiss}>
              <Text style={styles.buttonNeutral}>
                {hasCta ? '나중에' : '확인'}
              </Text>
            </Pressable>
            {hasCta ? (
              <>
                <View style={styles.verticalHairline} />
                <Pressable style={styles.button} onPress={onCta}>
                  <Text style={styles.buttonPrimary}>{copy.cta}</Text>
                </Pressable>
              </>
            ) : null}
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
    paddingTop: 18,
    paddingBottom: 18,
    alignItems: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  heart: { fontSize: 14 },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111111',
    textAlign: 'center',
    marginTop: 10,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 13,
    color: '#666666',
    textAlign: 'center',
    marginTop: 6,
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
  buttonNeutral: { fontSize: 15, color: '#FF3B30' },
  buttonPrimary: { fontSize: 15, fontWeight: '700', color: '#0066FF' },
});
