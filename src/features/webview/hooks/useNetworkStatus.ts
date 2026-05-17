import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    const compute = (
      isConnected: boolean | null,
      isInternetReachable: boolean | null,
    ): boolean =>
      Boolean(isConnected) && isInternetReachable !== false;

    const unsub = NetInfo.addEventListener(state => {
      setOnline(compute(state.isConnected, state.isInternetReachable));
    });

    NetInfo.fetch().then(state => {
      setOnline(compute(state.isConnected, state.isInternetReachable));
    });

    return () => unsub();
  }, []);

  return online;
}
