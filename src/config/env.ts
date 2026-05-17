export const WEB_BASE_URL = 'https://youngman-biz.com';

export const ALLOWED_HOSTS: ReadonlyArray<string> = [
  'youngman-biz.com',
  'www.youngman-biz.com',
];

export const APP_VERSION = '1.0.0';

export const USER_AGENT_SUFFIX = `YoungmanApp/${APP_VERSION}`;

// Firebase Web OAuth 2.0 client ID — used by native Google Sign-In SDK to
// request an ID token that the backend can verify. NOT a secret (it is a
// public client identifier embedded in the app).
export const GOOGLE_WEB_CLIENT_ID =
  '1036604405645-f283l51qak3di6igccp12o8oso2q5rjn.apps.googleusercontent.com';
