import type { CustomerLogRow } from '../features/callRecording/api/types';

export type RootStackParamList = {
  WebView: undefined;
  OnboardingDemo: undefined;
  SummaryReview: { customerLog: CustomerLogRow };
};
