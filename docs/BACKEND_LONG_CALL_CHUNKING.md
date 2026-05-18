# Backend spec — Long-call STT chunking + map-reduce LLM

Add-on to `BACKEND_CALL_RECORDING_SPEC.md`. Targets calls **5분 ~ 1시간+** so
the existing sync `process-recording.php` no longer fails on long recordings.

Hand this to the web team (Codex). Mobile app side is already prepared:
the upload + `process_recording` contract does **not** change shape — only
the server-internal pipeline changes.

## Why

Current flow runs Clova STT + LLM in a single PHP request:

```
process-recording.php
  ├─ Clova STT (~0.3 × audio duration)
  ├─ LLM single call (full transcript)
  └─ DB insert
```

For a 1hr call this is ~15min STT + LLM with full transcript → far over
cafe24's `max_execution_time` (60s) and Clova's single-request soft limits.
End user sees infinite loading or a 500.

## Goal

- 1시간 통화도 처리 가능
- 처리 시간 ≤ 3분 (사용자 안내 멘트와 일치)
- 클라이언트 API 응답 형태 변경 없음 (sync path 그대로 유지 가능)

## Pipeline

```
process-recording.php
  ├─ 1. 오디오 길이 측정 (이미 들어오는 duration_sec 활용)
  ├─ 2. duration_sec > THRESHOLD (예: 600s = 10분)이면 청크 모드, 아니면 기존 path
  ├─ 3. 청크 모드:
  │     a. ffmpeg로 10분 단위 분할 (audio chunk N개)
  │     b. Clova STT 병렬 호출 (curl_multi 또는 PHP-FPM async)
  │     c. 청크별 transcript 합치기 (timestamp 유지)
  │     d. LLM map: 각 transcript chunk → 짧은 요약 (1~2문장)
  │     e. LLM reduce: 청크 요약들 + 메타데이터 → 최종 customer_log JSON
  └─ 4. DB insert + return (기존과 동일 응답)
```

## 청크 사이즈 선택

- 10분 청크 권장 (Clova batch 안정 + LLM 토큰 여유)
- 1시간 통화 = 6 청크. Clova 6개 병렬 → ~2분 안에 STT 끝
- 너무 짧으면 (예: 1분) context 잘림 + LLM call 수 늘어남
- 너무 길면 (예: 30분) Clova 단일 요청 부담 + 병렬도 손실

## LLM map-reduce 프롬프트

### Map (청크별)
```
다음은 영업 통화의 일부분이다 (전체의 N/M번째 청크, 시점 mm:ss ~ mm:ss).
이 부분에서 다음을 1-2문장으로 추출하라:
- 고객이 관심을 보인 항목
- 합의된 사항 / 의문점
- 새로 등장한 인물이나 회사명
- 다음 액션 후보

전사:
{chunk_transcript}
```

### Reduce (최종)
```
다음은 한 영업 통화의 시간순 부분 요약 N개이다.
이를 종합하여 아래 JSON 스키마로 통합 요약하라.
(스키마는 기존 customer_log 응답과 동일)

부분 요약:
1. {chunk_summary_1}
2. {chunk_summary_2}
...

힌트:
- customer_name_hint: {phone book name or null}
- phone_number: {from request}
- 통화 시간: {duration_sec}초

응답 (JSON only):
{
  "customer_name": "...",
  "summary": "...",
  "interest": "...",
  "inquiry": "...",
  "budget_condition": "...",
  "next_action": "...",
  ...
}
```

## PHP `max_execution_time` 대응

cafe24 PHP 60초 제한이 1차 병목. 두 가지 길:

### A. 동기 유지 + 시간 단축 (옵션 2)
- ffmpeg 분할 + Clova 6개 병렬 호출 잘 되면 1시간 통화도 60~90초 안에 완료
- `set_time_limit(180)` 으로 PHP 상한 풀기 (cafe24 호스팅 등급별 허용 여부 확인)
- 클라이언트 HeadlessJsTask timeout은 이미 10분으로 늘려놓음

### B. 비동기로 가기 (Option 3, 별도 작업)
- 본 스펙은 옵션 A를 가정. 옵션 B로 가려면 별도 스펙 필요.

## 응답 변경 없음

`/process-recording.php` 응답은 기존과 동일:

```json
{
  "status": "ok",
  "customer_log": { ... },
  "plan": { ... }
}
```

클라이언트는 어떤 path를 탔는지 신경 안 씀.

## 측정 / 로깅

웹팀 부탁: 응답에 디버그 타이밍 포함 (production 로그 분석용):

```json
{
  "status": "ok",
  "customer_log": { ... },
  "plan": { ... },
  "debug_timings": {
    "stt_ms": 90000,
    "llm_ms": 12000,
    "chunks": 6,
    "total_ms": 105000
  }
}
```

클라이언트는 이 필드 무시. 운영 로그 보고 청크 크기 / 병렬도 튜닝할 때 씀.

## 테스트 케이스

웹팀 확인 시나리오:
- 30초 통화 → 기존 path, 응답 < 10s
- 5분 통화 → 기존 path, 응답 < 15s
- 15분 통화 → 청크 path (2 청크), 응답 < 30s
- 30분 통화 → 청크 path (3 청크), 응답 < 60s
- 60분 통화 → 청크 path (6 청크), 응답 < 180s
- 청크 중 1개 STT 실패 시 → 나머지로 진행 + customer_log에 "(일부 누락)" 표시
