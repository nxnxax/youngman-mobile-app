import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '../../../shared/constants/colors';

export const LoadingOverlay: React.FC = () => (
  <View style={styles.overlay} pointerEvents="none">
    <ActivityIndicator size="large" color={colors.accent} />
  </View>
);

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
