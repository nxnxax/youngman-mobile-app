import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { readPermissionStatus, type PermissionStatus } from './permissions';

interface UsePermissionStatusResult {
  /** null = 아직 첫 read 안 끝남. 그 동안 splash 유지 권장. */
  status: PermissionStatus | null;
  /** 수동 새로고침. 권한 요청 후 Settings 다녀온 사용자 복귀 시점에서 호출. */
  refresh: () => Promise<void>;
}

/** Permission 상태 + AppState 'active' 자동 refresh.
 *
 *  핵심: 권한 단계가 모두 시스템 Settings 화면(또는 OS dialog) 을 거치므로
 *  사용자가 영맨으로 복귀하는 순간 = Settings → 영맨 → AppState 'active'
 *  발동 시점. 그 시점에 자동으로 상태 갱신해서 OnboardingScreen 이 다음
 *  카드로 자동 진행. */
export function usePermissionStatus(): UsePermissionStatusResult {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await readPermissionStatus();
    if (mounted.current) setStatus(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') void refresh();
    });
    return () => {
      mounted.current = false;
      sub.remove();
    };
  }, [refresh]);

  return { status, refresh };
}
