import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors } from '../../../shared/constants/colors';

interface Props {
  onRetry: () => void;
}

export const OfflineView: React.FC<Props> = ({ onRetry }) => (
  <View style={styles.container}>
    <Text style={styles.title}>인터넷 연결을 확인해주세요</Text>
    <Text style={styles.subtitle}>
      네트워크가 복구되면 다시 시도해주세요.
    </Text>
    <TouchableOpacity
      style={styles.button}
      onPress={onRetry}
      activeOpacity={0.8}
    >
      <Text style={styles.buttonText}>다시 시도</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 24,
    textAlign: 'center',
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: colors.accent,
    borderRadius: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
