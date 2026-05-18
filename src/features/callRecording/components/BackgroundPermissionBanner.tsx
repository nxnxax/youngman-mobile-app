import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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
  runtime: boolean | null;
}

// Only the runtime permissions that the core flow (post-call modal) literally
// cannot work without. READ_CONTACTS is requested lazily on first lookup —
// the customer_name_hint hits a graceful fallback otherwise. POST_NOTIFICATIONS
// is auto-prompted by Android the first time a notification is posted.
// READ_CALL_LOG is no longer needed (CallScreeningService delivers number).
const RUNTIME_PERMISSIONS_BASE = [
  PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
  PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
];

function runtimePermissions(): ReadonlyArray<string> {
  if (Platform.OS !== 'android') return [];
  return RUNTIME_PERMISSIONS_BASE;
}

async function allRuntimePermissionsGranted(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  for (const p of runtimePermissions()) {
    const ok = await PermissionsAndroid.check(p);
    if (!ok) return false;
  }
  return true;
}

// Session-scoped flag — auto-trigger the runtime permission dialog once per
// app process so a fresh-install user gets the dialog without tapping the
// card. After the user accepts or declines, subsequent app launches won't
// re-prompt within the same session. (Hard-declined: system won't show the
// dialog anyway. Granted: nothing to do. Soft-declined: user can tap the
// card button to re-request.)
let autoRequestedThisSession = false;

export const BackgroundPermissionBanner: React.FC = () => {
  const [state, setState] = useState<PermState>({
    battery: null,
    overlay: null,
    runtime: null,
  });
  const [requesting, setRequesting] = useState(false);

  const refresh = useCallback(async () => {
    const [battery, overlay, runtime] = await Promise.all([
      getBackgroundStatus(),
      hasOverlayPermission(),
      allRuntimePermissionsGranted(),
    ]);
    setState({ battery, overlay, runtime });
  }, []);

  useEffect(() => {
    void refresh();

    // Auto-fire the runtime-permission dialogs about a second after the app
    // first opens — saves the user from having to tap the onboarding card.
    // Once-per-session guard prevents re-prompting on every WebView remount.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (Platform.OS === 'android' && !autoRequestedThisSession) {
      autoRequestedThisSession = true;
      timer = setTimeout(async () => {
        const ok = await allRuntimePermissionsGranted();
        if (!ok) {
          try {
            await PermissionsAndroid.requestMultiple(
              runtimePermissions() as string[],
            );
            void refresh();
          } catch {
            // ignore — the card's button is still a manual fallback
          }
        }
      }, 1000);
    }

    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {
        void refresh();
      }
    });

    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [refresh]);

  const battery = state.battery;
  const overlay = state.overlay;
  const runtime = state.runtime;
  if (battery == null || overlay == null || runtime == null) {
    return null;
  }

  const batteryOk =
    battery.status === 'unrestricted' || battery.status === 'unknown';
  const overlayOk = overlay === true;
  const runtimeOk = runtime === true;

  // CallScreening role is intentionally NOT in the first-run onboarding —
  // it only affects the incoming-call banner, and surfacing it on first open
  // forces the user to either deal with the "Caller ID & spam" system screen
  // before they ever see the app, or to walk through one more permission. The
  // user enables it on demand from Settings → 수신 통화 식별 when ready.
  if (batteryOk && overlayOk && runtimeOk) {
    return null;
  }

  const cards: React.ReactNode[] = [];

  // Runtime permissions go FIRST — without them the rest of the flow
  // (post-call modal, incoming-call identification) physically can't work.
  if (!runtimeOk) {
    cards.push(
      <View key="runtime" style={styles.card}>
        <Text style={styles.title}>✨ 영맨 사용을 위해 한 번만 설정해주세요</Text>
        <Text style={styles.body}>
          영맨이 쓰는 권한과 사유를 미리 알려드려요. 이 정보는 영맨 안에서만 쓰이고, 다른 곳으로 전송되지 않습니다.
        </Text>

        <View style={styles.reasonBox}>
          <Text style={styles.reasonLine}>
            <Text style={styles.reasonLabel}>• 오디오 파일 </Text>
            <Text style={styles.reasonText}>— 통화녹음 파일을 찾아 AI 요약</Text>
          </Text>
          <Text style={styles.reasonLine}>
            <Text style={styles.reasonLabel}>• 전화 상태 </Text>
            <Text style={styles.reasonText}>— 통화 시작/종료 감지</Text>
          </Text>
        </View>

        <Pressable
          style={[styles.primaryButton, requesting && styles.buttonDisabled]}
          onPress={async () => {
            setRequesting(true);
            try {
              await PermissionsAndroid.requestMultiple(
                runtimePermissions() as string[],
              );
            } finally {
              setRequesting(false);
            }
          }}
          disabled={requesting}
        >
          <Text style={styles.primaryButtonText}>
            한 번에 권한 허용하기 (최초 1회만)
          </Text>
        </Pressable>
      </View>,
    );
  }

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
  reasonBox: {
    marginTop: 10,
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F0DBA8',
    gap: 4,
  },
  reasonLine: {
    fontSize: 13,
    lineHeight: 19,
    color: '#5A3A00',
  },
  reasonLabel: { fontWeight: '700' },
  reasonText: { color: '#5A3A00' },
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
