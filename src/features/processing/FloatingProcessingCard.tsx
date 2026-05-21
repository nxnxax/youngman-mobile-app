import React, { useEffect, useState } from 'react';
import {
  Animated,
  DeviceEventEmitter,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { isRetrying, isTerminal } from '../callRecording/api/jobStatus';
import {
  type ActiveJob,
  clearActiveJob,
  getActiveJob,
  JOB_STORE_UPDATED_EVENT,
} from './jobStore';

/**
 * Floating card pinned to the top of the WebViewHost. Stays visible while
 * an AI summary job is processing in the background. Lets the user keep
 * using the main WebView (web menu / dashboard / 고객관리대장) without losing
 * the in-flight context.
 *
 * Visual notes:
 *  - White card, 14dp rounded — matches the post-call modal language
 *  - Heart accent re-uses the brand mark from overlay_recording_found.xml
 *  - Auto-dismisses 3s after `completed`; `failed_permanent` requires user
 *    tap (so the error message isn't missed)
 */

const AUTO_DISMISS_AFTER_COMPLETED_MS = 3_000;

export const FloatingProcessingCard: React.FC = () => {
  const [active, setActive] = useState<ActiveJob | null>(getActiveJob());
  const slideAnim = React.useRef(new Animated.Value(-100)).current;

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      JOB_STORE_UPDATED_EVENT,
      (payload: ActiveJob | null) => setActive(payload),
    );
    return () => sub.remove();
  }, []);

  // Slide in / out animation.
  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: active ? 0 : -100,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, slideAnim]);

  // Auto-dismiss on successful completion. failure stays sticky so the
  // user actually reads the message.
  useEffect(() => {
    if (!active?.job) return;
    if (active.job.status !== 'completed') return;
    const t = setTimeout(() => {
      clearActiveJob();
    }, AUTO_DISMISS_AFTER_COMPLETED_MS);
    return () => clearTimeout(t);
  }, [active?.job?.status]);

  if (!active) return null;

  const status = active.job?.status;
  const progressPct = active.job?.progress_pct ?? 5;
  const stepLabel = active.job?.step_label ?? '대기 중...';
  const terminal = status ? isTerminal(status) : false;
  const failed = status === 'failed' || status === 'failed_permanent';
  const retrying = status ? isRetrying(status) : false;
  const succeeded = status === 'completed';

  const accent = failed ? '#FF3B30' : succeeded ? '#34C759' : '#0066FF';

  return (
    <Animated.View
      style={[styles.wrapper, { transform: [{ translateY: slideAnim }] }]}
      pointerEvents="box-none"
    >
      <Pressable
        style={styles.card}
        onPress={() => {
          if (terminal) clearActiveJob();
        }}
      >
        <View style={styles.headerRow}>
          <Text style={styles.brand}>
            <Text style={styles.heart}>❤︎ </Text>
            {active.metadata.displayName}{' '}
            <Text style={styles.brandLight}>통화 요약</Text>
          </Text>
          {terminal && (
            <Pressable hitSlop={12} onPress={() => clearActiveJob()}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.max(progressPct, 4)}%`, backgroundColor: accent },
            ]}
          />
        </View>

        <Text style={[styles.stepLabel, failed && { color: '#FF3B30' }]}>
          {stepLabel}
          {!terminal && !retrying && (
            <Text style={styles.hint}>{'  ·  백그라운드 OK'}</Text>
          )}
        </Text>
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 50,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  brandLight: { color: '#666666', fontWeight: '500' },
  heart: { color: '#E53935' },
  close: { color: '#888888', fontSize: 16, paddingHorizontal: 4 },
  progressTrack: {
    height: 4,
    backgroundColor: '#EEEEEE',
    borderRadius: 2,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressFill: { height: 4, borderRadius: 2 },
  stepLabel: {
    marginTop: 6,
    fontSize: 12,
    color: '#444444',
    letterSpacing: -0.1,
  },
  hint: { color: '#888888', fontSize: 11 },
});
