import type {
  CustomerLogRow,
  LedgerGroup,
} from '../features/callRecording/api/types';

export interface ConfirmRecordingParams {
  uri: string;
  name: string;
  duration: number; // ms
  dateAdded: number; // unix seconds
  mimeType: string;
}

export interface SummaryReviewParams {
  customerLog: CustomerLogRow;
  /** Group selected upstream (glass overlay / ConfirmRecording). null = auto-default. */
  groupId?: string | null;
  /** Cached groups so the picker on this screen does not need to refetch. */
  availableGroups?: ReadonlyArray<LedgerGroup>;
}

export type RootStackParamList = {
  WebView: undefined;
  OnboardingDemo: undefined;
  ConfirmRecording: ConfirmRecordingParams;
  SummaryReview: SummaryReviewParams;
};
