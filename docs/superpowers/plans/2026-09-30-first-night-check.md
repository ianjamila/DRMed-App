# First-night check (Sheet Sync follow-ups, Phase 3) — plan

Branch `feat/first-night-check`, worktree `.worktrees/first-night-check`, off origin/main 7486fe1c.
Migration **0199** claimed (`npm run claim -- list`). No new P-codes.

## Goal

A read-only check the owner runs on the night the Sheet Sync is switched on (and any time after).
For a date range it proves that every screen showing "New patients" agrees, and flags any day
whose new-patient count jumps above a threshold (an import-night spike like ~560).

Two front doors, one engine:
- **Admin › Sheet Sync › "First-night check"** (a 5th view on `/staff/admin/sheet-sync`).
- **CLI** `npm run first-night:check` (local by default, `--prod` for the live database).

## Decisions

- D1 **One engine.** `src/lib/marketing/first-night-check.ts` (pure: params, comparison, verdict)
  + `first-night-check.server.ts` (fetches). Both front doors call `runFirstNightCheck(client, …)`.
  It reads ONLY through the existing loaders in `patient-sources.server.ts`
  (`loadPatientSourcesSummary`, `loadPatientSourcesSeries`, `loadNewPatientsToday`) and the
  surfaces' own formatters (`formatNewToday`, `newPatientsTile`) — never `.rpc(...)` directly
  (`patient-sources-surfaces.test.ts` enforces this; extend it to pin the check module too).
- D2 **What is compared** for range R = [from, to], every number split confirmed / unconfirmed:
  1. *Patient Sources card* — `loadPatientSourcesSummary(R)` → `new_confirmed`, `new_unconfirmed`.
  2. *Booking Sources card* — its own separate `loadPatientSourcesSummary(R)` call, rendered with
     `newPatientsTile` (the page's formatter); its string must equal the Patient Sources card's.
  3. *Patient Sources chart* — `loadPatientSourcesSeries(R, "day", "new")`, summed.
  4. *Dashboard "New today" tile* — for each day d: `formatNewToday(loadNewPatientsToday(d))`
     (total + unconfirmed), summed over R.
  5. *Per day d*: summary(d,d) vs the chart's bucket d vs the tile for d.
  6. *Sum of days* — Σ summary(d,d) must equal summary(R) (a person is New on exactly one day).
  Any difference = **mismatch**. If one is found (e.g. the summary counts an unconfirmed
  "returning" identity the chart drops), report it — never adjust the check to hide it.
- D3 **Spike** = a day whose New count (max over the day's surfaces) is above the threshold.
  Default threshold **40** (normal is single digits/day); allowed 1–100,000. Show the median and
  max daily count beside it.
- D4 **Context column (not judged):** patient records created that Manila day
  (`patients.created_at` in [d 00:00+08, d+1 00:00+08)), split *app registrations*
  (`legacy_import_run_id is null`) vs *imported* (not null — Sheet Sync creates set it). This is
  what shows "560 records were created last night but New patients stayed at 6 — good". Use
  `count: "exact", head: true` queries.
- D5 **Also shown:** sync paused?, last synced at, last run status, undated registrations
  (footnote; never on a day) — all already in the summary row.
- D6 **Verdict:** `error` (any load failed — name which) > `mismatch` > `spike` > `pass`.
  CLI exit codes: 0 pass, 1 mismatch or error, 2 spike only.
- D7 **Range limits:** from ≥ `PATIENT_SOURCES_MIN_DATE` (2023-12-01), from ≤ to, to ≤ today
  (Manila). Panel ≤ 31 days (it makes ~3 calls per day); CLI ≤ 400 days (the RPC limit).
  Default range = the last 7 days ending today. Per-day calls run with concurrency 4 (lift the
  private `mapWithConcurrency` from `queue/actions.ts` into a shared `src/lib/async/` helper
  and reuse it there).
- D8 **Panel runs only on request**: GET form (`view=check&from=&to=&threshold=&run=1`) so the
  result is linkable and a plain page visit costs nothing. `requireAdminStaff()` already guards
  the page; the RPCs refuse non-admins (View-as reception is refused — say so plainly).
- D9 **No audit row**: counts only, no names or ids leave the database.
- D10 **Migration 0199** (`0199_patient_sources_service_read.sql`): the CLI runs with the
  service key and `has_role()` is false without a signed-in user. Re-create
  `patient_sources_summary(date,date)` and `patient_sources_series(date,date,text,text)` with
  bodies copied VERBATIM from 0189 (0193 did not touch them — confirm with grep) except the gate:
  `if not (public.has_role(array['admin']) or (select auth.role()) = 'service_role') then`.
  Grant EXECUTE to `service_role` explicitly. Post-conditions: anon ✗, authenticated ✓,
  service_role ✓, and `pg_get_functiondef` of both contains the service_role branch. This adds
  no exposure — the service key already reads every underlying table — and Phase 5's weekly
  email cron needs the same access. User approved 2026-09-30.

## Tasks

1. **Migration 0199 + db proof.** Write the file (header explains why + "additive, no signature
   change"). Extend `scripts/patient-sources-db-proof.ts`: service_role claims get rows from
   summary and series and the SAME numbers as the admin session; authenticated non-admin and
   anon still refused (42501 / permission denied); admin viewing-as-reception still refused.
   Control: with the gate change reverted locally the service_role case must FAIL. Run on an
   ISOLATED stack only (copy `supabase/` to scratchpad, new `project_id`, ports +3000,
   Postgres image pinned 17.6.1.167, `supabase start --workdir`, `stop --no-backup` after) —
   never reset the shared stack. `database.ts` is unchanged (no signature change) — confirm.
2. **Pure module + tests** (`first-night-check.ts`): `parseCheckParams(raw, { maxDays, today })`
   → ok/errors (plain-English messages); `enumerateDays`; `evaluateCheck(input)` → report with
   verdict, mismatches (which surface, which day, both numbers), spikes, median/max; formatters
   for the CLI table. Tests cover every mismatch kind, the spike edge (= threshold is NOT a
   spike), error precedence, empty range days, and bad params.
3. **Server engine** (`first-night-check.server.ts`, `import "server-only"`): builds the input
   via the loaders (D2/D4/D5), concurrency 4, returns the report + duration. Test with a fake
   client (pattern: existing `*.server` tests if any; otherwise inject the loaders).
4. **Panel**: `first-night-check.tsx` under `admin/sheet-sync/`, view key `check`, label
   "First-night check". Form (From / To / Spike threshold / Run check), verdict `Alert`
   (pass = green "All screens agree", spike = amber, mismatch/error = red), range-totals table
   (the 4 surfaces + sum of days), per-day table (date · Patient Sources · chart · dashboard
   tile · records created: app / imported · flag), spike rows highlighted, links to Patient
   Sources and Booking Sources for the same period, and the equivalent CLI command. Match the
   page's existing components/table styles (`run-history.tsx`). jsdom render test with a
   fixture report (pass, spike, mismatch, error).
5. **CLI** `scripts/first-night-check.ts` + `"first-night:check": "tsx --require
   ./scripts/lib/server-only-shim.cjs scripts/first-night-check.ts"`. Flags `--from --to --days
   --threshold --json --prod`. `import "./lib/load-env"`; `requireLocalOrExplicitProd(
   "first-night:check", { writes: "nothing — reads New-patient counts and patient created counts" })`
   BEFORE any client is built; dynamic imports after (as `scripts/sheet-sync.ts`). No --commit.
   `guard-coverage.test.ts` must pass.
6. **Docs**: user guide (Sheet Sync section: the new view, what each verdict means, what to do
   on a mismatch/spike; bump version + date), CLAUDE.md (commands table row; drop the stale
   "0184 is ahead of #263" workaround — #263 merged as 6d2ecfe0; ledger line for 0199 after the
   prod push), `drmed-migrations` / `drmed-staff-ui` skills where they cite the Patient Sources
   ACLs or the Sheet Sync views.
7. **Gate + review**: `npm test`, `typecheck`, `lint`, `build`, db proof on the isolated stack.
   Sonnet review. Then: ask the user → push, PR, `supabase db push` (dry run must list only
   0199), verify by object, run `npm run first-night:check -- --prod` for the real numbers in
   the PR body, ask before merge, confirm the Vercel deploy is READY.
