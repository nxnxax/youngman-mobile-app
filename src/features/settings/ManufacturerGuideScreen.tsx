// 제조사별 안정성 가이드. 사장님 Play 정책 사양 (2026-05-21):
//   "삼성/샤오미/오포/비보 등에서 background kill 발생 가능.
//    필수: battery optimization 안내 / autostart 안내 /
//    lockscreen notification 허용 안내. 단 과도한 강제 문구 금지."
//
// 디자인 톤: PlanGateModal / UnreviewedSummaries 동일 — 글래스 카드 +
// 영맨 AI비서 ❤️ 헤더. 정보성 + 비강제. 각 항목별 "설정 열기" 버튼만 제공.

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  getBackgroundStatus,
  openAppSettings,
  type BackgroundStatusInfo,
} from '../../services/system/backgroundRestriction';
import type { RootStackParamList } from '../../navigation/types';

type Manufacturer = 'samsung' | 'xiaomi' | 'oppo' | 'vivo' | 'huawei' | 'other';

function detectManufacturer(raw: string): Manufacturer {
  const lower = raw.toLowerCase();
  if (lower.includes('samsung')) return 'samsung';
  if (lower.includes('xiaomi') || lower.includes('redmi') || lower.includes('poco'))
    return 'xiaomi';
  if (lower.includes('oppo') || lower.includes('realme')) return 'oppo';
  if (lower.includes('vivo')) return 'vivo';
  if (lower.includes('huawei') || lower.includes('honor')) return 'huawei';
  return 'other';
}

interface GuideStep {
  title: string;
  body: string;
}

const SAMSUNG_STEPS: ReadonlyArray<GuideStep> = [
  {
    title: '1. 배터리 절전에서 제외',
    body: '설정 → 디바이스 케어 → 배터리 → 백그라운드 사용 한도 → "사용 안 함 앱" 목록 → 영맨 추가',
  },
  {
    title: '2. 자동 실행 허용',
    body: '설정 → 앱 → 영맨 → 배터리 → "제한 없음" 선택',
  },
  {
    title: '3. 잠금화면 알림 허용',
    body: '설정 → 알림 → 잠금화면 → 알림 표시 → 영맨 켜기',
  },
];

const XIAOMI_STEPS: ReadonlyArray<GuideStep> = [
  {
    title: '1. Autostart 켜기',
    body: '설정 → 앱 → 앱 관리 → 영맨 → "자동 실행" / "Autostart" 켜기',
  },
  {
    title: '2. 배터리 절전에서 제외',
    body: '설정 → 배터리 → 앱 배터리 관리자 → 영맨 → "제한 없음"',
  },
  {
    title: '3. 잠금화면 표시',
    body: '설정 → 잠금화면 → 알림 표시 → 영맨 허용',
  },
];

const OPPO_VIVO_STEPS: ReadonlyArray<GuideStep> = [
  {
    title: '1. Background 앱 관리',
    body: '설정 → 앱 → 앱 관리 → 영맨 → "백그라운드 실행 허용"',
  },
  {
    title: '2. 자동 실행',
    body: '설정 → 배터리 → 자동 실행 → 영맨 켜기',
  },
  {
    title: '3. 잠금화면 알림',
    body: '설정 → 알림 → 잠금화면 → 영맨 허용',
  },
];

const GENERIC_STEPS: ReadonlyArray<GuideStep> = [
  {
    title: '1. 배터리 절전에서 제외',
    body: '설정 → 앱 → 영맨 → 배터리 → "제한 없음" 또는 "최적화하지 않음"',
  },
  {
    title: '2. 잠금화면 알림 허용',
    body: '설정 → 알림 → 잠금화면 → 영맨 허용',
  },
];

function stepsFor(mfr: Manufacturer): ReadonlyArray<GuideStep> {
  switch (mfr) {
    case 'samsung':
      return SAMSUNG_STEPS;
    case 'xiaomi':
      return XIAOMI_STEPS;
    case 'oppo':
    case 'vivo':
      return OPPO_VIVO_STEPS;
    default:
      return GENERIC_STEPS;
  }
}

function labelFor(mfr: Manufacturer): string {
  switch (mfr) {
    case 'samsung':
      return 'Samsung 폰';
    case 'xiaomi':
      return 'Xiaomi / Redmi / Poco';
    case 'oppo':
      return 'OPPO / Realme';
    case 'vivo':
      return 'Vivo';
    case 'huawei':
      return 'Huawei / Honor';
    default:
      return 'Android';
  }
}

export const ManufacturerGuideScreen: React.FC = () => {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [status, setStatus] = useState<BackgroundStatusInfo | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getBackgroundStatus();
      setStatus(s);
    })();
  }, []);

  const mfr = status ? detectManufacturer(status.manufacturer) : 'other';
  const steps = stepsFor(mfr);
  const label = labelFor(mfr);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          hitSlop={12}
        >
          <Text style={styles.backArrow}>‹</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.brandRow}>
            <Text style={styles.brand}>영맨 AI비서</Text>
            <Text style={styles.heart}> ❤️</Text>
          </View>
          <Text style={styles.headerSubtitle}>안정성 가이드</Text>
        </View>
        <View style={styles.backButton} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.introCard}>
          <Text style={styles.introTitle}>
            {label} 사용자를 위한 안정 작동 가이드
          </Text>
          <Text style={styles.introBody}>
            영맨은 통화 종료 직후만 짧게 작동합니다 (평소 배터리 영향 1% 미만).
            그러나 일부 제조사는 배터리 절전 기능으로 영맨이 살아 있어도 통화
            이벤트를 막아버릴 수 있어요. 아래 항목들을 한 번만 설정해두시면
            "단 한 건의 누락 없이" 작동합니다.
          </Text>
        </View>

        {steps.map((step, i) => (
          <View key={i} style={styles.stepCard}>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepBody}>{step.body}</Text>
          </View>
        ))}

        <View style={styles.actionRow}>
          <Pressable
            onPress={() => void openAppSettings()}
            style={styles.actionButton}
          >
            <Text style={styles.actionText}>영맨 앱 설정 열기</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              Linking.openSettings().catch(() => {});
            }}
            style={[styles.actionButton, styles.actionButtonSecondary]}
          >
            <Text style={styles.actionTextSecondary}>전체 설정 열기</Text>
          </Pressable>
        </View>

        <Text style={styles.footnote}>
          ※ 설정 위치는 폰 OS 버전에 따라 살짝 다를 수 있어요.{'\n'}
          영맨은 작업 끝나면 즉시 종료되어 배터리 소모가 매우 적습니다.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F7F7F8' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backArrow: { fontSize: 28, color: '#0066FF', lineHeight: 28 },
  headerCenter: { flex: 1, alignItems: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  brand: { fontSize: 15, fontWeight: '700', color: '#111111', letterSpacing: -0.2 },
  heart: { fontSize: 13 },
  headerSubtitle: { fontSize: 12, color: '#666666', marginTop: 2 },
  scroll: { padding: 12, paddingBottom: 40 },
  introCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
  },
  introTitle: { fontSize: 16, fontWeight: '700', color: '#111111', marginBottom: 8, letterSpacing: -0.2 },
  introBody: { fontSize: 13, color: '#444444', lineHeight: 20 },
  stepCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
  },
  stepTitle: { fontSize: 14, fontWeight: '700', color: '#0066FF', marginBottom: 6, letterSpacing: -0.2 },
  stepBody: { fontSize: 13, color: '#333333', lineHeight: 19 },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  actionButton: {
    flex: 1,
    backgroundColor: '#0066FF',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionButtonSecondary: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#0066FF',
  },
  actionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  actionTextSecondary: { color: '#0066FF', fontSize: 14, fontWeight: '700' },
  footnote: { fontSize: 11, color: '#888888', textAlign: 'center', marginTop: 18, lineHeight: 16 },
});
