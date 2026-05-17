import type { CustomerLogRow } from '../features/callRecording/api/types';

export interface ConfirmRecordingParams {
  uri: string;
  name: string;
  duration: number; // ms
  dateAdded: number; // unix seconds
  mimeType: string;
}

export type RootStackParamList = {
  WebView: undefined;
  OnboardingDemo: undefined;
  ConfirmRecording: ConfirmRecordingParams;
  SummaryReview: { customerLog: CustomerLogRow };
};
