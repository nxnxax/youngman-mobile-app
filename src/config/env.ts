export const WEB_BASE_URL = 'https://youngman-biz.com';
export const API_BASE_URL = 'https://youngman-biz.com';

/** Path of the customer ledger page inside the web shell. Reached via the
 *  "고객관리 바로가기" button on the success alert. */
export const CUSTOMERS_PATH = '/customers.html';

export const ALLOWED_HOSTS: ReadonlyArray<string> = [
  'youngman-biz.com',
  'www.youngman-biz.com',
];

export const APP_VERSION = '1.0.0';

export const USER_AGENT_SUFFIX = `YoungmanApp/${APP_VERSION}`;

/** 사장님 정책 (2026-05-21): Play Store 정식 출시 전 테스트 기간. 결제사
 *  (PortOne/TossPayments) 승인 + Google Play 등록 완료 시 false 로 변경하면
 *  모든 결제 권유 UI (UsageBanner, PlanGateModal 등) 가 원래대로 복원됨.
 *  현재 true: 결제 권유 자리에 "테스트기간 무료이벤트 다운로드 바로가기" 표시 +
 *  탭하면 TesterScreen (APK 직접 설치 안내) 으로 이동. */
export const TESTER_MODE = true;

/** Tester 페이지의 APK 다운로드 URL. 웹팀 (cafe24) 호스팅. 새 빌드 배포 시
 *  같은 파일명으로 덮어쓰기 → URL 그대로 유지. */
export const TESTER_APK_URL =
  'https://youngman-biz.com/download/youngman-latest.apk';

// 사장님 정책 (2026-05-22 UX): 영맨 여자 비서 캐릭터 PNG 는 RN bundle 에 내장
// (src/features/callRecording/components/assets/loading-secretary.png). 외부 호스팅
// 의존 X. cafe24 URL 방식 제거됨.

// Firebase Web OAuth 2.0 client ID — used by native Google Sign-In SDK to
// request an ID token that the backend can verify. NOT a secret (it is a
// public client identifier embedded in the app).
export const GOOGLE_WEB_CLIENT_ID =
  '1036604405645-f283l51qak3di6igccp12o8oso2q5rjn.apps.googleusercontent.com';

// Supabase project — direct REST endpoint for the native refresh fallback.
//
// Why these live in the app: 영맨 사이트(WebView)가 죽거나 idle 8시간 후
// paused 된 상태에서도 RN이 직접 access_token 을 갱신할 수 있어야 함
// (2026-05-20 비상 사례). WebView bridge.js 가 응답을 못 줄 때 우회 경로
// 로 `POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token` 을 호출.
//
// 둘 다 secret 이 아님:
//   - URL : 공개 프로젝트 식별자.
//   - ANON_KEY : 클라이언트용 anon key (Supabase 가 명시적으로 클라이언트에
//                임베드하라고 제공). RLS 가 실데이터를 보호.
//
// service_role key 는 절대 여기에 넣지 말 것. service_role 은 RLS 우회 권한.
//
// 영맨 supabase 프로젝트. ANON_KEY 는 새 `sb_publishable_` 형식 (Supabase
// 가 2025년부터 도입한 publishable key — 기존 eyJ... JWT 형식과 동등한
// 클라이언트 권한). REST `/auth/v1/token` 엔드포인트가 apikey 헤더로
// 받아서 동등 처리.
export const SUPABASE_URL = 'https://xktjucyijpkopkyvxovh.supabase.co';
export const SUPABASE_ANON_KEY =
  'sb_publishable_Qg7NbgXvnIEchsjR18X8Mw_d8YsqVbS';
