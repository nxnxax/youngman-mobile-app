// 사장님 명시적 로그아웃 vs 토큰 만료 구분 플래그.
//
// 사장님 정책 (2026-05-22 "찰거머리" 슬로건):
//   "365일 만에 접속해도 영맨은 사용자한테 딱붙어서 AI 정보를 흐트러짐 없이
//    보여줘야 한다" — 토큰 만료/세션 만료는 silent re-auth 로 자동 복구.
//
// 단 사용자가 *명시적으로* 로그아웃한 경우는 silent re-auth 자동 실행 금지.
// 이 플래그가 그 의도를 보존한다.
//
//   true  → silentSignIn 자동 시도 차단 (사용자 로그인 화면 직진)
//   false → 토큰 만료 시 silent re-auth 자동 발동 가능
//
// AsyncStorage 에 persist 되므로 앱 재시작 후에도 유지.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@youngman/user-logged-out-v1';

/** 사용자가 명시적으로 로그아웃한 적이 있는지. silent re-auth 차단 게이트. */
export async function isExplicitlyLoggedOut(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw === '1';
  } catch {
    // storage read 실패 = false 로 간주 (silent re-auth 시도 허용).
    return false;
  }
}

/** 사용자 명시적 로그아웃 시 호출. silent re-auth 자동 시도 차단. */
export async function setExplicitlyLoggedOut(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, '1');
  } catch {
    // ignore — best-effort
  }
}

/** Auth.login 성공 시 호출. 다음 토큰 만료 시 silent re-auth 자동 허용. */
export async function clearExplicitlyLoggedOut(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
