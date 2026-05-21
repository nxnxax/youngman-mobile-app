// 권한 onboarding 4단계 통과 후 첫 메인 화면 진입 시 1회만 표시되는 환영
// 모달. 사장님 정책 (2026-05-20 late):
//   "권한 모두 승인 → 즉시 메인 + 영맨 AI비서 ❤️ 헤더 + 통화 전/후 모달과
//    동일한 디자인"
//
// PlanGateModal 과 같은 visual language (글래스 카드 + 빨간 하트 헤더 +
// hairline-divided 버튼) — 메인서비스 4종의 정체성 일관성.

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

const WELCOME_SHOWN_KEY = '@youngman/welcome_shown_v1';

export const WelcomeModal: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const shown = await AsyncStorage.getItem(WELCOME_SHOWN_KEY);
        if (shown) return;
        setVisible(true);
      } catch {
        // best-effort — 안 뜨면 사장님 안내 missed 정도. 무해.
      }
    })();
  }, []);

  const onDismiss = async () => {
    setVisible(false);
    try {
      await AsyncStorage.setItem(WELCOME_SHOWN_KEY, String(Date.now()));
    } catch {
      // best-effort
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.body}>
            <View style={styles.brandRow}>
              <Text style={styles.brand}>영맨 AI비서</Text>
              <Text style={styles.heart}> ❤️</Text>
            </View>
            <Text style={styles.title}>반갑습니다</Text>
            <Text style={styles.subtitle}>
              로그인을 해주시면 영맨비서가{'\n'}항상 함께 하겠습니다.!
            </Text>
          </View>

          <View style={styles.hairline} />

          <View style={styles.buttonRow}>
            <Pressable style={styles.button} onPress={() => void onDismiss()}>
              <Text style={styles.buttonPrimary}>확인</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    overflow: 'hidden',
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 18,
    alignItems: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111111',
    letterSpacing: -0.2,
  },
  heart: { fontSize: 14 },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111111',
    textAlign: 'center',
    marginTop: 10,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 13,
    color: '#666666',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19,
    letterSpacing: -0.1,
  },
  hairline: { height: 1, backgroundColor: '#E5E5E5' },
  buttonRow: { flexDirection: 'row', height: 46 },
  button: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonPrimary: { fontSize: 15, fontWeight: '700', color: '#0066FF' },
});
