# Backend spec — Call recording → AI summary → CRM ledger

This document is the contract the RN Android app expects from the Supabase
backend. Hand this to the web team / web Claude (Codex) for implementation.

The app handles: detect recording on phone, upload audio, ask backend to
process, present result, save to ledger. The backend owns: Storage bucket,
`customer_log` schema, Edge Functions for STT + LLM, FCM dispatch on async
completion.

## 0. Scope of Phase 1 demo

- Sync processing only (no FCM yet). App polls or waits on the Edge Function.
- Single audio file per request. No batching.
- Korean STT (`whisper-1` `language: 'ko'`).
- LLM model TBD by web team — recommendation: `gpt-4o-mini` or
  `claude-haiku-4-5` for cost. Output **must** match the JSON shape in §5.
- Plan gating enforced server-side. App provides plan hint but server is source
  of truth.

## 1. Supabase Storage

Create a **private** bucket:

```
bucket: recordings
public: false
file size limit: 50 MB
allowed mime types: audio/mp4, audio/m4a, audio/3gpp, audio/amr,
                   audio/ogg, audio/mpeg, audio/wav, audio/aac, audio/opus
```

Path convention (enforced via RLS):

```
recordings/{user_id}/{yyyy-mm-dd}/{uuid}.{ext}
```

RLS policy on `storage.objects`:

```sql
-- Users may insert into their own folder only
create policy "users upload to own folder"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'recordings'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Users may read only their own files
create policy "users read own files"
on storage.objects for select
to authenticated
using (
  bucket_id = 'recordings'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Users may delete only their own files
create policy "users delete own files"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'recordings'
  and (storage.foldername(name))[1] = auth.uid()::text
);
```

## 2. `customer_log` table

```sql
create table if not exists public.customer_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,

  -- Identification fields (may be filled by AI, may be edited by user)
  customer_name text,
  phone_number text,

  consult_at timestamptz not null,

  -- AI-extracted content
  summary text not null,
  interest text,
  inquiry text,
  budget_condition text,
  next_action text,

  -- User-editable
  agent_memo text,

  -- Audio / AI metadata
  audio_storage_path text,
  audio_kept boolean default true,
  transcript text,
  ai_model text,
  ai_generated_at timestamptz,

  source text not null default 'app-auto',
    -- 'app-auto' | 'app-manual' | 'web' | 'manual-entry'

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customer_log_user_id_idx on public.customer_log(user_id, consult_at desc);
create index customer_log_phone_idx on public.customer_log(user_id, phone_number);

alter table public.customer_log enable row level security;

create policy "owner can read" on public.customer_log
  for select to authenticated using (user_id = auth.uid());

create policy "owner can insert" on public.customer_log
  for insert to authenticated with check (user_id = auth.uid());

create policy "owner can update" on public.customer_log
  for update to authenticated using (user_id = auth.uid());

create policy "owner can delete" on public.customer_log
  for delete to authenticated using (user_id = auth.uid());

-- updated_at trigger (reuse if one exists)
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;

create trigger customer_log_set_updated_at
  before update on public.customer_log
  for each row execute function set_updated_at();
```

## 3. Plan gating

Add a column to whichever profile/user table the project uses (or new):

```sql
alter table public.profiles add column plan text not null default 'free';
-- 'free' | 'premium'

alter table public.profiles add column free_summaries_used int not null default 0;
```

App will reflect this back to the web via `auth.login` payload. Backend is
authoritative.

## 4. Edge Function — `process-recording`

```
POST {SUPABASE_URL}/functions/v1/process-recording
Authorization: Bearer <user JWT>
Content-Type: application/json
```

### Request body

```json
{
  "storage_path": "user-id/2026-05-17/abc-uuid.m4a",
  "duration_sec": 273,
  "original_filename": "01059102542_20260517171626.m4a",
  "recorded_at": "2026-05-17T17:16:26+09:00",
  "phone_number": "010-5910-2542",
  "client_request_id": "uuid-from-app"
}
```

- `phone_number` may be null if the app couldn't extract.
- `client_request_id` lets the client retry safely (server should dedupe).

### Server steps

1. Verify JWT → resolve `user_id`.
2. Plan check:
   - If `plan = 'free'` and `free_summaries_used >= FREE_QUOTA`, return
     `403 plan_required`.
3. Verify `storage_path` belongs to this user (`(storage.foldername(...))[1] == user_id`).
4. Generate signed download URL (server-side, service role) for the audio.
5. **STT**: call OpenAI Whisper API
   `POST https://api.openai.com/v1/audio/transcriptions`
   - `model: whisper-1`
   - `language: ko`
   - File via `multipart/form-data`.
6. **LLM**: call summarization model with prompt in §5.
7. Insert into `customer_log` (server-side using service role, scoped to
   `user_id`).
8. **Usage deduction (per-call bundle)**: pre-call banner + post-call modal +
   AI summary count as **one billable unit per call**. The client now gates
   the pre-call banner on plan/quota as well (see §10 below), so by the time
   we get here we've decided to run the summary — increment `summary_used`
   by **1 per unique `client_request_id`**. The client uses a deterministic
   request id derived from the recording URI, so retries for the same call
   collapse to a single increment. Reject duplicate `client_request_id`
   submissions with the cached prior result (idempotency), not a fresh
   summary run.
9. Return the inserted row id + full record (so app can render preview).

### §10 Per-call billing bundle (added 2026-05-19)

The app surfaces three artifacts for a single inbound call:

1. **Pre-call banner** (`YoungmanCallScreeningService` → `IncomingCallOverlayService`)
   — shows existing-customer summary while the phone is still ringing.
2. **Post-call modal** (`OverlayService` `overlay_recording_found.xml`) —
   offers 요약보기 / 양식에 전송.
3. **AI summary** (this endpoint `/process-recording.php`) — the actual
   STT + LLM run.

All three are bundled as one billable unit. The client gates (1) on the
cached plan snapshot (native `PlanCache` SharedPreferences mirror) before
even showing it to free / quota-exhausted users. The server is the source
of truth and dedupes via `client_request_id`: if the same call comes back
through this endpoint twice, return the cached result without incrementing
`summary_used`.

### Success response (HTTP 200)

```json
{
  "status": "ok",
  "customer_log": {
    "id": "uuid",
    "user_id": "uuid",
    "customer_id": null,
    "customer_name": "김상우",
    "phone_number": "010-5910-2542",
    "consult_at": "2026-05-17T17:16:26+09:00",
    "summary": "<3-5줄 요약>",
    "interest": "...",
    "inquiry": "...",
    "budget_condition": "...",
    "next_action": "...",
    "agent_memo": null,
    "audio_storage_path": "user-id/2026-05-17/abc-uuid.m4a",
    "audio_kept": true,
    "transcript": "<full STT text>",
    "ai_model": "gpt-4o-mini",
    "ai_generated_at": "2026-05-17T17:18:01+09:00",
    "source": "app-auto",
    "created_at": "...",
    "updated_at": "..."
  },
  "plan": {
    "plan": "free",
    "free_summaries_used": 1,
    "free_quota": 3
  }
}
```

### Error responses

```json
// 401 — JWT invalid/missing
{ "status": "error", "code": "unauthorized" }

// 403 — quota exhausted (free plan)
{ "status": "error", "code": "plan_required",
  "message": "무료 체험 횟수가 끝났습니다. Premium 가입이 필요합니다." }

// 422 — file unreadable / wrong owner
{ "status": "error", "code": "invalid_audio", "message": "..." }

// 502 — upstream STT/LLM failure
{ "status": "error", "code": "upstream_failed", "message": "..." }
```

### Idempotency

If the same `client_request_id` is sent twice within 24h, return the existing
`customer_log` row instead of re-processing.

## 5. LLM prompt template

Use as the system prompt; the transcript becomes the user message.

```
당신은 한국어 부동산/세일즈 통화 내용을 요약해 CRM에 기록하는 보조AI입니다.

입력: 통화 STT 전사
출력: 다음 JSON 스키마. 키 이름은 정확히 일치. 누락 시 빈 문자열이나 null.

{
  "customer_name": string | null,    // 통화 중 호칭 등에서 추출. 모르면 null.
  "summary": string,                  // 3-5문장. 통화의 핵심 흐름.
  "interest": string | null,          // 고객이 관심 보인 항목.
  "inquiry": string | null,           // 고객이 한 구체적 문의.
  "budget_condition": string | null,  // 예산, 평수, 위치 등 희망 조건.
  "next_action": string | null        // 다음에 해야 할 일 (콜백, 자료 발송 등).
}

규칙:
- 단정적이지 않은 사실은 추측하지 말 것.
- 개인정보(주민번호, 카드번호 등)는 마스킹.
- 통화 상대가 본인을 지칭한 호칭만 customer_name으로.
- 영업측 발화는 customer_name으로 쓰지 말 것.
- JSON 외 다른 텍스트 출력 금지.
```

## 6. Optional follow-ups (out of Phase 1 scope but plan ahead)

- **Async mode**: same endpoint but accepts `mode: "async"`. Returns
  `{ status: "queued", job_id }`. Job inserts into `recording_jobs`. On
  completion, send FCM to the user's token (lookup via `user_fcm_tokens` table).
- **Cleanup**: cron-style Edge Function to delete audio files older than N days
  for users who opted to not keep audio.

## 7. App responsibilities (FYI — not for backend team to implement)

For context, this is what the app does:

1. Detect recording (already implemented; see `src/features/callRecording/`).
2. Upload directly to Storage using `supabase-js` and user JWT:
   ```
   await supabase.storage
     .from('recordings')
     .upload(`${userId}/${date}/${uuid}.m4a`, fileBlob);
   ```
3. POST to `process-recording` with metadata.
4. Render preview from response.
5. User edits if needed; app PATCHes `customer_log` row directly (RLS allows).
6. Done.

## 8. Open questions for web team

- Confirm `profiles` table is the right place for `plan` and quota counter,
  or should it go in a new `user_plans` table?
- Confirm `customers` table exists and has `id uuid` (referenced from
  `customer_log.customer_id`). If not, drop that FK for Phase 1.
- Free quota value — 3? 5? Decide with PM.
- Audio retention policy — default to keep, or default to delete after
  successful summary? Affects bucket cost and privacy posture.
