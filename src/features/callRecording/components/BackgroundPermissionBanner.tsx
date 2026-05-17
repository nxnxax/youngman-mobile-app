import React, { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  getBackgroundStatus,
  hasOverlayPermission,
  openAppSettings,
  requestIgnoreBatteryOptimizations,
  requestOverlayPermission,
  type BackgroundStatusInfo,
} from '../../../services/system/backgroundRestriction';

interface PermState {
  battery: BackgroundStatusInfo | null;
  overlay: boolean | null;
}

export const BackgroundPermissionBanner: React.FC = () => {
  const [state, setState] = useState<PermState>({ battery: null, overlay: null });
  const [requesting, setRequesting] = useState(false);

  const refresh = useCallback(async () => {
    const [battery, overlay] = await Promise.all([
      getBackgroundStatus(),
      hasOverlayPermission(),
    ]);
    setState({ battery, overlay });
  }, []);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {
        void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh]);

  const battery = state.battery;
  const overlay = state.overlay;
  if (battery == null || overlay == null) {
    return null;
  }

  const batteryOk =
    battery.status === 'unrestricted' || battery.status === 'unknown';
  const overlayOk = overlay === true;

  if (batteryOk && overlayOk) {
    return null;
  }

  const cards: React.ReactNode[] = [];

  if (!overlayOk) {
    cards.push(
      <View key="overlay" style={styles.card}>
        <Text style={styles.title}>✨ 화면 위 알림 권한이 필요해요</Text>
        <Text style={styles.body}>
          통화 종료 직후 영맨이 화면 중앙에 작은 알림 카드를 띄워서 한 번에 처리하게 도와줘요.
          이 권한 없으면 일반 알림으로 fallback 됩니다.
        </Text>
        <Pressable
          style={[styles.primaryButton, requesting && styles.buttonDisabled]}
          onPress={async () => {
            setRequesting(true);
            try {
              await requestOverlayPermission();
            } finally {
              setRequesting(false);
            }
          }}
          disabled={requesting}
        >
          <Text style={styles.primaryButtonText}>화면 위 알림 허용하기 (최초 1회만)</Text>
        </Pressable>
      </View>,
    );
  }

  if (!batteryOk) {
    const isRestricted = battery.status === 'restricted';
    cards.push(
      <View key="battery" style={styles.card}>
        <Text style={styles.title}>
          {isRestricted
            ? '⚠️ 영맨이 백그라운드에서 차단됐어요'
            : '⚠️ 통화 후 알림이 누락될 수 있어요'}
        </Text>
        <Text style={styles.body}>
          {isRestricted
            ? '한 번만 풀어두시면 평생 자동 동작합니다.'
            : '영맨만 절전에서 제외하시면 통화 종료 즉시 안정적으로 알림이 떠요. 폰 전체 배터리 성능에는 영향 없습니다.'}
        </Text>

        <View style={styles.usageBox}>
          <Text style={styles.usageTitle}>💡 영맨의 배터리 사용량</Text>
          <Text style={styles.usageBody}>
            통화 끝난 직후 약 30초만 동작하고 그 외엔 잠자기 때문에
            하루 배터리 사용량은 보통 1% 미만입니다.
          </Text>
        </View>

        <Pressable
          style={[styles.primaryButton, requesting && styles.buttonDisabled]}
          onPress={async () => {
            setRequesting(true);
            try {
              if (isRestricted) {
                await openAppSettings();
                Alert.alert(
                  '영맨 배터리 설정 안내',
                  '"배터리" → "제한 없음" (또는 "최적화됨") 으로 바꿔주세요. 영맨 하나만 예외 처리입니다.',
                );
              } else {
                await requestIgnoreBatteryOptimizations();
              }
            } finally {
              setRequesting(false);
            }
          }}
          disabled={requesting}
        >
          <Text style={styles.primaryButtonText}>
            {isRestricted
              ? '영맨 배터리 설정 열기 (최초 1회만)'
              : '영맨만 절전에서 제외하기 (최초 1회만)'}
          </Text>
        </Pressable>

        {battery.isSamsung && (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              Alert.alert(
                'Samsung 폰 추가 설정 안내',
                'Samsung 폰은 별도 절전 기능이 있어요. 영맨을 예외로 등록해두시면 알림이 안정적으로 떠요.\n\n' +
                  '설정 > 디바이스 케어 > 배터리 > 백그라운드 사용 한도\n' +
                  '→ "사용 안 함 앱" 목록에 영맨 추가',
                [{ text: '확인' }],
              );
            }}
          >
            <Text style={styles.secondaryButtonText}>Samsung 추가 설정 안내</Text>
          </Pressable>
        )}
      </View>,
    );
  }

  return <>{cards}</>;
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    backgroundColor: '#FFF4E0',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F0C36D',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#7A4A00',
    marginBottom: 8,
  },
  body: {
    fontSize: 13,
    color: '#5A3A00',
    lineHeight: 19,
  },
  usageBox: {
    marginTop: 12,
    padding: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F0DBA8',
  },
  usageTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#7A4A00',
    marginBottom: 4,
  },
  usageBody: { fontSize: 12, color: '#555', lineHeight: 17 },
  primaryButton: {
    marginTop: 12,
    backgroundColor: '#0066FF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  buttonDisabled: { opacity: 0.5 },
  secondaryButton: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0066FF',
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#0066FF', fontWeight: '600', fontSize: 13 },
});
