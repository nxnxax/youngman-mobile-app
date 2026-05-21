// Onboarding 권한 통합 reader / requester.
//
// 메인서비스 4종 (통화 전 모달 / 통화 후 모달 / AI 요약 / 전송) 이 첫 통화부터
// 작동하려면 다음 권한이 전부 있어야 한다:
//
//   runtime         — READ_MEDIA_AUDIO, READ_PHONE_STATE, READ_CONTACTS, POST_NOTIFICATIONS
//   overlay         — SYSTEM_ALERT_WINDOW (Settings.canDrawOverlays)
//   callScreening   — RoleManager ROLE_CALL_SCREENING (default "Caller ID & spam")
//   battery         — REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
//
// 기존 인프라는 BackgroundPermissionBanner / SettingsBridge 에 흩어져 있었고,
// runtime 권한 2개만 자동 요청하던 문제 (2026-05-20 사장님 비상) 를 풀기 위해
// 이 모듈이 단일 진입점으로 묶는다.

import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

import {
  getBackgroundStatus,
  hasOverlayPermission,
  requestIgnoreBatteryOptimizations,
  requestOverlayPermission,
  type BackgroundStatusInfo,
} from '../../services/system/backgroundRestriction';

interface NativeSettingsBridge {
  isCallScreeningRoleHeld(): Promise<boolean>;
  requestCallScreeningRole(): Promise<boolean>;
}

const settingsNative = (
  NativeModules as { SettingsBridge?: NativeSettingsBridge }
).SettingsBridge;

/** 권한 단계 식별자. OnboardingScreen 이 이 순서대로 카드를 표시.
 *  사장님 정책 변경 (2026-05-20 late): youngmanLogin 단계 제거 — 권한 4종
 *  통과되면 즉시 메인 화면 진입 + 환영 모달. 영맨 로그인은 WebView 안의
 *  영맨 사이트가 자체 로그인 페이지로 안내. */
export type PermissionStep =
  | 'runtime'
  | 'overlay'
  | 'callScreening'
  | 'battery';

export const PERMISSION_STEPS: ReadonlyArray<PermissionStep> = [
  'runtime',
  'overlay',
  'callScreening',
  'battery',
];

export interface PermissionStatus {
  /** runtime 그룹 전체가 granted 인지. POST_NOTIFICATIONS 는 Android 13+만 체크. */
  runtime: boolean;
  /** 각 runtime 권한 개별 상태 — 디버그 / 부분 UI 용. */
  runtimeDetail: {
    audio: boolean;
    phoneState: boolean;
    contacts: boolean;
    notifications: boolean;
  };
  /** SYSTEM_ALERT_WINDOW. iOS / native 모듈 없으면 true (skip). */
  overlay: boolean;
  /** ROLE_CALL_SCREENING 보유 여부. Android Q 미만이면 true (skip — role 자체가 없음). */
  callScreening: boolean;
  /** 배터리 최적화 제외 상태. unrestricted / unknown → true. */
  battery: boolean;
  /** raw battery info (Samsung 추가 안내용). */
  batteryDetail: BackgroundStatusInfo | null;
}

/** Android 13+ 에서만 POST_NOTIFICATIONS 가 runtime permission. 이전 버전은 자동
 *  부여이므로 체크에서 빼야 false 떨어지지 않음. */
function notificationsApplicable(): boolean {
  return Platform.OS === 'android' && Platform.Version >= 33;
}

/** 모든 runtime 권한 + 적용 가능한 것만 체크. */
async function readRuntimeDetail(): Promise<
  PermissionStatus['runtimeDetail']
> {
  if (Platform.OS !== 'android') {
    return { audio: true, phoneState: true, contacts: true, notifications: true };
  }
  const [audio, phoneState, contacts, notifications] = await Promise.all([
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CONTACTS),
    notificationsApplicable()
      ? PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        )
      : Promise.resolve(true),
  ]);
  return { audio, phoneState, contacts, notifications };
}

export async function readPermissionStatus(): Promise<PermissionStatus> {
  if (Platform.OS !== 'android') {
    return {
      runtime: true,
      runtimeDetail: {
        audio: true,
        phoneState: true,
        contacts: true,
        notifications: true,
      },
      overlay: true,
      callScreening: true,
      battery: true,
      batteryDetail: null,
    };
  }
  const [runtimeDetail, overlay, callScreening, batteryDetail] =
    await Promise.all([
      readRuntimeDetail(),
      hasOverlayPermission(),
      readCallScreeningHeld(),
      getBackgroundStatus(),
    ]);
  const runtime =
    runtimeDetail.audio &&
    runtimeDetail.phoneState &&
    runtimeDetail.contacts &&
    runtimeDetail.notifications;
  const battery =
    batteryDetail.status === 'unrestricted' ||
    batteryDetail.status === 'unknown';
  return {
    runtime,
    runtimeDetail,
    overlay,
    callScreening,
    battery,
    batteryDetail,
  };
}

async function readCallScreeningHeld(): Promise<boolean> {
  if (Platform.OS !== 'android' || !settingsNative) return true;
  // Android Q (29) 미만은 ROLE_CALL_SCREENING 자체가 없음 → skip.
  if (Platform.Version < 29) return true;
  try {
    return await settingsNative.isCallScreeningRoleHeld();
  } catch {
    return false;
  }
}

/** 한 번에 모든 runtime 권한 요청. 사용자가 한 번에 다 허용/거부 선택할 수 있는
 *  Android 시스템 dialog 한 묶음으로 표시됨. */
export async function requestRuntimePermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const list = [
    PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
  ];
  if (notificationsApplicable()) {
    list.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  try {
    // RN 타입 정의의 Permission union 이 일부 환경에서 좁게 표현돼서
    // requestMultiple 시그니처와 충돌 — 기존 BackgroundPermissionBanner
    // 와 동일하게 unknown 경유로 우회.
    await PermissionsAndroid.requestMultiple(list as unknown as never);
  } catch {
    // ignore — 사용자가 dialog 닫아도 onboarding 화면이 상태 재확인 후
    // 같은 카드로 머묾.
  }
}

export async function requestOverlay(): Promise<void> {
  await requestOverlayPermission();
}

export async function requestCallScreening(): Promise<void> {
  if (Platform.OS !== 'android' || !settingsNative) return;
  try {
    await settingsNative.requestCallScreeningRole();
  } catch {
    // 사용자 cancel / 시스템 오류. 재시도 가능.
  }
}

export async function requestBattery(): Promise<void> {
  await requestIgnoreBatteryOptimizations();
}

/** 다음으로 풀어야 할 단계. 모두 granted 면 null. */
export function nextPendingStep(
  status: PermissionStatus,
): PermissionStep | null {
  if (!status.runtime) return 'runtime';
  if (!status.overlay) return 'overlay';
  if (!status.callScreening) return 'callScreening';
  if (!status.battery) return 'battery';
  return null;
}

export function isAllGranted(status: PermissionStatus): boolean {
  return nextPendingStep(status) == null;
}
