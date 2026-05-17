import {
  classifyAudio,
  extractPhoneNumber,
  filterAndClassify,
  type MediaStoreAudio,
} from '../heuristics';

const sample = (over: Partial<MediaStoreAudio> = {}): MediaStoreAudio => ({
  id: '1',
  uri: 'content://media/external/audio/media/1',
  displayName: 'sample.m4a',
  relativePath: 'Music/',
  dateAdded: 1_700_000_000,
  duration: 60_000,
  mimeType: 'audio/mp4',
  size: 1_000_000,
  ...over,
});

describe('classifyAudio', () => {
  test('Samsung default path + Korean filename → high confidence', () => {
    const r = classifyAudio(
      sample({
        displayName: '통화 녹음 홍길동_241225_143022.m4a',
        relativePath: 'Recordings/Call/',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.source).toBe('samsung-default');
  });

  test('ACR new layout', () => {
    const r = classifyAudio(
      sample({
        displayName: 'Call_홍길동_241225.opus',
        relativePath: 'CallRecordings/',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.source).toBe('acr-new');
  });

  test('Xiaomi MIUI legacy path', () => {
    const r = classifyAudio(
      sample({
        displayName: 'rec_1700000000.mp3',
        relativePath: 'MIUI/sound_recorder/call_rec/',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.source).toBe('miui');
  });

  test('T전화 (SK) actual path', () => {
    const r = classifyAudio(
      sample({
        displayName: '01059102542_20260517171626.m4a',
        relativePath: 'Recordings/TPhoneCallRecords/',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.source).toBe('t-phone-skt');
  });

  test('Cube ACR path', () => {
    const r = classifyAudio(
      sample({
        displayName: 'Friend_241225.mp3',
        relativePath: 'CubeCallRecorder/All/',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.source).toBe('cube-acr');
  });

  test('music file in Music folder is rejected', () => {
    const r = classifyAudio(
      sample({
        displayName: 'BTS-Dynamite.mp3',
        relativePath: 'Music/',
      }),
    );
    expect(r.isCallRecording).toBe(false);
  });

  test('non-audio extension rejected', () => {
    const r = classifyAudio(
      sample({
        displayName: 'document.pdf',
        relativePath: 'Recordings/Call/',
      }),
    );
    expect(r.isCallRecording).toBe(false);
  });

  test('too-short clip in call folder still rejected (probably ringtone)', () => {
    const r = classifyAudio(
      sample({
        displayName: 'ringtone.m4a',
        relativePath: 'Recordings/Call/',
        duration: 3_000,
      }),
    );
    expect(r.isCallRecording).toBe(false);
  });

  test('too-long clip rejected', () => {
    const r = classifyAudio(
      sample({
        displayName: '통화 녹음 lecture.m4a',
        relativePath: 'Recordings/Call/',
        duration: 3 * 60 * 60_000,
      }),
    );
    expect(r.isCallRecording).toBe(false);
  });

  test('filename-only match when path is generic', () => {
    const r = classifyAudio(
      sample({
        displayName: '010-1234-5678_241225.mp3',
        relativePath: 'Music/',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.confidence).toBe('medium');
    expect(r.source).toBe('phone-prefix');
  });

  test('relativePath missing (pre-Q) still classifies on filename', () => {
    const r = classifyAudio(
      sample({
        displayName: '통화 녹음 클라이언트.m4a',
        relativePath: '',
      }),
    );
    expect(r.isCallRecording).toBe(true);
    expect(r.confidence).toBe('medium');
    expect(r.source).toBe('samsung-ko');
  });
});

describe('filterAndClassify', () => {
  test('sorts most recent first', () => {
    const result = filterAndClassify([
      sample({
        id: '1',
        displayName: '통화 녹음 older.m4a',
        relativePath: 'Recordings/Call/',
        dateAdded: 100,
      }),
      sample({
        id: '2',
        displayName: '통화 녹음 newer.m4a',
        relativePath: 'Recordings/Call/',
        dateAdded: 200,
      }),
    ]);
    expect(result.map(r => r.id)).toEqual(['2', '1']);
  });

  test('mixed inputs — only call recordings retained', () => {
    const result = filterAndClassify([
      sample({ id: 'a', displayName: 'song.mp3', relativePath: 'Music/' }),
      sample({
        id: 'b',
        displayName: '통화 녹음 a.m4a',
        relativePath: 'Recordings/Call/',
      }),
      sample({ id: 'c', displayName: 'voice-memo.amr', relativePath: 'Voice/' }),
    ]);
    expect(result.map(r => r.id)).toEqual(['b']);
  });
});

describe('extractPhoneNumber', () => {
  test('mobile dashed', () => {
    expect(extractPhoneNumber('010-1234-5678_241225.mp3')).toBe('010-1234-5678');
  });
  test('mobile contiguous', () => {
    expect(extractPhoneNumber('01012345678_call.m4a')).toBe('010-1234-5678');
  });
  test('seoul landline', () => {
    expect(extractPhoneNumber('02-123-4567_call.m4a')).toBe('02-123-4567');
  });
  test('no match', () => {
    expect(extractPhoneNumber('통화녹음_user.m4a')).toBeNull();
  });
  test('does not match dates that look like numbers', () => {
    // Filename like 20241225-103022.m4a contains 8-digit + 6-digit groups
    // but the second chunk is 6 digits which falls outside our 3-4 range.
    expect(extractPhoneNumber('20241225-103022.m4a')).toBeNull();
  });
});
