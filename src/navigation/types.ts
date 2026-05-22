import type { ProcessRecordingInput } from '../features/callRecording/api/processRecording';
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
  /** Set when the customer log has already been processed (history → review,
   *  or legacy ConfirmRecording path). */
  customerLog?: CustomerLogRow;
  /** Set when upload finished but processRecording hasn't been called yet.
   *  SummaryReview runs process inside its own useEffect and fills the form
   *  when it returns — so the user perceives the screen transition as
   *  instant instead of staring at a 7s loading screen. */
  pendingJob?: ProcessRecordingInput;
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
  Settings: undefined;
  ErrorLog: undefined;
  UnreviewedSummaries: undefined;
  UnreviewedPreview: { jobId: string };
  ManufacturerGuide: undefined;
  Tester: undefined;
};
