// 메인 화면 최상단에 띄우는 권한 부족 카드 stack.
//
// 사장님 정책 (2026-05-20): "유저가 비허용을 눌렀거나 사후에 권한을 해제한
// 경우, 메인화면 최상단에 못 볼라야 못 볼 수 없게 항목별 재설정 유도 카드를
// 띄워서 자연스럽게 모두 허용하도록 유도한다."
//
// 동작:
//   - 권한 항목별로 카드 1장. 거부된 항목만 표시 (granted 인 항목은 카드 X).
//   - 1탭 → 해당 권한 즉시 재요청 (OS dialog 또는 Settings 으로 이동).
//   - AppState 'active' 자동 refresh → 사용자가 Settings 다녀오면 즉시 사라짐.
//   - 모두 granted = null 반환 (배너 자체 사라짐).
//
// OnboardingScreen 의 풀스크린 가이드는 첫 진입 환영 가이드 역할. 사용자가
// "나중에" 선택해서 메인화면 진입했거나 사후 해제 / OS "다시 묻지 않음"
// 트랩 케이스는 이 배너가 잡는다.

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  requestBattery,
  requestCallScreening,
  requestOverlay,
  requestRuntimePermissions,
  type PermissionStep,
} from './permissions';
import { usePermissionStatus } from './usePermissionStatus';

interface CardCopy {
  /** 한 줄 헤더 (왼쪽). */
  title: string;
  /** 사용자에게 보여줄 영향 한 줄. "이거 안 켜면 X 기능이 안 됩니다" 톤. */
  reason: string;
  /** CTA 라벨. */
  cta: string;
}

const COPY: Record<PermissionStep, CardCopy> = {
  runtime: {
    title: '통화녹음/연락처 접근을 허용해주시면 AI가 요약할 수 있게 됩니다!',
    reason:
      '통화 종료 후 녹음 파일을 찾아 AI로 요약하고, 발신번호를 고객 이름과 매칭합니다. (초기 1회만)',
    cta: '허용하기',
  },
  overlay: {
    title: '화면위에 AI요약을 띄울 수 있게 영맨 앱을 활성화 시켜주세요',
    reason:
      '통화 직후 양식 카드를 화면 위에 띄워 즉시 처리할 수 있게 해드립니다. (초기 1회만)',
    cta: '활성화하기',
  },
  callScreening: {
    title: '통화직전에 기존 고객정보요약을 볼 수 있게 해주세요',
    reason:
      '전화 울릴 때 발신번호로 기존 고객을 매칭해서 화면에 띄웁니다. 영맨은 차단·스팸 기능을 사용하지 않습니다. (초기 1회만)',
    cta: '설정하기',
  },
  battery: {
    title: '영맨이 고객정보를 놓치지 않게 항상 대기할 수 있게 해주세요',
    reason:
      '평소 배터리 영향 1% 미만 — 영맨은 통화 종료 직후만 작동합니다. (초기 1회만)',
    cta: '허용하기',
  },
};

// 사장님 정책 (2026-05-23): 타 스팸차단앱과 충돌 시 overlay / callScreening
// 권한 false positive 빈발 (Samsung 펌웨어 + role 점유 다른 앱).
//   - callScreening: system role 은 한 앱만 가질 수 있어 다른 스팸앱이 점유 중이면
//     영맨 자동 silent skip — 상단팝업 안 뜨는 것 정상 동작 (사장님이 인정).
//   - overlay: canDrawOverlays() 가 다른 overlay 앱 활성 중일 때 false 로 잘못 반환
//     되는 케이스. 이미 사용자가 onboarding 에서 grant 한 경우에도 카드 반복 표시.
// 두 카드 자동 유도 제거 — 진짜 회수 케이스는 onboarding 재진입 또는 사용자 직접
// Settings 에서 처리 (trade-off 감수).
const ORDER: PermissionStep[] = [
  'runtime',
  'battery',
];

/** 한 카드. */
const PermCard: React.FC<{
  step: PermissionStep;
  busy: boolean;
  onPress: () => void;
}> = ({ step, busy, onPress }) => {
  const copy = COPY[step];
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.reason}>{copy.reason}</Text>
      <Pressable
        onPress={onPress}
        disabled={busy}
        style={[styles.cta, busy && styles.ctaDisabled]}
      >
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.ctaText}>{copy.cta}</Text>
        )}
      </Pressable>
    </View>
  );
};

export const PermissionBanner: React.FC = () => {
  const { status, refresh } = usePermissionStatus();
  // 어느 step 이 진행중인지 — 동시에 두 카드 누르면 OS dialog 가 겹치므로
  // 한 번에 한 카드만 busy 처리.
  const [busyStep, setBusyStep] = useState<PermissionStep | null>(null);

  const handlePress = useCallback(
    async (step: PermissionStep) => {
      if (busyStep) return;
      setBusyStep(step);
      try {
        switch (step) {
          case 'runtime':
            await requestRuntimePermissions();
            break;
          case 'overlay':
            await requestOverlay();
            break;
          case 'callScreening':
            await requestCallScreening();
            break;
          case 'battery':
            await requestBattery();
            break;
        }
        await refresh();
      } finally {
        setBusyStep(null);
      }
    },
    [busyStep, refresh],
  );

  if (status == null) return null;

  const missing = ORDER.filter(step => {
    switch (step) {
      case 'runtime':
        return !status.runtime;
      case 'overlay':
        return !status.overlay;
      case 'callScreening':
        return !status.callScreening;
      case 'battery':
        return !status.battery;
    }
  });

  if (missing.length === 0) return null;

  return (
    <View style={styles.root}>
      {missing.map(step => (
        <PermCard
          key={step}
          step={step}
          busy={busyStep === step}
          onPress={() => void handlePress(step)}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    backgroundColor: '#FFFFFF',
  },
  card: {
    marginBottom: 8,
    padding: 14,
    backgroundColor: '#FFF6E0',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F0BB4A',
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: '#5A3A00',
    marginBottom: 4,
  },
  reason: {
    fontSize: 12,
    color: '#5A3A00',
    lineHeight: 18,
    marginBottom: 10,
  },
  cta: {
    backgroundColor: '#0066FF',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
});
