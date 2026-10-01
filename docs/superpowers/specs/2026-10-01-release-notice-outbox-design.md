# Release-notice outbox — durable retry + dedup for "your result is ready"

Status: approved 2026-10-01 (owner decisions below). Follow-up #6 of the lab-release-on-queue programme.

## Problem

Every release funnels through `releaseVisitSelection` (`src/lib/actions/visits/release-reports.ts`):
`release_visit_results` RPC (0205) → `notifyReleased` → `notifyResultReleased` / `notifyResultsReleasedBulk`.

- **Lost:** a provider error is reported + audited (`result.notified` with `email.error`) and never retried; a
  crash/timeout between the RPC commit and the TS send leaves a released result with no notice and no record.
- **Duplicated:** undo (0205) cancels nothing; a re-release sends a second "ready" message. Retrying naively
  inside a timed-out request would double-send (Resend gets no `Idempotency-Key`; Semaphore SMS has none).
- **Batch-Undo trap:** Undo's `changedSince` guard reads later audit rows, so any `result.notified` written later
  MUST carry the release's `bulk_batch_id` (as today).

## Owner decisions (2026-10-01)

1. **Re-release:** if the same tests were already successfully announced (`sent`) in the last **24 h**, the new
   notice is `suppressed` (no second message). If the earlier one was never sent (e.g. Undo cancelled it), send.
2. **Retry horizon:** 5 attempts — backoff 5 min, 15 min, 1 h, 4 h, 12 h — and never past 24 h from creation (the
   Resend idempotency window); then `abandoned`, listed on Result Follow-ups with a manual Retry.
3. **Sweeper:** Supabase **pg_cron** every 5 min calling a protected app route via **pg_net** (Vercel crons stay
   daily). URL + secret come from **Vault**; with either missing the job does nothing.
4. **SMS after an ambiguous outcome:** never resend (at-most-once). Email retries continue.

## Design

### Table `public.release_notices` (ids only — no phone, email or message body; RA 10173)

One row per release call per visit (what `notifyReleased` already announces).
`id`, `visit_id`, `released_at` (the RPC's `now()`), `test_request_ids uuid[]`, `release_medium`, `bulk_batch_id`,
`status` (`pending|sending|retry|sent|skipped|suppressed|cancelled|abandoned`), per-channel `email_state` /
`sms_state` (`todo|sent|skipped|failed|unknown`), provider ids, `attempts`, `next_attempt_at`, `lease_token`,
`lease_expires_at`, `last_error` (sanitised, never an address), `skip_reason`, `created_at`, `sent_at`,
`resolved_at`. **Unique `(visit_id, released_at)`.**

RLS on, no policies; ACLs stated by name (revoke from public/anon/authenticated, grant service_role); functions
`set search_path`, EXECUTE service_role-only — and checked against the 0201/0207 `api_request_guard` (prod image
.111 segfaults on a refused function call; see memory `supabase-postgres-denied-function-segfault`).

### Enqueue inside the release transaction

`release_visit_results` inserts the row in the same transaction as the line writes and audit rows and returns
`notice_id`; a commit always leaves a durable pending notice. Policy rules (sample, physical/pickup, inactive,
doctor line, no contact) stay in TS and resolve the row to `skipped` at send time — one owner for the rules.
`undo_visit_release` cancels `pending|retry` rows whose every member it undid.

### Sender

- **Fast path stays:** after the RPC the action calls `claim_release_notice(id)`, sends, then
  `finish_release_notice(id, lease_token, …)`. Outcome gains `retrying` ("will retry automatically").
- `claim_release_notice(p_id, p_limit)`: `FOR UPDATE SKIP LOCKED` over due `pending|retry` rows plus `sending` rows
  whose lease expired; sets `sending`, a fresh `lease_token`, `lease_expires_at = now() + 3 min`, `attempts + 1`.
  The sweeper ignores rows younger than ~2 min (the inline send owns them).
- **Re-check at send time** (shared TS, extracted from `notify-released*.ts`): tests still released with this
  `released_at` (drop undone ones; none left → `cancelled`), visit live and not sample, medium not physical/pickup,
  patient active with contact details, decision 1 (`suppressed`), and a strict enabled flag (missing row or read
  error = do nothing).
- **No double send:** `finish` is fenced on `lease_token`; email carries `Idempotency-Key: result-notice:<id>:email:<12-hex hash of the rendered subject+text>` (identical content dedups across a crash; changed content gets a new key instead of a Resend 409 loop; after an `invalid_idempotent_request` 409 the attempt number is mixed in);
  SMS writes `sms_state = 'unknown'` before sending and is never resent from `unknown` (decision 4).
- `finish` writes `result.notified` once, at the terminal state, with `bulk_batch_id` and `review_cta.shown` only
  when the email went out. New audits: `result.notice_abandoned|cancelled|suppressed`.

### Visibility

Failed / abandoned notices on `/staff/result-follow-ups` (existing `RetryNoticeButton` pattern) with manual Retry
(resets `attempts` / `next_attempt_at`, still fenced by the claim). Cron health gets the new job.

## PRs

1. **Migration A (inert):** table, ACLs, `claim_release_notice`, `finish_release_notice`, enabled flag seeded OFF,
   concurrency proof (two claimers, inline vs sweeper, stale-lease fenced finish) + guard REGISTRY.
2. **TS + cron:** shared sender/re-check, `retrying` outcome, email idempotency key, `/api/cron/release-notices`
   (CRON_SECRET, heartbeat registration in all three places), migration enabling pg_cron/pg_net + the 5-min job
   reading Vault, follow-ups page rows + manual Retry. Uses the outbox only when the flag is on AND a `notice_id`
   came back; otherwise the legacy path is unchanged.
3. **Migration B:** re-create `release_visit_results` (enqueue + `notice_id`, gated in SQL by the strict flag) and
   `undo_visit_release` (cancel); update `fake-release-db.ts`; extend the report-release proof.
   PR 3 must also: (a) set `resolved_at` on any row it inserts as `suppressed` / `cancelled` and on any
   `pending` / `retry` row `undo_visit_release` cancels (a CHECK ties every terminal status to `resolved_at`;
   `sent_at` only with `sent`; `audited_at` only once resolved); (b) the report-release concurrency proof must
   set and restore `release_notice_settings.enabled` itself once release enqueues, since the flag is OFF by default.

   (c) **Flag race at fast-path time.** When a release returns `notice_id`, the app must use the outbox path regardless of the flag read at send time, because the row exists only because the flag was ON in the release transaction. If the flag is OFF at fast-path time, cancel that row (fenced) and run the legacy send, so the notice is never both legacy-sent and swept later. PR 3 therefore needs a fenced cancel function (e.g. `cancel_release_notice(p_id)`: `pending` -> `cancelled` with `resolved_at`, no lease needed) or must reuse `finish_release_notice` via a claim. (PR 2's fast path currently falls back to the legacy send when the flag reads OFF; that is correct only while no row is ever enqueued, i.e. until PR 3.)

   Added in PR 1 review: `release_notices.audited_at` + `mark_release_notice_audited(p_id)` (fenced stamp on a
   terminal row, false on a second call). PR 2 writes the terminal audit row, then stamps; its sweeper also picks up
   terminal rows with `audited_at is null` (a crash between finish and the audit write, or a claim that closed an
   exhausted lease as `abandoned`) and audits them, idempotent through the stamp. `last_error` / `skip_reason`
   are redacted of addresses and phone-shaped digit runs in SQL; a `sent` finish clears `last_error`.

Then: set the Vault secrets, flip the flag on prod after verifying. Rollback = flip the flag off (never delete
the row).
