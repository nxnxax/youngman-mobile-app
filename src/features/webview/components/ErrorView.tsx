import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors } from '../../../shared/constants/colors';

interface Props {
  message?: string;
  onRetry: () => void;
}

export const ErrorView: React.FC<Props> = ({ message, onRetry }) => (
  <View style={styles.container}>
    <Text style={styles.title}>페이지를 불러올 수 없습니다</Text>
    {message ? <Text style={styles.subtitle}>{message}</Text> : null}
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
