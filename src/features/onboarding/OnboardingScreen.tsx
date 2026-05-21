// 영맨 첫 실행 권한 onboarding 화면.
//
// 메인서비스 4종 (통화 전 모달 / 통화 후 모달 / AI 요약 / 전송) 이 별도 학습
// 없이 작동하려면 이 화면을 거쳐 권한이 전부 설정되어야 한다. 사장님 슬로건
// (simple/painless/beautiful/one-tap) 에 맞춰:
//
//   - 한 화면에 1탭짜리 큰 버튼 1개만 노출.
//   - 한 단계 완료되면 자동으로 다음 단계 카드로 전환.
//   - 시스템 Settings 다녀오면 AppState 'active' 가 자동 감지해서 다음 단계로.
//   - 이미 통과된 단계는 자동 skip → 재실행 시 사용자가 권한 다 갖고 있으면
//     OnboardingScreen 자체가 안 뜸.
//
// 사용자 자유의지로 "건너뛰기" 버튼은 두지 않는다. 사장님 정책: 메인서비스
// 4종을 못 쓰면 영맨 자체가 의미 없음 → 권한 통과가 사용 전제 조건.

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  nextPendingStep,
  requestBattery,
  requestCallScreening,
  requestOverlay,
  requestRuntimePermissions,
  type PermissionStatus,
  type PermissionStep,
} from './permissions';

interface OnboardingScreenProps {
  status: PermissionStatus;
  onRefresh: () => Promise<void>;
  /** 사용자가 "나중에 설정" 누르면 호출. App.tsx 가 받아서 메인 화면 진입을
   *  허용 (PermissionBanner 가 메인 화면에서 못 볼라야 못 볼 수 없게 유도). */
  onSkip: () => void;
}

interface StepCopy {
  /** 카드 헤더 한 줄. */
  title: string;
  /** 왜 필요한지 한 줄 (사용자 언어). */
  why: string;
  /** 사용자가 어떤 화면을 거치게 될지 안내 한 줄. */
  hint: string;
  /** 버튼 라벨. */
  cta: string;
}

const COPY: Record<PermissionStep, StepCopy> = {
  runtime: {
    title: '통화녹음/연락처 접근을 허용해주시면 AI가 요약할 수 있게 됩니다!',
    why:
      '통화 종료 후 녹음 파일을 찾아 AI로 요약하고, 발신번호를 고객 이름과 매칭하기 위해 필요합니다.',
    hint: 'Android 시스템 안내창이 차례로 뜹니다. 모두 "허용" 눌러주세요.',
    cta: '한 번에 권한 허용',
  },
  overlay: {
    title: '화면위에 AI요약을 띄울 수 있게 영맨 앱을 활성화 시켜주세요',
    why: '통화 직후 양식 카드를 화면 위에 띄워서 즉시 처리할 수 있게 해드립니다.',
    hint: '시스템 설정 페이지가 열려요. 영맨 토글을 켜고 뒤로가기 하시면 됩니다.',
    cta: '권한 설정 열기',
  },
  callScreening: {
    title: '통화직전에 기존 고객정보요약을 볼 수 있게 해주세요',
    why:
      '전화가 울리는 순간 발신번호를 고객관리대장과 매칭해서 "김사장님 (3번째 통화)" 같은 정보를 즉시 보여드려요. 영맨은 차단·스팸 기능을 일절 사용하지 않습니다.',
    hint: 'Android 시스템 안내창이 "발신번호 표시 및 스팸 앱"으로 표시되더라도 영맨을 선택해주세요. (영맨은 스팸 차단 기능을 사용하지 않습니다)',
    cta: '발신자 정보 표시 설정',
  },
  battery: {
    title: '영맨이 고객정보를 놓치지 않게 항상 대기할 수 있게 해주세요',
    why: '평소 배터리 영향 1% 미만 — 영맨은 통화 종료 직후만 작동합니다.',
    hint: '시스템 안내창이 뜨면 "허용"을 눌러주세요.',
    cta: '배터리 예외 설정',
  },
};

/** 단계별 안내 카드 + 메인 CTA. */
const StepCard: React.FC<{
  step: PermissionStep;
  pending: boolean;
  busy: boolean;
  onPress: () => void;
}> = ({ step, pending, busy, onPress }) => {
  const copy = COPY[step];
  return (
    <View style={[styles.card, pending ? styles.cardActive : styles.cardDone]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{copy.title}</Text>
        {!pending && <Text style={styles.cardCheck}>완료</Text>}
      </View>
      {pending ? (
        <>
          <Text style={styles.cardWhy}>{copy.why}</Text>
          <Text style={styles.cardHint}>{copy.hint}</Text>
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
        </>
      ) : null}
    </View>
  );
};

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({
  status,
  onRefresh,
  onSkip,
}) => {
  const [busy, setBusy] = useState(false);
  const pending = nextPendingStep(status);

  const handleStep = useCallback(
    async (step: PermissionStep) => {
      setBusy(true);
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
        // 권한 요청 직후 즉시 한 번 더 read. 그리고 AppState 'active' 가
        // 다시 한 번 자동 refresh 해줄 거라 사용자가 Settings 거쳐 돌아오면
        // 다음 단계로 알아서 전환.
        await onRefresh();
      } finally {
        setBusy(false);
      }
    },
    [onRefresh, onSkip],
  );

  // 모든 단계 통과 — App.tsx 가 이미 라우팅 분기로 WebView 로 넘기지만,
  // 라우팅 전환 직전 1프레임 동안 잠깐 보일 수 있어 안전판으로 처리.
  if (pending == null) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color="#0066FF" />
        </View>
      </SafeAreaView>
    );
  }

  const stepOrder: PermissionStep[] = [
    'runtime',
    'overlay',
    'callScreening',
    'battery',
  ];
  const doneCount = stepOrder.filter(s => {
    if (s === 'runtime') return status.runtime;
    if (s === 'overlay') return status.overlay;
    if (s === 'callScreening') return status.callScreening;
    return status.battery;
  }).length;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Text style={styles.brand}>영맨</Text>
          <Text style={styles.subtitle}>
            한 번만 설정하면 통화 종료 직후 자동 요약까지 끝납니다.
          </Text>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                { width: `${(doneCount / stepOrder.length) * 100}%` },
              ]}
            />
          </View>
          <Text style={styles.progressLabel}>
            {doneCount} / {stepOrder.length} 단계 완료
          </Text>
        </View>

        {stepOrder.map(step => {
          const isPending = step === pending;
          const done =
            step === 'runtime'
              ? status.runtime
              : step === 'overlay'
                ? status.overlay
                : step === 'callScreening'
                  ? status.callScreening
                  : status.battery;
          // 이미 완료된 단계는 완료 카드, 현재 진행 중인 단계는 active 카드,
          // 아직 차례가 안 온 단계는 회색 thin 카드로만 표시.
          if (done) {
            return (
              <StepCard
                key={step}
                step={step}
                pending={false}
                busy={false}
                onPress={() => {}}
              />
            );
          }
          if (!isPending) {
            return (
              <View key={step} style={[styles.card, styles.cardLater]}>
                <Text style={styles.cardTitleLater}>{COPY[step].title}</Text>
              </View>
            );
          }
          return (
            <StepCard
              key={step}
              step={step}
              pending
              busy={busy}
              onPress={() => void handleStep(step)}
            />
          );
        })}

        <Text style={styles.footnote}>
          모든 권한은 영맨 안에서만 사용되며 외부로 전송되지 않습니다.
        </Text>

        <Pressable onPress={onSkip} style={styles.skipButton}>
          <Text style={styles.skipText}>
            나중에 설정하기 (메인 화면에서 항목별로 다시 안내드릴게요)
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  scroll: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { marginBottom: 24 },
  brand: {
    fontSize: 32,
    fontWeight: '800',
    color: '#0066FF',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 15,
    color: '#444',
    marginBottom: 14,
    lineHeight: 22,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#EFEFEF',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#0066FF' },
  progressLabel: {
    marginTop: 6,
    fontSize: 12,
    color: '#888',
  },
  card: {
    marginBottom: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  cardActive: {
    backgroundColor: '#F5F9FF',
    borderColor: '#0066FF',
  },
  cardDone: {
    backgroundColor: '#F4FBF6',
    borderColor: '#3FB76A',
  },
  cardLater: {
    backgroundColor: '#FAFAFA',
    borderColor: '#E5E5E5',
    paddingVertical: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0A0A0A',
    flex: 1,
  },
  cardCheck: {
    fontSize: 12,
    fontWeight: '700',
    color: '#3FB76A',
    marginLeft: 8,
  },
  cardTitleLater: {
    fontSize: 14,
    fontWeight: '600',
    color: '#999',
  },
  cardWhy: { fontSize: 14, color: '#333', lineHeight: 21, marginBottom: 10 },
  cardHint: { fontSize: 12, color: '#666', marginBottom: 14 },
  cta: {
    backgroundColor: '#0066FF',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  footnote: {
    marginTop: 16,
    fontSize: 11,
    color: '#999',
    textAlign: 'center',
    lineHeight: 16,
  },
  skipButton: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  skipText: {
    fontSize: 12,
    color: '#888',
    textDecorationLine: 'underline',
  },
});
