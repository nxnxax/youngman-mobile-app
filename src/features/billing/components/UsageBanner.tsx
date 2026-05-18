import React, { useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  Linking,
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

/**
 * Top-of-WebView banner that surfaces the most important plan/usage signal
 * without forcing the user into Settings. Only renders when something is
 * actually actionable — silent on healthy Pro accounts.
 *
 * Priority (highest first):
 *   1) past_due       — payment failed, must update card
 *   2) cancelled      — subscription ended, must re-subscribe
 *   3) plus_exhausted — month quota burned, upgrade or wait
 *   4) trial_low      — 2 or fewer trial uses remaining
 */
export const UsageBanner: React.FC = () => {
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

  const view = bannerView(profile);
  if (!view) return null;

  const onPress = () => {
    void Linking.openURL(view.deepLink);
  };

  return (
    <Pressable
      style={[styles.container, { backgroundColor: view.bg }]}
      onPress={onPress}
    >
      <View style={styles.textCol}>
        <Text style={[styles.title, { color: view.fg }]}>{view.title}</Text>
        <Text style={[styles.body, { color: view.fg }]}>{view.body}</Text>
      </View>
      <Text style={[styles.chevron, { color: view.fg }]}>›</Text>
    </Pressable>
  );
};

interface BannerView {
  title: string;
  body: string;
  bg: string;
  fg: string;
  deepLink: string;
}

function bannerView(p: AuthProfile | null): BannerView | null {
  if (!p) return null;

  if (p.plan_status === 'past_due') {
    return {
      title: '결제가 처리되지 않았어요',
      body: '결제 정보를 업데이트해주세요',
      bg: '#FFE4E0',
      fg: '#B00020',
      deepLink: 'youngman://record/billing',
    };
  }
  if (p.plan_status === 'cancelled') {
    return {
      title: '구독이 종료되었어요',
      body: '재구독 후 다시 이용하실 수 있어요',
      bg: '#FFE4E0',
      fg: '#B00020',
      deepLink: 'youngman://record/subscribe',
    };
  }

  const isUnlimited = p.summary_limit == null;
  const remaining = isUnlimited
    ? Number.POSITIVE_INFINITY
    : Math.max(0, (p.summary_limit ?? 0) - p.summary_used);

  if (!isUnlimited && remaining <= 0 && p.plan_status === 'active') {
    return {
      title: '이번 달 한도 모두 사용',
      body: `Plus ${p.summary_used}/${p.summary_limit}회 — Pro로 업그레이드`,
      bg: '#FFF3D6',
      fg: '#7A5A00',
      deepLink: 'youngman://record/subscribe',
    };
  }

  if (p.plan_status === 'trialing' && remaining > 0 && remaining <= 2) {
    return {
      title: `체험 ${remaining}회 남았어요`,
      body: '계속 사용하려면 Plus/Pro 구독을 시작해주세요',
      bg: '#E6F0FF',
      fg: '#003E8A',
      deepLink: 'youngman://record/subscribe',
    };
  }

  return null;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  textCol: { flex: 1 },
  title: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  body: { fontSize: 12, opacity: 0.85 },
  chevron: { fontSize: 18, marginLeft: 8 },
});
