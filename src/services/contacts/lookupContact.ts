import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

interface NativeContacts {
  lookupByPhoneNumber(phoneNumber: string): Promise<{ name: string } | null>;
}

const native = (NativeModules as { Contacts?: NativeContacts }).Contacts;

export async function ensureContactsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  const permission = PermissionsAndroid.PERMISSIONS.READ_CONTACTS;
  const already = await PermissionsAndroid.check(permission);
  if (already) {
    return true;
  }
  const result = await PermissionsAndroid.request(permission, {
    title: '연락처 접근',
    message:
      '저장된 연락처에서 고객 이름을 자동으로 찾아 채워넣기 위해 연락처 접근 권한이 필요합니다.',
    buttonPositive: '허용',
    buttonNegative: '거부',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Looks up the display name of a contact matching the given phone number.
 * Returns null if no match, no permission, on error, or off-platform.
 *
 * Phone-number matching is handled natively by ContactsContract.PhoneLookup,
 * which normalizes across formats (with/without country code, dashes, etc.).
 */
export async function lookupContactName(
  phoneNumber: string | null,
): Promise<string | null> {
  if (!phoneNumber) {
    return null;
  }
  if (Platform.OS !== 'android' || !native) {
    return null;
  }
  const permitted = await ensureContactsPermission();
  if (!permitted) {
    if (__DEV__) {
      console.log('[Contacts] permission denied, skipping lookup');
    }
    return null;
  }
  try {
    const result = await native.lookupByPhoneNumber(phoneNumber);
    if (__DEV__) {
      console.log(
        '[Contacts] lookup',
        phoneNumber,
        '→',
        result?.name ?? 'no match',
      );
    }
    return result?.name ?? null;
  } catch (e) {
    if (__DEV__) {
      console.warn('[Contacts] lookup error', e);
    }
    return null;
  }
}
