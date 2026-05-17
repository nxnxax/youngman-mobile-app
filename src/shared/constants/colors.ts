export const colors = {
  background: '#FFFFFF',
  text: '#111111',
  textMuted: '#666666',
  accent: '#0066FF',
  border: '#E5E5E5',
  error: '#D32F2F',
} as const;

export type ColorKey = keyof typeof colors;
