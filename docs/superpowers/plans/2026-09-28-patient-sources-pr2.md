# Patient Sources (Sheet Sync PR 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Use Sonnet for every sub-agent (implementers and reviewers)** unless a task below says otherwise.

**Goal:** Give admins a Marketing › Patient Sources report — new and served customers per day/week/month by channel, confirmed vs unconfirmed, channel revenue with a double-entry panel, top referring doctors, cost per new patient from saved ad spend — plus the Booking Sources "New patients" card (A′), an admin dashboard tile, and the reception "How did you hear about us?" prompt on the new-visit form.

**Architecture:** All counting lives in one additive SQL migration (**0189**): a private identity core (`_patient_sources_identities()` / `_patient_sources_encounters()` / `_ps_revenue_lines()`) that resolves merged patients to survivors and computes each person's first encounter over the whole history, and seven admin-gated `security definer` report functions that read only that core. A new `ad_spend_daily` table is written only by two admin RPCs fed by a pure TS CSV parser that re-parses the raw upload on the server. Pages are Server Components that call the RPCs through the RLS-scoped server client via ONE loader module; the only client JS is the chart, the remove-spend form and the existing Ad Performance upload.

**Tech Stack:** Next.js 16 App Router (server components, server actions, route handlers), Supabase Postgres (plpgsql, RLS), supabase-js, recharts via `next/dynamic`, papaparse, vitest, `pg` (hand-run DB proof).

**Spec:** `docs/superpowers/specs/2026-09-28-patient-sources-pr2-design.md` (APPROVED 2026-09-28, commit 50b32f77) — it supersedes §6 of `docs/superpowers/specs/2026-09-24-sheet-sync-and-patient-sources-design.md` wherever they differ.

**Worktree / branch:** `~/Claude/DRMed/.worktrees/patient-sources`, `feat/patient-sources`. `origin/main` (9b162fdf, #244) was merged in at the start of planning (merge commit b6477620).

---

## 0. Decisions made while planning (binding; copy into the spec in Task 18)

| # | Decision | Why |
|---|---|---|
| P1 | Migration **0189** (`0189_patient_sources.sql`), claimed with `npm run claim -- migration` on 2026-09-28. **No new P-codes**: standard SQLSTATEs only — `42501` (not admin), `22023` (bad period / grain / mode / ad rows), `feature_not_supported` = `0A000` (converted mode). | Spec §4 "standard SQLSTATEs preferred". `pg-error-coverage.test.ts` accepts any errcode. |
| P2 | Survivor resolution is a SQL helper `_ps_survivors()` — a recursive walk of `patients.merged_into_id` capped at 10 hops, like `buildPatientIndex().survivor`. A chain longer than 10 (or a cycle) yields no survivor, so that patient's rows drop out rather than being mis-attributed. | Spec §1.1. |
| P3 | The **loose key of a confirmed patient** (needed for the §1.3 suppression rule) is computed in SQL by `_ps_loose_key(last, first)`, the twin of `looseKeyOf` + `normalizeName` (`src/lib/sheet-sync/names.ts`, `src/lib/legacy-import/normalize-name.ts`). Parity is proven in the DB proof against the TS function on a case table. The loose keys of the patient's linked Customers rows are also used. | No SQL twin exists (0170 stores keys computed in TS). |
| P4 | **Returning** is read from `patient_acquisition_facts` only: the `sheet_new_repeat` of the group's earliest-dated fact (tie → `repeat`); when no fact in the group has a date, any `repeat` wins. Name identities are never "Returning". | Spec §1.1/§1.3 define Returning on facts; the conservative tie rule extended to undated facts. |
| P5 | **Undated** = a confirmed or name identity with no encounter since 2023-12-01, no registration date, and (for confirmed) no live visit **before** 2023-12-01. A patient who only visited before Dec 2023 is an old customer, not an undated registration — it is counted nowhere (`basis = 'before_window'`). Footnote wording: "U people registered with no date and no recorded visit — not on any day." Expect U < 962 on prod after unpause: the 962 figure counted Customers rows, many of which have a dated visit. | Spec §3.2's footnote exists so undated registrations are never put on a day; counting visitors-with-a-date there would misreport them. |
| P6 | Unlinked Customers rows (`patient_id is null` — the review holds, ~84 on prod) are **unconfirmed name identities** `name:<loose_key>`; with no encounter they count on `min(registered_on)`. | Spec §1.1 "name identities stay as they are: unconfirmed". |
| P7 | `patient_sources_series` also accepts `p_grain = 'period'` (one bucket = the whole period, `bucket_start = p_from`). The per-channel table, the previous-period comparison and the CSV use it. | "All customers served" is distinct over the period; summing day buckets would count a person served twice twice. |
| P8 | `patient_sources_summary` returns two more columns than the spec lists — `sync_paused boolean`, `last_synced_at timestamptz` — for the §3.2 banner, so the page makes one read. | One definition, one call. |
| P9 | `patient_sources_overlaps` also returns `drm_id`; `patient_sources_people` also returns `identity` and `total_count`, and accepts `p_mode = 'returning'` (the Returning card links to it). | The panel shows DRM-ID (spec §3.2.7); the pager needs a total (CLAUDE.md "no silent caps"). |
| P10 | Two small admin-gated functions the spec implies but does not name: `ad_spend_daily_totals(p_from, p_to)` (per day × platform) and `ad_spend_coverage()` (per platform: first/last date, days, total) — PostgREST cannot aggregate. | CLAUDE.md "PostgREST limits". |
| P11 | The **referrer normaliser** lives in SQL (`_ps_doctor_norm`) because the grouping happens there; its case table is in the DB proof. A TS twin would be dead code. It also drops placeholder answers (`none`, `n a`, `na`, `no`, `nil`, `self`). | Spec §5 listed it under vitest; moved, not dropped. |
| P12 | CSV routes follow the repo pattern: `/api/admin/reports/patient-sources.csv` (counts) and `/api/admin/reports/patient-sources-people.csv` (names), through `reportCsvResponse` → audit actions `report.patient_sources.exported` and `report.patient_sources_people.exported`. | Spec §3.4 says "report-CSV pattern"; this is that pattern's path and naming. |
| P13 | Period presets on both Marketing report pages: **Today, Yesterday, Last 7 days, This month, Last month** (spec) **+ Year-to-date, Last 12 months, Last year** (kept from Booking Sources so nothing regresses) + **Custom**. "This year (2026)" is dropped: for these reports it shows exactly the same data as Year-to-date. | User rule 1 (no silent regression); max span 400 days still holds for every preset. |
| P14 | The Ad Performance upload is **re-parsed on the server** from the raw CSV text (≤ 5 MB); rows computed in the browser are never trusted. Google's two title lines above the header row and a UTF-8 BOM are skipped; Google "Total:" rows are ignored, not rejected. Ambiguous numeric dates follow the in-browser view (month first unless the first number is > 12). | Spec §2.2; the RPC is all-or-nothing. |
| P15 | Reception prompt: the patient update uses the RLS server client, is conditional on `referral_source is null`, never blocks the visit, and is audited `patient.referral_source_recorded` (`{ referral_source, via: 'new_visit' }`). It sits inside `createVisitAction`, whose own `assertPatientActive(` call already satisfies `write-guards.test.ts`. | Spec §3.7; RLS policy `patients: staff full` allows reception UPDATE; 0170's trigger stamps origin `staff` when `app.referral_origin` is unset. |
| P16 | Cost per new patient maps Meta → `online_facebook` and Google → `online_google` only (spec). Instagram/TikTok are not attributed to Meta spend; the card says so. | Spec §2.3. |
| P17 | `has_role` follows View-as (0182): an admin viewing as reception is refused by every report function. That is the spec's access matrix, not a bug. | Spec §5. |

## 1. How counting works (reference for Tasks 2–4)

- **Encounter** (since 2023-12-01; mirror mode only): (a) a live app visit (`visits.deleted_at is null`) whose date is before `sheet_sync_settings.mirror_window_start` **or** whose `legacy_import_run_id is null`; (b) a `sheet_encounter_lines` row. The patient on either is resolved to its live survivor (P2); a deleted survivor drops the row. A mirror line with `patient_id is null` belongs to `name:<loose_key>`.
- **Identity**: `patient:<survivor uuid>` (confirmed) or `name:<loose_key>` (unconfirmed).
- **First date** per identity over the whole history: first encounter → else registration date (not suppressed) → else undated / before_window. Registration date of a confirmed group = min over members of (facts `registered_on` when a facts row exists, else Manila `created_at` date when app-native, else nothing). Suppressed = no encounter and a `name:` identity with one of the patient's loose keys has an encounter.
- **New in [from, to]** = identities with basis `encounter`/`registration`, not Returning, first date in range. **Returning** = confirmed, Returning (P4), first date in range. **Served** = distinct identities with an encounter in range.
- **Channel**: confirmed → survivor `referral_source` else `not_recorded`; name → the mapped `referral_source_id` of the ONE Customers row with that loose key, else `not_recorded`.
- **Revenue**: live `test_requests.final_price_php` of stream-(a) visits in range (both deleted filters) + `sheet_encounter_lines.revenue_php` in range, except mirror lines whose (survivor, date) also has a stream-(a) visit — those are listed by `patient_sources_overlaps` instead.
- **Converted mode** (`converted_at is not null`): every report function raises `feature_not_supported`.

## 2. File map

**Create**
| File | Responsibility |
|---|---|
| `supabase/migrations/0189_patient_sources.sql` | helpers, identity core, 7 report functions, `ad_spend_daily` + 4 ad-spend functions, ACLs, post-conditions |
| `scripts/patient-sources-db-proof.ts` | hand-run local proof (ACL matrix, counting rules, controls) |
| `src/lib/marketing/period.ts` (+ `.test.ts`) | marketing presets, period resolution, href builder, `firstParam` |
| `src/lib/marketing/patient-sources.ts` (+ `.test.ts`) | pure: types, labels, parsers of mode/grain, previous period, channel table, chart rows, cost per new patient, dashboard tile, error classifier, CSV rows |
| `src/lib/marketing/patient-sources.server.ts` | the ONE caller of the report RPCs (loaders) |
| `src/lib/marketing/patient-sources-surfaces.test.ts` | guard: RPC names appear only in the allowed files; each surface uses the shared loader |
| `src/lib/marketing/ad-spend-import.ts` (+ `.test.ts`) | pure CSV → rows/rejections parser, header locator, save-result wording |
| `src/app/(staff)/staff/(dashboard)/marketing/_components/period-controls.tsx` | shared preset chips + custom range form |
| `src/app/(staff)/staff/(dashboard)/marketing/ad-spend-actions.ts` | `"use server"`: `saveAdSpendAction`, `removeAdSpendAction` |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx` | Patient Sources page |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/_components/channel-chart.tsx` | recharts stacked bars (client) |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/_components/channel-chart-loader.tsx` | `next/dynamic` wrapper (client) |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/_components/report-sections.tsx` | server-rendered tables: channels, revenue + overlaps, referrers, cost |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/_components/ad-spend-remove-form.tsx` | two-step confirm remove form (client) |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/people/page.tsx` | people list (audited) |
| `src/app/api/admin/reports/patient-sources.csv/route.ts` | counts CSV |
| `src/app/api/admin/reports/patient-sources-people.csv/route.ts` | people CSV |

**Modify**
| File | Change |
|---|---|
| `src/lib/dates/manila.ts` (+ its test) | add `daysBetweenISO` |
| `src/lib/staff/route-names.ts` | `/staff/marketing/patients`, `/staff/marketing/patients/people` |
| `src/app/(staff)/staff/(dashboard)/marketing/_components/marketing-tabs.tsx` | 4th tab |
| `src/app/(staff)/staff/(dashboard)/marketing/sources/page.tsx` | shared period controls; A′ card; table + patients read removed; subtitle |
| delete `src/app/(staff)/staff/(dashboard)/marketing/sources/_components/period-chips.tsx` | replaced by `period-controls.tsx` |
| `src/lib/marketing/booking-sources.ts` (+ test) | remove the now-unused new-patient summariser |
| `src/app/(staff)/staff/(dashboard)/marketing/_components/ad-dashboard.tsx` | upload also saves to the database |
| `src/lib/dashboards/cards.ts` (+ test), `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx` | `admin.new_patients_today` tile |
| `src/lib/patients/referral-sources.ts` (+ test) | `parseReferralAnswer` |
| `src/app/(staff)/staff/(dashboard)/visits/new/{page.tsx,visit-form.tsx,actions.ts}` | reception prompt |
| `src/lib/patients/query-surfaces.test.ts` | drop the Booking Sources `patients` entry |
| `src/lib/sheet-sync/mirror-readers.test.ts` | allow 0189 + the proof script |
| `src/types/database.ts` | `npm run db:types` |
| `package.json` | `"patient-sources:db-proof"` script |
| `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `.claude/skills/drmed-migrations/SKILL.md`, the PR 2 spec | docs |

---

# Phase A — database

### Task 1: Local stack on the safe Postgres image

**Files:** `supabase/.temp/postgres-version` (gitignored)

- [ ] **Step 1: Pin the image.** `.106`/`.111` segfault on any EXECUTE-denied call, and the proof makes many (memory `supabase-postgres-denied-function-segfault`).

```bash
cd ~/Claude/DRMed/.worktrees/patient-sources
mkdir -p supabase/.temp && printf '17.6.1.167' > supabase/.temp/postgres-version
docker ps --format '{{.Names}} {{.Image}}' | grep supabase_db_DRMed
```
Expected: `supabase_db_DRMed public.ecr.aws/supabase/postgres:17.6.1.167`. If it shows another tag, stop and ask the user; the stack is shared with other sessions.

- [ ] **Step 2: Know who else uses the stack.** The local Supabase stack is shared by every worktree (memory `drmed-migration-number-collision`). Before any `supabase db reset`, run `select version from supabase_migrations.schema_migrations order by version desc limit 3` (psql is `/opt/homebrew/opt/libpq/bin/psql`, URL `postgresql://postgres:postgres@127.0.0.1:54322/postgres`). **Never reset while another session's proof is running.** Prefer applying 0189 with `psql -f` (Task 2 Step 3) over a reset; a reset is only for the final full-replay check (Task 19).

### Task 2: Migration 0189 — helpers and the identity core

**Files:**
- Create: `supabase/migrations/0189_patient_sources.sql`

- [ ] **Step 1: Write the file header and helpers.**

```sql
-- =============================================================================
-- 0189_patient_sources.sql — Sheet Sync PR 2: Marketing › Patient Sources
-- =============================================================================
-- Spec: docs/superpowers/specs/2026-09-28-patient-sources-pr2-design.md
-- (supersedes §6 of the 2026-09-24 sheet-sync spec). Plan decisions P1–P17 in
-- docs/superpowers/plans/2026-09-28-patient-sources-pr2.md.
--
-- Additive only: private helpers (no grants), seven admin-gated report
-- functions, the ad_spend_daily table and its four functions. Nothing here
-- writes a patient, a visit or a mirror row.
--
-- Mirror mode only. When sheet_sync_settings.converted_at is set, every report
-- function raises feature_not_supported; PR 4 replaces that branch and owns the
-- before/after/purge equivalence proof (parent spec §8).
-- =============================================================================

-- (1) Name keys — the SQL twin of normalizeName (src/lib/legacy-import/
-- normalize-name.ts) and looseKeyOf (src/lib/sheet-sync/names.ts). Parity is
-- proven by scripts/patient-sources-db-proof.ts against the TS functions.
create or replace function public._ps_name_norm(p text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        replace(
          lower(regexp_replace(normalize(coalesce(p, ''), NFD),
                               '[' || U&'\0300' || '-' || U&'\036F' || ']', '', 'g')),
          '''', ''),
        '[^a-z0-9[:space:]]', ' ', 'g'),
      '[[:space:]]+', ' ', 'g'))
$$;

create or replace function public._ps_loose_key(p_last text, p_first text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select public._ps_name_norm(p_last) || '|'
      || split_part(public._ps_name_norm(p_first), ' ', 1)
$$;

-- (2) Referring-doctor key: name-normalised, a leading title dropped, and
-- placeholder answers treated as blank. The most common raw spelling is the
-- label (patient_sources_referrers).
create or replace function public._ps_doctor_norm(p text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select case when k in ('none', 'n a', 'na', 'no', 'nil', 'self') then null else k end
  from (
    select nullif(btrim(regexp_replace(public._ps_name_norm(p), '^(dra|dr|doc|doctor)( |$)', '')), '') as k
  ) x
$$;

-- (3) Merged patients → survivor, bounded like buildPatientIndex().survivor.
-- A chain over 10 hops (or a cycle) yields no row: the patient drops out
-- instead of being counted under the wrong person.
create or replace function public._ps_survivors()
returns table (patient_id uuid, survivor_id uuid)
language sql
stable
set search_path = ''
as $$
  with recursive walk as (
    select p.id as patient_id, p.id as cur, p.merged_into_id as next_id, 0 as hops
    from public.patients p
    union all
    select w.patient_id, n.id, n.merged_into_id, w.hops + 1
    from walk w
    join public.patients n on n.id = w.next_id
    where w.hops < 10
  )
  select w.patient_id, w.cur from walk w where w.next_id is null
$$;

-- (4) Guards shared by every report function.
create or replace function public._ps_assert_mirror_mode()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (select 1 from public.sheet_sync_settings s where s.id and s.converted_at is not null) then
    raise exception 'Patient Sources does not read converted records yet'
      using errcode = 'feature_not_supported';
  end if;
end;
$$;

create or replace function public._ps_check_period(p_from date, p_to date)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'Pick a period whose start is on or before its end, at most 400 days long'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function public._ps_bucket(p_d date, p_grain text, p_from date)
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_grain
           when 'day'   then p_d
           when 'week'  then date_trunc('week', p_d::timestamp)::date   -- ISO: Monday
           when 'month' then date_trunc('month', p_d::timestamp)::date
           else p_from                                                  -- 'period'
         end
$$;
```

- [ ] **Step 2: Append the identity core.**

```sql
-- (5) Every encounter since 2023-12-01 (spec §1.2). One row per source line;
-- consumers take distinct (identity, service_date).
create or replace function public._patient_sources_encounters()
returns table (identity text, survivor_id uuid, loose_key text, service_date date, source text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window date;
begin
  perform public._ps_assert_mirror_mode();
  select s.mirror_window_start into v_window from public.sheet_sync_settings s where s.id;
  v_window := coalesce(v_window, date '2026-05-26');

  return query
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  )
  select 'patient:' || s.survivor_id::text, s.survivor_id, null::text, v.visit_date, 'app'::text
  from public.visits v
  join surv s on s.patient_id = v.patient_id
  where v.deleted_at is null
    and v.visit_date >= date '2023-12-01'
    and (v.visit_date < v_window or v.legacy_import_run_id is null)
  union all
  select case when l.patient_id is null then 'name:' || l.loose_key
              else 'patient:' || s.survivor_id::text end,
         s.survivor_id,
         case when l.patient_id is null then l.loose_key end,
         l.service_date,
         'sheet'::text
  from public.sheet_encounter_lines l
  left join surv s on s.patient_id = l.patient_id
  where l.service_date >= date '2023-12-01'
    and (l.patient_id is null or s.survivor_id is not null);
end;
$$;

-- (6) One row per identity with its whole-history first date (spec §1.1, §1.3;
-- plan §1, P3–P6). basis: encounter | registration | suppressed | undated |
-- before_window. Only encounter/registration rows are ever counted as New.
create or replace function public._patient_sources_identities()
returns table (
  identity     text,
  confirmed    boolean,
  survivor_id  uuid,
  loose_key    text,
  first_date   date,
  basis        text,
  is_returning boolean,
  channel      text
)
language sql
stable
set search_path = ''
as $$
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  ),
  enc as (
    select distinct e.identity, e.service_date from public._patient_sources_encounters() e
  ),
  first_enc as (
    select e.identity, min(e.service_date) as d from enc e group by e.identity
  ),
  member as (
    select s.survivor_id,
           case when f.patient_id is not null then f.registered_on
                when p.legacy_import_run_id is null then (p.created_at at time zone 'Asia/Manila')::date
           end as reg_on,
           f.registered_on as fact_on,
           f.sheet_new_repeat
    from surv s
    join public.patients p on p.id = s.patient_id
    left join public.patient_acquisition_facts f on f.patient_id = s.patient_id
  ),
  member_ranked as (
    select m.*, min(m.fact_on) over (partition by m.survivor_id) as min_fact_on from member m
  ),
  confirmed_reg as (
    select m.survivor_id,
           min(m.reg_on) as reg_on,
           case when bool_or(m.fact_on is not null)
                then coalesce(bool_or(m.sheet_new_repeat = 'repeat') filter (where m.fact_on = m.min_fact_on), false)
                else coalesce(bool_or(m.sheet_new_repeat = 'repeat'), false)
           end as is_returning
    from member_ranked m
    group by m.survivor_id
  ),
  old_visitors as (
    select distinct s.survivor_id
    from public.visits v
    join surv s on s.patient_id = v.patient_id
    where v.deleted_at is null and v.visit_date < date '2023-12-01'
  ),
  name_enc as (
    select e.identity from first_enc e where e.identity like 'name:%'
  ),
  confirmed_keys as (
    select r.survivor_id, public._ps_loose_key(sp.last_name, sp.first_name) as k
    from confirmed_reg r join public.patients sp on sp.id = r.survivor_id
    union
    select s.survivor_id, c.loose_key
    from public.sheet_customer_rows c join surv s on s.patient_id = c.patient_id
  ),
  suppressed as (
    select distinct k.survivor_id
    from confirmed_keys k join name_enc n on n.identity = 'name:' || k.k
  ),
  confirmed as (
    select 'patient:' || r.survivor_id::text as identity,
           true as confirmed,
           r.survivor_id,
           null::text as loose_key,
           case when fe.d is not null then fe.d
                when sup.survivor_id is not null then null
                else r.reg_on end as first_date,
           case when fe.d is not null then 'encounter'
                when sup.survivor_id is not null then 'suppressed'
                when r.reg_on is not null then 'registration'
                when ov.survivor_id is not null then 'before_window'
                else 'undated' end as basis,
           r.is_returning,
           coalesce(sp.referral_source, 'not_recorded') as channel
    from confirmed_reg r
    join public.patients sp on sp.id = r.survivor_id
    left join first_enc fe on fe.identity = 'patient:' || r.survivor_id::text
    left join suppressed sup on sup.survivor_id = r.survivor_id
    left join old_visitors ov on ov.survivor_id = r.survivor_id
  ),
  cust_by_key as (
    select c.loose_key,
           count(*) as n_rows,
           min(c.referral_source_id) as only_source,
           min(c.registered_on) filter (where c.patient_id is null) as unlinked_reg_on,
           bool_or(c.patient_id is null) as has_unlinked
    from public.sheet_customer_rows c
    group by c.loose_key
  ),
  name_ids as (
    select n.identity, substr(n.identity, 6) as k from name_enc n
    union
    select 'name:' || c.loose_key, c.loose_key from cust_by_key c where c.has_unlinked
  ),
  unconfirmed as (
    select ni.identity,
           false,
           null::uuid,
           ni.k,
           coalesce(fe.d, cb.unlinked_reg_on),
           case when fe.d is not null then 'encounter'
                when cb.unlinked_reg_on is not null then 'registration'
                else 'undated' end,
           false,
           case when cb.n_rows = 1 then coalesce(cb.only_source, 'not_recorded') else 'not_recorded' end
    from name_ids ni
    left join first_enc fe on fe.identity = ni.identity
    left join cust_by_key cb on cb.loose_key = ni.k
  )
  select * from confirmed
  union all
  select * from unconfirmed
$$;

-- (7) Revenue lines in a period (spec §1.6). overlap = a mirror line whose
-- (survivor, date) also has a stream-(a) app visit: excluded from revenue,
-- listed by patient_sources_overlaps.
create or replace function public._ps_revenue_lines(p_from date, p_to date)
returns table (identity text, survivor_id uuid, service_date date, source text, php numeric, overlap boolean)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window date;
begin
  perform public._ps_assert_mirror_mode();
  select s.mirror_window_start into v_window from public.sheet_sync_settings s where s.id;
  v_window := coalesce(v_window, date '2026-05-26');

  return query
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  ),
  app_visits as (
    select v.id as visit_id, s.survivor_id, v.visit_date
    from public.visits v
    join surv s on s.patient_id = v.patient_id
    where v.deleted_at is null
      and v.visit_date between greatest(p_from, date '2023-12-01') and p_to
      and (v.visit_date < v_window or v.legacy_import_run_id is null)
  ),
  app_days as (
    select distinct a.survivor_id, a.visit_date from app_visits a
  ),
  app as (
    select 'patient:' || a.survivor_id::text as identity, a.survivor_id, a.visit_date as service_date,
           'app'::text as source,
           coalesce(sum(tr.final_price_php), 0)::numeric(14,2) as php,
           false as overlap
    from app_visits a
    join public.test_requests tr on tr.visit_id = a.visit_id and tr.deleted_at is null
    group by a.survivor_id, a.visit_date
  ),
  sheet as (
    select case when l.patient_id is null then 'name:' || l.loose_key
                else 'patient:' || s.survivor_id::text end,
           s.survivor_id,
           l.service_date,
           'sheet'::text,
           coalesce(l.revenue_php, 0)::numeric(14,2),
           (s.survivor_id is not null and exists (
              select 1 from app_days d where d.survivor_id = s.survivor_id and d.visit_date = l.service_date))
    from public.sheet_encounter_lines l
    left join surv s on s.patient_id = l.patient_id
    where l.service_date between greatest(p_from, date '2023-12-01') and p_to
      and (l.patient_id is null or s.survivor_id is not null)
  )
  select * from app
  union all
  select * from sheet;
end;
$$;
```

- [ ] **Step 3: Apply just this part locally and smoke it.** (The report functions come in Task 3; apply with `psql -f`, never a reset — Task 1 Step 2.)

```bash
PSQL=/opt/homebrew/opt/libpq/bin/psql; DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
$PSQL "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0189_patient_sources.sql
$PSQL "$DB" -Atc "select public._ps_loose_key('Dela Cruz', 'Juan Santos'), public._ps_loose_key('O''Brian', 'Ma. Luisa'), public._ps_doctor_norm('Dra. María  Santos'), public._ps_doctor_norm('N/A')"
$PSQL "$DB" -Atc "select basis, count(*) from public._patient_sources_identities() group by 1 order by 1"
```
Expected: `dela cruz|juan|obrian|ma|maria santos|` (last field empty = NULL) and one line per basis with counts (local data is small; no error).

- [ ] **Step 4: Commit** — `git add supabase/migrations/0189_patient_sources.sql && git commit -m "feat(db): 0189 patient sources identity core (survivors, first dates, revenue lines)"`

### Task 3: Migration 0189 — report functions

**Files:**
- Modify: `supabase/migrations/0189_patient_sources.sql` (append)

Every public function: `language plpgsql`, `stable`, `security definer`, `set search_path = ''`, first statement `#variable_conflict use_column`, then the admin check, then `_ps_assert_mirror_mode()` and `_ps_check_period()`.

- [ ] **Step 1: Append the summary and series.**

```sql
-- (8) The ONE definition every surface reads (spec §1.7; plan P8).
create or replace function public.patient_sources_summary(p_from date, p_to date)
returns table (
  new_confirmed            int,
  new_unconfirmed          int,
  returning_first_recorded int,
  served_confirmed         int,
  served_unconfirmed       int,
  undated_registrations    int,
  source_recorded          int,
  source_total             int,
  sheet_last_dates         jsonb,
  sync_paused              boolean,
  last_synced_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);

  return query
  with ids as (
    select * from public._patient_sources_identities()
  ),
  newish as (
    select * from ids i
    where i.basis in ('encounter', 'registration') and i.first_date between p_from and p_to
  ),
  served as (
    select distinct e.identity from public._patient_sources_encounters() e
    where e.service_date between p_from and p_to
  )
  select
    (select count(*) from newish n where n.confirmed and not n.is_returning)::int,
    (select count(*) from newish n where not n.confirmed)::int,
    (select count(*) from newish n where n.confirmed and n.is_returning)::int,
    (select count(*) from served s where s.identity like 'patient:%')::int,
    (select count(*) from served s where s.identity like 'name:%')::int,
    (select count(*) from ids i where i.basis = 'undated')::int,
    (select count(*) from newish n where not n.is_returning and n.channel <> 'not_recorded')::int,
    (select count(*) from newish n where not n.is_returning)::int,
    (select coalesce(jsonb_object_agg(t.tab, t.last_date), '{}'::jsonb)
       from (select l.tab, max(l.service_date) as last_date
               from public.sheet_encounter_lines l group by l.tab
             union all
             select 'customers', max(c.registered_on)
               from public.sheet_customer_rows c having count(*) > 0) t),
    (select s.paused from public.sheet_sync_settings s where s.id),
    (select max(r.ended_at) from public.sheet_sync_runs r
      where r.status = 'succeeded' and not r.dry_run and r.trigger in ('cron', 'manual', 'cli'));
end;
$$;

-- (9) Channel × bucket counts, only non-empty cells (spec §1.7; plan P7).
create or replace function public.patient_sources_series(p_from date, p_to date, p_grain text, p_mode text)
returns table (bucket_start date, channel text, confirmed int, unconfirmed int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_grain is null or p_grain not in ('day', 'week', 'month', 'period') then
    raise exception 'Unknown grouping %', coalesce(p_grain, '(none)') using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('new', 'served') then
    raise exception 'Unknown count %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;

  if p_mode = 'new' then
    return query
    select public._ps_bucket(i.first_date, p_grain, p_from), i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from public._patient_sources_identities() i
    where i.basis in ('encounter', 'registration')
      and not i.is_returning
      and i.first_date between p_from and p_to
    group by 1, 2
    order by 1, 2;
  else
    return query
    with served as (
      select distinct public._ps_bucket(e.service_date, p_grain, p_from) as b, e.identity
      from public._patient_sources_encounters() e
      where e.service_date between p_from and p_to
    )
    select s.b, i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from served s
    join public._patient_sources_identities() i on i.identity = s.identity
    group by 1, 2
    order by 1, 2;
  end if;
end;
$$;
```

- [ ] **Step 2: Append revenue, overlaps, referrers and people.**

```sql
-- (10) Channel revenue, billed (clinic share) — spec §1.6.
create or replace function public.patient_sources_revenue(p_from date, p_to date)
returns table (channel text, confirmed_php numeric, unconfirmed_php numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);

  return query
  select i.channel,
         coalesce(sum(l.php) filter (where i.confirmed), 0)::numeric(14,2),
         coalesce(sum(l.php) filter (where not i.confirmed), 0)::numeric(14,2)
  from public._ps_revenue_lines(p_from, p_to) l
  join public._patient_sources_identities() i on i.identity = l.identity
  where not l.overlap
  group by i.channel
  order by i.channel;
end;
$$;

-- (11) "Possible double entry": same survivor, same day, app visit AND sheet lines.
create or replace function public.patient_sources_overlaps(p_from date, p_to date)
returns table (patient_id uuid, drm_id text, service_date date, app_php numeric, sheet_php numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);

  return query
  with lines as (
    select * from public._ps_revenue_lines(p_from, p_to)
  )
  select s.survivor_id, p.drm_id, s.service_date,
         coalesce((select sum(a.php) from lines a
                    where a.source = 'app' and a.survivor_id = s.survivor_id
                      and a.service_date = s.service_date), 0)::numeric(14,2),
         sum(s.php)::numeric(14,2)
  from lines s
  join public.patients p on p.id = s.survivor_id
  where s.source = 'sheet' and s.overlap
  group by s.survivor_id, p.drm_id, s.service_date
  order by s.service_date, p.drm_id;
end;
$$;

-- (12) Top referring doctors among the period's New customers (spec §1.7; P11).
create or replace function public.patient_sources_referrers(p_from date, p_to date, p_limit int default 20)
returns table (doctor_label text, new_confirmed int, new_unconfirmed int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);

  return query
  with ids as (
    select * from public._patient_sources_identities() i
    where i.basis in ('encounter', 'registration') and not i.is_returning
      and i.first_date between p_from and p_to
  ),
  surv as (
    select s.patient_id, s.survivor_id from public._ps_survivors() s
  ),
  raw as (
    select i.identity, true as confirmed,
           coalesce(
             nullif(btrim(sp.referred_by_doctor), ''),
             (select c.referred_by_raw
                from public.sheet_customer_rows c
                join surv s on s.patient_id = c.patient_id
               where s.survivor_id = i.survivor_id and nullif(btrim(c.referred_by_raw), '') is not null
               order by c.sheet_row desc
               limit 1)
           ) as raw_label
    from ids i
    join public.patients sp on sp.id = i.survivor_id
    where i.confirmed
    union all
    select i.identity, false,
           (select min(c.referred_by_raw) from public.sheet_customer_rows c
             where c.loose_key = i.loose_key having count(*) = 1)
    from ids i
    where not i.confirmed
  ),
  normed as (
    select r.confirmed, btrim(r.raw_label) as spelling, public._ps_doctor_norm(r.raw_label) as k
    from raw r where r.raw_label is not null
  ),
  spellings as (
    select n.k, n.spelling, count(*) as c from normed n where n.k is not null group by n.k, n.spelling
  ),
  labels as (
    select distinct on (s.k) s.k, s.spelling from spellings s order by s.k, s.c desc, s.spelling
  )
  select l.spelling,
         (count(*) filter (where n.confirmed))::int,
         (count(*) filter (where not n.confirmed))::int
  from normed n
  join labels l on l.k = n.k
  group by l.k, l.spelling
  order by count(*) desc, l.spelling
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

-- (13) The people behind a count (spec §3.3; P9). Total order (first_date, identity).
create or replace function public.patient_sources_people(
  p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)
returns table (
  identity_kind text,
  identity      text,
  patient_id    uuid,
  drm_id        text,
  display_name  text,
  first_date    date,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_mode is null or p_mode not in ('new', 'returning', 'served') then
    raise exception 'Unknown list %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;

  return query
  with ids as (
    select * from public._patient_sources_identities()
  ),
  picked as (
    select i.identity, i.confirmed, i.survivor_id, i.loose_key, i.first_date as d
    from ids i
    where p_mode in ('new', 'returning')
      and i.basis in ('encounter', 'registration')
      and i.first_date between p_from and p_to
      and i.is_returning = (p_mode = 'returning')
      and (p_channel is null or i.channel = p_channel)
    union all
    select i.identity, i.confirmed, i.survivor_id, i.loose_key, min(e.service_date)
    from public._patient_sources_encounters() e
    join ids i on i.identity = e.identity
    where p_mode = 'served'
      and e.service_date between p_from and p_to
      and (p_channel is null or i.channel = p_channel)
    group by i.identity, i.confirmed, i.survivor_id, i.loose_key
  )
  select case when k.confirmed then 'confirmed' else 'unconfirmed' end,
         k.identity,
         k.survivor_id,
         p.drm_id,
         case when k.confirmed
              then concat_ws(', ', p.last_name, concat_ws(' ', p.first_name, p.middle_name))
              else coalesce(
                (select l.name_raw from public.sheet_encounter_lines l
                  where l.patient_id is null and l.loose_key = k.loose_key
                  order by l.service_date, l.id limit 1),
                (select c.full_name_raw from public.sheet_customer_rows c
                  where c.patient_id is null and c.loose_key = k.loose_key
                  order by c.sheet_row limit 1))
         end,
         k.d,
         count(*) over ()
  from picked k
  left join public.patients p on p.id = k.survivor_id
  order by k.d, k.identity
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;
```

- [ ] **Step 3: Apply and smoke as an admin JWT.** Re-run the whole file (every statement is `create or replace`, so it is re-runnable until the table in Task 4 exists; Task 4 adds `if not exists` where needed).

```bash
$PSQL "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0189_patient_sources.sql
ADMIN=$($PSQL "$DB" -Atc "select id from public.staff_profiles where role='admin' and is_active limit 1")
$PSQL "$DB" -v ON_ERROR_STOP=1 -c "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$ADMIN','role','authenticated')::text, true); select * from public.patient_sources_summary('2026-06-01','2026-09-28'); select count(*) from public.patient_sources_series('2026-06-01','2026-09-28','week','served'); rollback;"
```
Expected: one summary row, a series count, no error. If there is no local admin, create one the way the proof does (Task 5 `setupFixtures`).

- [ ] **Step 4: Commit** — `git commit -am "feat(db): 0189 patient sources report functions"`

### Task 4: Migration 0189 — ad spend, ACLs and post-conditions

**Files:**
- Modify: `supabase/migrations/0189_patient_sources.sql` (append)

- [ ] **Step 1: Append the table and its four functions.**

```sql
-- (14) Ad spend per AD per day (spec §2.1). Writes only through the RPCs below.
create table if not exists public.ad_spend_daily (
  id             bigint generated always as identity primary key,
  spend_date     date not null,
  platform       text not null check (platform in ('meta', 'google')),
  campaign_key   text not null check (char_length(campaign_key) between 1 and 300),
  ad_key         text not null check (char_length(ad_key) between 1 and 300),
  campaign_label text not null check (char_length(campaign_label) <= 300),
  spend_php      numeric(12,2) not null check (spend_php >= 0),
  impressions    int check (impressions is null or impressions >= 0),
  clicks         int check (clicks is null or clicks >= 0),
  uploaded_by    uuid references auth.users(id),
  uploaded_at    timestamptz not null default now(),
  upload_id      uuid not null,
  constraint ad_spend_daily_key unique (spend_date, platform, campaign_key, ad_key)
);
create index if not exists ad_spend_daily_date on public.ad_spend_daily (spend_date, platform);

alter table public.ad_spend_daily enable row level security;
-- Literal revokes (not format() in a do block): seed-grant-parity.test.ts
-- regex-scans for them.
revoke all on public.ad_spend_daily from anon;
revoke all on public.ad_spend_daily from authenticated;
grant select on public.ad_spend_daily to authenticated;
drop policy if exists "ad_spend_daily: admin read" on public.ad_spend_daily;
create policy "ad_spend_daily: admin read" on public.ad_spend_daily
  for select to authenticated using ((select public.has_role(array['admin'])));

-- (15) Import: all-or-nothing upsert; duplicate keys inside one call are summed
-- (the parser already sums them — this keeps ON CONFLICT from touching a row twice).
create or replace function public.ad_spend_import(p_upload_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int := 0;
  v_replaced int := 0;
  v_days int := 0;
  v_n int;
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can save ad spend' using errcode = '42501';
  end if;
  if p_upload_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Ad spend import needs an upload id and a list of rows' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 or v_n > 20000 then
    raise exception 'Ad spend import takes 1 to 20,000 rows, got %', v_n using errcode = '22023';
  end if;

  with src as (
    select r.spend_date, r.platform, r.campaign_key, r.ad_key,
           max(r.campaign_label) as campaign_label,
           sum(r.spend_php) as spend_php,
           sum(r.impressions)::int as impressions,
           sum(r.clicks)::int as clicks
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int)
    group by r.spend_date, r.platform, r.campaign_key, r.ad_key
  ),
  up as (
    insert into public.ad_spend_daily as a
      (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php,
       impressions, clicks, uploaded_by, uploaded_at, upload_id)
    select s.spend_date, s.platform, s.campaign_key, s.ad_key, s.campaign_label, s.spend_php,
           s.impressions, s.clicks, auth.uid(), now(), p_upload_id
    from src s
    on conflict (spend_date, platform, campaign_key, ad_key) do update
      set campaign_label = excluded.campaign_label,
          spend_php      = excluded.spend_php,
          impressions    = excluded.impressions,
          clicks         = excluded.clicks,
          uploaded_by    = excluded.uploaded_by,
          uploaded_at    = excluded.uploaded_at,
          upload_id      = excluded.upload_id
    returning (xmax = 0) as inserted, a.spend_date
  )
  select count(*) filter (where u.inserted), count(*) filter (where not u.inserted), count(distinct u.spend_date)
    into v_inserted, v_replaced, v_days
  from up u;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', 'ad_spend.imported', 'ad_spend_upload', p_upload_id,
          jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days));

  return jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days);
end;
$$;

-- (16) Correction: remove saved spend for one platform over a date range.
create or replace function public.ad_spend_delete(p_platform text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can remove ad spend' using errcode = '42501';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google') then
    raise exception 'Unknown ad platform %', coalesce(p_platform, '(none)') using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Pick a start date on or before the end date' using errcode = '22023';
  end if;

  delete from public.ad_spend_daily a
  where a.platform = p_platform and a.spend_date between p_from and p_to;
  get diagnostics v_deleted = row_count;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', 'ad_spend.deleted', 'ad_spend', null,
          jsonb_build_object('platform', p_platform, 'from', p_from, 'to', p_to, 'rows', v_deleted));

  return v_deleted;
end;
$$;

-- (17) Reads for the page (P10).
create or replace function public.ad_spend_daily_totals(p_from date, p_to date)
returns table (spend_date date, platform text, spend_php numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can see ad spend' using errcode = '42501';
  end if;
  perform public._ps_check_period(p_from, p_to);
  return query
  select a.spend_date, a.platform, sum(a.spend_php)::numeric(14,2)
  from public.ad_spend_daily a
  where a.spend_date between p_from and p_to
  group by a.spend_date, a.platform
  order by a.spend_date, a.platform;
end;
$$;

create or replace function public.ad_spend_coverage()
returns table (platform text, first_date date, last_date date, days int, total_php numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can see ad spend' using errcode = '42501';
  end if;
  return query
  select a.platform, min(a.spend_date), max(a.spend_date),
         count(distinct a.spend_date)::int, sum(a.spend_php)::numeric(14,2)
  from public.ad_spend_daily a
  group by a.platform
  order by a.platform;
end;
$$;
```

- [ ] **Step 2: Append ACLs and post-conditions.** Helpers get NO grant (0119 made public functions service_role-only by default — revoke that too); report functions go to `authenticated` only.

```sql
-- (18) Function ACLs. Helpers: callable only by their owner (the definer
-- functions above run as the owner). Report + ad-spend functions: authenticated
-- (each checks has_role(array['admin']) itself; has_role follows View-as, 0182).
revoke all on function public._ps_name_norm(text) from public, anon, authenticated, service_role;
revoke all on function public._ps_loose_key(text, text) from public, anon, authenticated, service_role;
revoke all on function public._ps_doctor_norm(text) from public, anon, authenticated, service_role;
revoke all on function public._ps_survivors() from public, anon, authenticated, service_role;
revoke all on function public._ps_assert_mirror_mode() from public, anon, authenticated, service_role;
revoke all on function public._ps_check_period(date, date) from public, anon, authenticated, service_role;
revoke all on function public._ps_bucket(date, text, date) from public, anon, authenticated, service_role;
revoke all on function public._patient_sources_encounters() from public, anon, authenticated, service_role;
revoke all on function public._patient_sources_identities() from public, anon, authenticated, service_role;
revoke all on function public._ps_revenue_lines(date, date) from public, anon, authenticated, service_role;

revoke all on function public.patient_sources_summary(date, date) from public, anon;
revoke all on function public.patient_sources_series(date, date, text, text) from public, anon;
revoke all on function public.patient_sources_revenue(date, date) from public, anon;
revoke all on function public.patient_sources_overlaps(date, date) from public, anon;
revoke all on function public.patient_sources_referrers(date, date, int) from public, anon;
revoke all on function public.patient_sources_people(date, date, text, text, int, int) from public, anon;
revoke all on function public.ad_spend_import(uuid, jsonb) from public, anon;
revoke all on function public.ad_spend_delete(text, date, date) from public, anon;
revoke all on function public.ad_spend_daily_totals(date, date) from public, anon;
revoke all on function public.ad_spend_coverage() from public, anon;
grant execute on function public.patient_sources_summary(date, date) to authenticated;
grant execute on function public.patient_sources_series(date, date, text, text) to authenticated;
grant execute on function public.patient_sources_revenue(date, date) to authenticated;
grant execute on function public.patient_sources_overlaps(date, date) to authenticated;
grant execute on function public.patient_sources_referrers(date, date, int) to authenticated;
grant execute on function public.patient_sources_people(date, date, text, text, int, int) to authenticated;
grant execute on function public.ad_spend_import(uuid, jsonb) to authenticated;
grant execute on function public.ad_spend_delete(text, date, date) to authenticated;
grant execute on function public.ad_spend_daily_totals(date, date) to authenticated;
grant execute on function public.ad_spend_coverage() to authenticated;

-- (19) Post-conditions: abort the deploy if an ACL is not what this file says.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.patient_sources_summary(date,date)',
    'public.patient_sources_series(date,date,text,text)',
    'public.patient_sources_revenue(date,date)',
    'public.patient_sources_overlaps(date,date)',
    'public.patient_sources_referrers(date,date,integer)',
    'public.patient_sources_people(date,date,text,text,integer,integer)',
    'public.ad_spend_import(uuid,jsonb)',
    'public.ad_spend_delete(text,date,date)',
    'public.ad_spend_daily_totals(date,date)',
    'public.ad_spend_coverage()'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0189: % is executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '0189: % is not executable by authenticated', f;
    end if;
  end loop;
  foreach f in array array[
    'public._ps_name_norm(text)', 'public._ps_loose_key(text,text)', 'public._ps_doctor_norm(text)',
    'public._ps_survivors()', 'public._ps_assert_mirror_mode()', 'public._ps_check_period(date,date)',
    'public._ps_bucket(date,text,date)', 'public._patient_sources_encounters()',
    'public._patient_sources_identities()', 'public._ps_revenue_lines(date,date)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '0189: helper % is executable by a JWT role', f;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.ad_spend_daily', 'select')
     or has_table_privilege('authenticated', 'public.ad_spend_daily', 'insert') then
    raise exception '0189: ad_spend_daily grants are wider than admin read';
  end if;
end;
$$;
```

- [ ] **Step 3: Apply, regenerate types, run the SQL-reading repo guards.**

```bash
$PSQL "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0189_patient_sources.sql
npm run db:types
npx vitest run src/lib/accounting/pg-error-coverage.test.ts src/lib/supabase src/lib/sheet-sync/mirror-readers.test.ts
```
Expected: pg-error-coverage and the `src/lib/supabase` guards PASS (seed-grant parity, hardened views). `mirror-readers` FAILS with `0189_patient_sources.sql` as an offender — that is fixed in Step 4.

- [ ] **Step 4: Allow 0189 in the mirror guard.** In `src/lib/sheet-sync/mirror-readers.test.ts`, replace the third test's body filter so the Patient Sources migration is an explicit, named reader:

```ts
  it("no migration other than the sheet sync foundation and Patient Sources mentions the mirror tables", () => {
    // Matched by name, not number: the foundation migration has been renumbered
    // before. Patient Sources (PR 2, 0189) reads the mirror through admin-gated
    // report functions only; money surfaces stay forbidden.
    const migrationsDir = join(ROOT, "supabase/migrations");
    const sql = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    const foundation = sql.filter((f) => /_sheet_sync_foundation\.sql$/.test(f));
    const patientSources = sql.filter((f) => /_patient_sources\.sql$/.test(f));
    expect(foundation).toHaveLength(1);
    expect(patientSources).toHaveLength(1);
    const offenders = sql
      .filter((f) => !foundation.includes(f) && !patientSources.includes(f))
      .filter((f) => MIRROR.test(readFileSync(join(migrationsDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
```
and add `"scripts/patient-sources-db-proof.ts", // Patient Sources local proof (seeds mirror rows)` to `ALLOWED`. Run `npx vitest run src/lib/sheet-sync/mirror-readers.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add -A supabase/migrations/0189_patient_sources.sql src/types/database.ts src/lib/sheet-sync/mirror-readers.test.ts && git commit -m "feat(db): 0189 ad_spend_daily, ad spend RPCs, ACLs and post-conditions"`

### Task 5: Local DB proof (hand-run)

**Files:**
- Create: `scripts/patient-sources-db-proof.ts`
- Modify: `package.json` (`"patient-sources:db-proof": "tsx scripts/patient-sources-db-proof.ts"`)

**Structure — copy from `scripts/sheet-sync-db-proof.ts`**, verbatim: the imports + `requireLocalOrExplicitProd` + `DB_URL` + non-local refusal block (lines 208–230; change the script name to `patient-sources:db-proof`), the `Json`/`DbRole`/`Claims`/`CheckResult` types, and inside `main()` the helpers `q`, `describeError`, `assert`, `setRole`, `expectPgError`, `expectOk`, `check` (lines 250–353), the `begin … rollback` frame and the final PASS/FAIL tally. Also copy the three `auth.users` + `staff_profiles` inserts from `setupFixtures` (lines 380–397) with emails `patient-sources-proof-*@example.test`. Add at top: `import { looseKeyOf } from "../src/lib/sheet-sync/names";` (relative import — the CLI already loads this module).

**Fixture helpers to add (inside `main()`):**

```ts
  const JUNE = { from: "2026-06-01", to: "2026-06-30" };
  const asAdmin = () => setRole("authenticated", { sub: fx.adminId, role: "authenticated" });

  interface Summary {
    new_confirmed: number; new_unconfirmed: number; returning_first_recorded: number;
    served_confirmed: number; served_unconfirmed: number; undated_registrations: number;
    source_recorded: number; source_total: number;
  }
  async function summary(from = JUNE.from, to = JUNE.to): Promise<Summary> {
    await asAdmin();
    const r = await q<Summary>(`select * from public.patient_sources_summary($1, $2)`, [from, to]);
    await setRole("postgres", null);
    return r.rows[0];
  }
  function delta(before: Summary, after: Summary): Record<keyof Summary, number> {
    const out = {} as Record<keyof Summary, number>;
    for (const k of Object.keys(before) as (keyof Summary)[]) out[k] = Number(after[k]) - Number(before[k]);
    return out;
  }
  async function patient(last: string, first: string, opts: { source?: string; createdAt?: string; imported?: boolean } = {}): Promise<string> {
    const runId = opts.imported
      ? (await q<{ id: string }>(`insert into public.legacy_import_runs (source) values ('patient-sources-proof') returning id`)).rows[0].id
      : null;
    const r = await q<{ id: string }>(
      `insert into public.patients (first_name, last_name, birthdate, referral_source, created_at, legacy_import_run_id)
       values ($1, $2, '1990-01-01', $3, coalesce($4::timestamptz, now()), $5) returning id`,
      [first, last, opts.source ?? null, opts.createdAt ?? null, runId],
    );
    return r.rows[0].id;
  }
  async function visit(patientId: string, date: string, pricePhp = 0, opts: { imported?: boolean } = {}): Promise<string> {
    const runId = opts.imported
      ? (await q<{ id: string }>(`insert into public.legacy_import_runs (source) values ('patient-sources-proof') returning id`)).rows[0].id
      : null;
    const v = await q<{ id: string }>(
      `insert into public.visits (patient_id, visit_date, legacy_import_run_id) values ($1, $2, $3) returning id`,
      [patientId, date, runId],
    );
    if (pricePhp > 0) {
      await q(
        `insert into public.test_requests (visit_id, service_id, requested_by, final_price_php) values ($1, $2, $3, $4)`,
        [v.rows[0].id, fx.serviceId, fx.adminId, pricePhp],
      );
    }
    return v.rows[0].id;
  }
  async function sheetLine(date: string, looseKey: string, patientId: string | null, revenuePhp = 0): Promise<void> {
    await q(
      `insert into public.sheet_encounter_lines
         (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id, identity_key, revenue_php, raw, row_hash, run_id)
       values ('lab', 1, $1, $2, $2, $2, $3, $4, $5, '{}'::jsonb, md5(random()::text), $6)`,
      [date, looseKey, patientId, patientId ? `patient:${patientId}` : `name:${looseKey}`, revenuePhp, fx.runId],
    );
  }
  async function customerRow(looseKey: string, opts: { patientId?: string | null; source?: string | null; registeredOn?: string | null; referredBy?: string | null } = {}): Promise<void> {
    await q(
      `insert into public.sheet_customer_rows
         (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, registered_on, referral_source_id,
          referred_by_raw, patient_id, link_state, row_hash, run_id)
       values (1, md5(random()::text), $1, $1, $1, md5(random()::text), $2, $3, $4, $5, $6, md5(random()::text), $7)`,
      [looseKey, opts.registeredOn ?? null, opts.source ?? null, opts.referredBy ?? null, opts.patientId ?? null,
       opts.patientId ? "linked" : "unlinked", fx.runId],
    );
  }
  async function facts(patientId: string, registeredOn: string | null, newRepeat: "new" | "repeat" | null): Promise<void> {
    await q(
      `insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat) values ($1, $2, $3)`,
      [patientId, registeredOn, newRepeat],
    );
  }
  async function softDelete(patientId: string): Promise<void> {
    // 0167's lifecycle guard only lets delete_patient() write these columns;
    // a rolled-back fixture sidesteps every trigger for this one statement.
    await q(`select set_config('session_replication_role', 'replica', true)`);
    await q(
      `update public.patients set deleted_at = now(), deleted_by = $2, delete_reason = 'duplicate', delete_note = 'proof' where id = $1`,
      [patientId, fx.adminId],
    );
    await q(`select set_config('session_replication_role', 'origin', true)`);
  }
```
Fixture setup adds: `fx.serviceId` from `insert into public.services (code, name, price_php) values ('PS-PROOF', 'Proof test', 500) returning id` (if a later migration added a NOT NULL column without a default, `\d public.services` names it — add that column with any valid value), `fx.runId` from `insert into public.sheet_sync_runs (trigger, status, ended_at) values ('manual','succeeded', now()) returning id`, and `update public.sheet_sync_settings set converted_at = null where id`. If `delete_reason = 'duplicate'` fails a check, use a value from 0167's `delete_reason` check. Use surnames starting `Zzproof` so no local row shares a loose key.

**Checks** (each inside `check(name, async () => { … })`; baseline with `const b = await summary()` BEFORE inserting, then `delta(b, await summary())`):

1. **ACL matrix — functions.** For each of the 10 public functions with valid args (`'2026-06-01'`, `'2026-06-30'`, `'day'`, `'new'`, `20`, `null` channel, `50`, `0`; `ad_spend_import` with `gen_random_uuid()` and `'[{"spend_date":"2026-06-01","platform":"meta","campaign_key":"c","ad_key":"a","campaign_label":"C","spend_php":1}]'`; `ad_spend_delete('meta','2026-06-01','2026-06-01')`): anon → `42501`; portal patient (`anon` + `{ role: "anon", patient_id: <any patient id> }`) → `42501`; reception → `42501`; inactive admin → `42501`; admin → OK; **admin viewing as reception** (`update public.staff_profiles set view_as_role = 'reception', view_as_until = now() + interval '1 hour' where id = <admin>` as postgres first) → `42501`. For each of the 10 helpers: authenticated admin → `42501` (no EXECUTE).
2. **ACL matrix — table.** As postgres insert one `ad_spend_daily` row. Admin `select count(*)` > 0; reception = 0; anon → `42501`; admin `insert into public.ad_spend_daily …` → `42501`.
3. **Name-key parity.** For each of `[["Dela Cruz","Juan Santos"],["O'Brian","Ma. Luisa"],["Peñafrancia","José Mari"],["  de  la  PAZ ","ana-marie"],["Nuñez","Ñiño"],["", ""]]`: `select public._ps_loose_key($1,$2)` (as postgres) equals `looseKeyOf({ last, first, middle: null })`.
4. **Doctor normaliser.** `_ps_doctor_norm` of `'Dr. Juan Santos'`, `'dra juan santos'`, `'DOC Juan  Santos'`, `'Doctor Juan Santos.'` all = `'juan santos'`; `'N/A'`, `'none'`, `' '`, `'Dr.'` → NULL.
5. **Merged A→B, same day.** A (`Zzproofa`), B (`Zzproofb`); `update patients set merged_into_id = B where id = A`; B app-native visit 2026-06-10 with ₱300; sheet line on A 2026-06-10 with revenue ₱250. Δ `served_confirmed` = 1, Δ `new_confirmed` = 1 (B counted once). `patient_sources_overlaps(JUNE)` has exactly one row for B on 2026-06-10 with `app_php = 300`, `sheet_php = 250`. Revenue for B's channel increased by exactly 300 (the ₱250 is excluded).
6. **Deleted survivor drops out.** C with app-native visit 2026-06-11 ₱100 and a sheet line (patient C) 2026-06-12; `softDelete(C)`. Δ of every summary field = 0 versus the baseline taken before C was created; revenue unchanged; `patient_sources_people(JUNE,'served',…)` has no row for C and no `name:` row for C's loose key.
7. **Repeat → Returning.** R with facts `('2026-06-05','repeat')` and a visit 2026-06-13: Δ `returning_first_recorded` = 1, Δ `new_confirmed` = 0.
8. **Merged-group facts rule.** S (facts `2026-06-10`,`new`), M (facts `2026-06-05`,`repeat`), M merged into S, no visits → Δ `returning_first_recorded` = 1. Then change M's date to `2026-06-10` (tie) → still Returning. Then set M `2026-06-20` → Δ `new_confirmed` = 1 on 2026-06-10.
9. **Undated imported registration.** U imported (`imported: true`), no facts, no visits → Δ `undated_registrations` = 1 and Δ of every June field = 0; also `patient_sources_series('2026-01-01','2026-12-31','day','new')` has no row whose total changed on U's `created_at` date. Control: give U a visit on 2023-10-01 → Δ `undated_registrations` = 0 (before_window).
10. **App-native registration, Manila date.** N created `2026-06-15T20:00:00Z` (= 16 June in Manila), no visit → `patient_sources_series('2026-06-15','2026-06-16','day','new')` shows +1 on `2026-06-16`, nothing on `2026-06-15`.
11. **Restatement.** N2 created `2026-06-10T02:00:00Z`, no visit → +1 on 2026-06-10. Add a visit 2026-06-20 → the +1 moves to 2026-06-20 (series day), 2026-06-10 back to baseline.
12. **Suppression.** S2 (`Zzproofs`, `Maria`) app-native created 2026-06-11, no visit; unlinked sheet line `looseKey = 'zzproofs|maria'` on 2026-06-12 → Δ `new_confirmed` = 0, Δ `new_unconfirmed` = 1.
13. **Name-identity channel.** Unlinked line `zzproofc|one` + ONE customer row with that key, `source = 'online_google'` → the 'period' series row for `online_google` gains 1 unconfirmed. Key `zzproofc|two` with TWO customer rows (sources google and facebook) → counted under `not_recorded`.
14. **Stream (a) filters.** In June: an imported visit dated 2026-06-14 (`imported: true`, inside the mirror window) → not served; an imported visit 2026-05-20 → served in May; a deleted visit (`update visits set deleted_at = now(), deleted_by = <admin>, delete_reason = 'proof'` — copy 0125's column set) → not served; a live visit whose test_request is soft-deleted → served but ₱0 revenue; an encounter on 2023-11-30 → ignored by every function.
15. **Volume > 1,000.** `insert … select` 1,200 unlinked sheet lines on 2026-06-03 with keys `'zzproofv|' || g` → Δ `new_unconfirmed` = 1200. Then 400 days × 3 channels: for `g` in 0..399 and `src` in (online_google, online_facebook, walk_in) insert a customer row + a line on `date '2025-06-01' + g` with key `'zzproofw' || g || src` → `select count(*) from patient_sources_series('2025-06-01','2026-07-05','day','new')` (as admin) > 1000.
16. **Summary = series.** For JUNE with the fixtures of checks 5+12+13 present: `sum(confirmed)` over `series(JUNE,'day','new')` = `new_confirmed`, same for unconfirmed; `series(JUNE,'period','served')` sums = `served_*`; `series(JUNE,'week',…)` bucket starts are all Mondays (`extract(isodow from bucket_start) = 1`); month buckets are the 1st.
17. **Referrers.** Three new confirmed patients in June with `referred_by_doctor` `'Dr. Juan Santos'`, `'Dr. Juan Santos'`, `'dra juan santos'` and visits → one referrer row labelled `Dr. Juan Santos` with `new_confirmed` = 3.
18. **Converted mode.** `update sheet_sync_settings set converted_at = now() where id` → each of the six `patient_sources_*` functions as admin raises `0A000`.
19. **Bad args.** Admin: `series(JUNE,'year','new')`, `series(JUNE,'day','all')`, `summary('2026-06-30','2026-06-01')`, `summary('2025-01-01','2026-06-30')` (> 400 days), `people(JUNE,'everyone',null,50,0)` → all `22023`.
20. **People list.** With the check-15 1,200 names present: `people(JUNE,'new',null,50,0)` returns 50 rows, `total_count` ≥ 1200, and pages 0/50/100 concatenated have no duplicate `identity` and are sorted by `(first_date, identity)`. Name rows show the typed name; confirmed rows `Last, First`.
21. **Ad spend import/replace/delete.** Import rows `(06-01, meta, c1, a1, ₱100)`, `(06-01, meta, c1, a1, ₱50)` (duplicate → summed), `(06-01, meta, c1, a2, ₱10)` → `{inserted: 2, replaced: 0, days: 1}` and a1 = ₱150. Re-import only `(06-01, meta, c1, a2, ₱20)` → `{inserted: 0, replaced: 1}`, a1 still ₱150 (partial upload never overwrites a campaign total). Import containing a row with `spend_php: -1` → `23514` and the table is unchanged (all-or-nothing). `audit_log` has an `ad_spend.imported` row whose metadata keys are exactly `inserted, replaced, days`. `ad_spend_delete('meta','2026-06-01','2026-06-01')` returns 2 and writes `ad_spend.deleted`. `ad_spend_delete('tiktok',…)` → `22023`.

- [ ] **Step 1: Write the script** (checks above; ~600 lines). Add the npm script.
- [ ] **Step 2: Run** `npm run patient-sources:db-proof` → every line PASS, exit 0. A FAIL means fix the **migration** (re-apply with `psql -f`), not the check — unless the check contradicts the spec, in which case stop and say so.
- [ ] **Step 3: Controls — prove the checks bite** (memory `vacuous-assertions-trap`). One at a time: edit the migration, `psql -f` it, run the proof, confirm the named check FAILS, revert, re-apply, confirm all PASS.
  - A. In `_patient_sources_encounters`, replace `'patient:' || s.survivor_id::text` (sheet branch) with `'patient:' || l.patient_id::text` → check 5 FAILS.
  - B. In the `surv` CTE of `_patient_sources_identities`, drop `where sp.deleted_at is null` → check 6 FAILS.
  - C. In `confirmed_reg`, change `bool_or(m.sheet_new_repeat = 'repeat') filter (…)` to `bool_and(…)` → check 8 (tie) FAILS.
  - D. Delete the `has_role` check from `patient_sources_summary` → check 1 FAILS.
  - E. Drop `or v.legacy_import_run_id is null` … replace the stream-(a) predicate with `true` → check 14 FAILS.
  - F. In `member`, replace the Manila cast with `p.created_at::date` → check 10 FAILS.
  Record the six outcomes in the PR body.
- [ ] **Step 4:** `npx vitest run scripts/lib/guard-coverage.test.ts src/lib/sheet-sync/mirror-readers.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add scripts/patient-sources-db-proof.ts package.json && git commit -m "test(db): hand-run local proof for Patient Sources counting rules, ACLs and ad spend"`

# Phase B — pure TypeScript

### Task 6: `daysBetweenISO` and marketing periods

**Files:**
- Modify: `src/lib/dates/manila.ts`, `src/lib/dates/manila.test.ts`
- Create: `src/lib/marketing/period.ts`, `src/lib/marketing/period.test.ts`

- [ ] **Step 1: Failing tests.** Append to `src/lib/dates/manila.test.ts` (import `daysBetweenISO`):

```ts
describe("daysBetweenISO", () => {
  it("counts whole calendar days across month and year ends", () => {
    expect(daysBetweenISO("2026-09-28", "2026-09-28")).toBe(0);
    expect(daysBetweenISO("2026-01-31", "2026-03-01")).toBe(29);
    expect(daysBetweenISO("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetweenISO("2026-03-01", "2026-01-31")).toBe(-29);
    expect(daysBetweenISO("2024-02-28", "2024-03-01")).toBe(2);
  });
});
```

Create `src/lib/marketing/period.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { daysBetweenISO } from "@/lib/dates/manila";
import { buildMarketingPresets, firstParam, periodHref, resolvePeriod, MAX_PERIOD_DAYS } from "./period";

describe("buildMarketingPresets", () => {
  it("lists the recent presets first, then the longer ones", () => {
    expect(buildMarketingPresets("2026-09-28").map((p) => p.key)).toEqual([
      "today", "yesterday", "last-7", "this-month", "last-month", "ytd", "12m", "last-year",
    ]);
  });
  it("is right on the 1st of a month (Manila calendar, no Date)", () => {
    const p = Object.fromEntries(buildMarketingPresets("2026-09-01").map((x) => [x.key, x]));
    expect(p.today).toMatchObject({ start: "2026-09-01", end: "2026-09-01" });
    expect(p.yesterday).toMatchObject({ start: "2026-08-31", end: "2026-08-31" });
    expect(p["last-7"]).toMatchObject({ start: "2026-08-26", end: "2026-09-01" });
    expect(p["this-month"]).toMatchObject({ start: "2026-09-01", end: "2026-09-01" });
    expect(p["last-month"]).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
  });
  it("is right on 1 January", () => {
    const p = Object.fromEntries(buildMarketingPresets("2027-01-01").map((x) => [x.key, x]));
    expect(p.yesterday).toMatchObject({ start: "2026-12-31", end: "2026-12-31" });
    expect(p["last-month"]).toMatchObject({ start: "2026-12-01", end: "2026-12-31" });
    expect(p.ytd).toMatchObject({ start: "2027-01-01", end: "2027-01-01" });
    expect(p["last-year"]).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
  });
  it("keeps every preset within the maximum span", () => {
    for (const today of ["2026-12-31", "2028-02-29", "2027-01-01"]) {
      for (const p of buildMarketingPresets(today)) {
        expect(daysBetweenISO(p.start, p.end)).toBeLessThanOrEqual(MAX_PERIOD_DAYS);
      }
    }
  });
});

describe("resolvePeriod", () => {
  const today = "2026-09-28";
  it("defaults to this month", () => {
    expect(resolvePeriod({}, today)).toEqual({ from: "2026-09-01", to: "2026-09-28", presetKey: "this-month", error: null });
  });
  it("accepts a valid custom range and marks it custom", () => {
    expect(resolvePeriod({ from: "2026-07-03", to: "2026-08-14" }, today)).toEqual({
      from: "2026-07-03", to: "2026-08-14", presetKey: null, error: null,
    });
  });
  it("recognises a preset range", () => {
    expect(resolvePeriod({ from: "2026-09-27", to: "2026-09-27" }, today).presetKey).toBe("yesterday");
  });
  it("rejects reversed, malformed and over-long ranges with a message", () => {
    for (const bad of [
      { from: "2026-09-10", to: "2026-09-01" },
      { from: "2026-9-1", to: "2026-09-10" },
      { from: "2025-01-01", to: "2026-09-10" },
      { from: "2026-09-01" },
    ]) {
      const r = resolvePeriod(bad, today);
      expect(r.from).toBe("2026-09-01");
      expect(r.to).toBe("2026-09-28");
      expect(r.error).toMatch(/400 days/);
    }
  });
});

describe("periodHref", () => {
  it("keeps other params, applies the patch, drops null and empty", () => {
    expect(periodHref("/x", { from: "a", to: "b", mode: "served", grain: "week", page: "3" }, { from: "c", to: "d", page: null }))
      .toBe("/x?mode=served&grain=week&from=c&to=d");
    expect(periodHref("/x", {}, {})).toBe("/x");
    expect(periodHref("/x", { mode: "" }, { grain: "day" })).toBe("/x?grain=day");
  });
});

describe("firstParam", () => {
  it("reads the first string of a search param", () => {
    expect(firstParam("a")).toBe("a");
    expect(firstParam(["b", "c"])).toBe("b");
    expect(firstParam(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/dates/manila.test.ts src/lib/marketing/period.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement.** Append to `src/lib/dates/manila.ts` right after `shiftISODate`:

```ts
/**
 * Whole days from calendar date `a` to `b` (negative when `b` is earlier).
 * Both are YYYY-MM-DD strings read as UTC midnights, the same arithmetic as
 * `shiftISODate`, so no runtime-zone accessor is involved.
 */
export function daysBetweenISO(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
```
If `src/lib/dates/manila-usage.test.ts` lists allowed functions per file under `"lib/dates/manila.ts"`, add `daysBetweenISO` there with the same `why` as `shiftISODate`.

Create `src/lib/marketing/period.ts`:

```ts
/**
 * Period controls shared by the Marketing reports (Patient Sources, Booking
 * Sources): presets, custom-range validation and links that keep every other
 * query param (mode, grain, channel) when the period changes.
 *
 * Calendar arithmetic only — YYYY-MM-DD strings via manila.ts, never a Date
 * read back in the runtime's zone (the M2 lesson in period-presets.ts).
 */
import { buildPeriodPresets, type PeriodPreset } from "@/lib/reports/period-presets";
import { daysBetweenISO, isISODate, shiftISODate } from "@/lib/dates/manila";

/** The report functions refuse longer periods (0189 _ps_check_period). */
export const MAX_PERIOD_DAYS = 400;

const PERIOD_ERROR =
  "That period can't be shown — pick a start on or before the end, at most 400 days apart. Showing this month instead.";

export function buildMarketingPresets(todayISO: string): PeriodPreset[] {
  const base = new Map(buildPeriodPresets(todayISO).map((p) => [p.key, p]));
  const yesterday = shiftISODate(todayISO, -1);
  const keep = ["this-month", "last-month", "ytd", "12m", "last-year"].map((k) => base.get(k)!);
  return [
    { key: "today", label: "Today", start: todayISO, end: todayISO },
    { key: "yesterday", label: "Yesterday", start: yesterday, end: yesterday },
    { key: "last-7", label: "Last 7 days", start: shiftISODate(todayISO, -6), end: todayISO },
    ...keep,
  ];
}

export interface ResolvedPeriod {
  from: string;
  to: string;
  /** The matching preset, or null for a custom range. */
  presetKey: string | null;
  error: string | null;
}

export function resolvePeriod(sp: { from?: string; to?: string }, todayISO: string): ResolvedPeriod {
  const presets = buildMarketingPresets(todayISO);
  const thisMonth = presets.find((p) => p.key === "this-month")!;
  const match = (from: string, to: string) =>
    presets.find((p) => p.start === from && p.end === to)?.key ?? null;

  if (sp.from === undefined && sp.to === undefined) {
    return { from: thisMonth.start, to: thisMonth.end, presetKey: "this-month", error: null };
  }
  const valid =
    isISODate(sp.from) &&
    isISODate(sp.to) &&
    sp.from <= sp.to &&
    daysBetweenISO(sp.from, sp.to) <= MAX_PERIOD_DAYS;
  if (!valid) {
    return { from: thisMonth.start, to: thisMonth.end, presetKey: "this-month", error: PERIOD_ERROR };
  }
  return { from: sp.from!, to: sp.to!, presetKey: match(sp.from!, sp.to!), error: null };
}

/** `pathname?…` keeping `current` params, overridden by `patch`; null deletes. */
export function periodHref(
  pathname: string,
  current: Readonly<Record<string, string | undefined>>,
  patch: Readonly<Record<string, string | null | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (typeof v === "string" && v !== "" && !(k in patch)) params.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v !== "") params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Next 16 search params may be string[] — the first value wins. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
```

- [ ] **Step 4: Run** the two test files plus `npx vitest run src/lib/dates` → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/dates src/lib/marketing/period.ts src/lib/marketing/period.test.ts && git commit -m "feat(marketing): shared period presets, custom-range validation and param-keeping links"`

### Task 7: Pure Patient Sources helpers

**Files:**
- Create: `src/lib/marketing/patient-sources.ts`, `src/lib/marketing/patient-sources.test.ts`

- [ ] **Step 1: Failing tests** (`src/lib/marketing/patient-sources.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import {
  NOT_RECORDED, bucketLabel, channelLabel, channelTable, chartData, classifyReportError,
  costPerNewPatient, formatNewToday, parseGrain, parseMode, previousPeriod, seriesCsvRows,
  type SeriesRow, type SummaryRow,
} from "./patient-sources";

const row = (bucket_start: string, channel: string, confirmed: number, unconfirmed = 0): SeriesRow =>
  ({ bucket_start, channel, confirmed, unconfirmed });

describe("parsers and labels", () => {
  it("defaults mode to new and grain to day", () => {
    expect(parseMode("served")).toBe("served");
    expect(parseMode("x")).toBe("new");
    expect(parseGrain("week")).toBe("week");
    expect(parseGrain("month")).toBe("month");
    expect(parseGrain("period")).toBe("day");
  });
  it("labels channels, including Not recorded and unknown ids", () => {
    expect(channelLabel("online_facebook")).toBe("Facebook");
    expect(channelLabel(NOT_RECORDED)).toBe("Not recorded");
    expect(channelLabel("mystery_channel")).toBe("Mystery channel");
  });
  it("labels buckets without Date", () => {
    expect(bucketLabel("day", "2026-09-01")).toBe("1 Sep");
    expect(bucketLabel("week", "2026-08-31")).toBe("Wk of 31 Aug");
    expect(bucketLabel("month", "2026-09-01")).toBe("Sep 2026");
  });
});

describe("previousPeriod", () => {
  it("is the same length, ending the day before", () => {
    expect(previousPeriod("2026-09-01", "2026-09-30")).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(previousPeriod("2026-09-28", "2026-09-28")).toEqual({ from: "2026-09-27", to: "2026-09-27" });
    expect(previousPeriod("2026-01-01", "2026-01-07")).toEqual({ from: "2025-12-25", to: "2025-12-31" });
  });
});

describe("channelTable", () => {
  it("adds share and change, keeps channels that only existed before, sorts by total", () => {
    const t = channelTable(
      [row("2026-09-01", "walk_in", 5, 1), row("2026-09-01", "online_facebook", 2)],
      [row("2026-08-01", "walk_in", 3), row("2026-08-01", "online_google", 4)],
    );
    expect(t.map((r) => r.channel)).toEqual(["walk_in", "online_facebook", "online_google"]);
    expect(t[0]).toMatchObject({ confirmed: 5, unconfirmed: 1, total: 6, previousTotal: 3, change: 3 });
    expect(t[0].share).toBeCloseTo(6 / 8);
    expect(t[2]).toMatchObject({ total: 0, previousTotal: 4, change: -4, share: 0 });
  });
});

describe("chartData", () => {
  it("builds one datum per bucket with confirmed/unconfirmed keys per channel", () => {
    const { rows, channels } = chartData(
      [row("2026-09-01", "walk_in", 2, 1), row("2026-09-02", "online_google", 1)],
      "day",
    );
    expect(channels.map((c) => c.key)).toEqual(["walk_in", "online_google"]);
    expect(rows).toEqual([
      { bucket: "2026-09-01", label: "1 Sep", walk_in__c: 2, walk_in__u: 1, online_google__c: 0, online_google__u: 0 },
      { bucket: "2026-09-02", label: "2 Sep", walk_in__c: 0, walk_in__u: 0, online_google__c: 1, online_google__u: 0 },
    ]);
  });
});

describe("costPerNewPatient", () => {
  it("divides spend by new customers on days with spend only", () => {
    const out = costPerNewPatient(
      [
        { spend_date: "2026-09-01", platform: "meta", spend_php: 1000 },
        { spend_date: "2026-09-02", platform: "meta", spend_php: 0 },
        { spend_date: "2026-09-01", platform: "google", spend_php: 500 },
      ],
      [
        row("2026-09-01", "online_facebook", 3, 1),
        row("2026-09-02", "online_facebook", 9),
        row("2026-09-03", "online_google", 7),
      ],
    );
    expect(out.find((c) => c.platform === "meta")).toMatchObject({
      spendPhp: 1000, days: 1, newConfirmed: 3, newUnconfirmed: 1, costPerNewPhp: 250,
    });
    expect(out.find((c) => c.platform === "google")).toMatchObject({
      spendPhp: 500, days: 1, newConfirmed: 0, newUnconfirmed: 0, costPerNewPhp: null,
    });
  });
});

describe("formatNewToday", () => {
  it("shows the top four channels, the rest as N more, and unconfirmed", () => {
    const f = formatNewToday([
      row("2026-09-28", "walk_in", 5), row("2026-09-28", "online_facebook", 2, 1),
      row("2026-09-28", "online_google", 1), row("2026-09-28", "doctor_referral", 1),
      row("2026-09-28", "flyers", 1), row("2026-09-28", NOT_RECORDED, 0, 2),
    ]);
    expect(f.total).toBe(13);
    expect(f.unconfirmed).toBe(3);
    expect(f.hint).toBe("5 Walk-in · 3 Facebook · 2 Not recorded · 1 Doctor referral · 2 more (3 unconfirmed)");
  });
  it("says so when nobody is new yet", () => {
    expect(formatNewToday([])).toEqual({ total: 0, unconfirmed: 0, hint: "No new patients recorded yet today" });
  });
});

describe("classifyReportError", () => {
  it("maps the report SQLSTATEs", () => {
    expect(classifyReportError({ code: "0A000", message: "x" }).kind).toBe("converted");
    expect(classifyReportError({ code: "42501", message: "x" }).kind).toBe("forbidden");
    expect(classifyReportError({ code: "22023", message: "x" }).kind).toBe("invalid");
    expect(classifyReportError(new Error("boom")).kind).toBe("error");
    expect(classifyReportError(null).kind).toBe("error");
  });
});

describe("seriesCsvRows", () => {
  it("puts the summary above the channel × bucket table", () => {
    const summary = {
      new_confirmed: 3, new_unconfirmed: 1, returning_first_recorded: 2, served_confirmed: 9,
      served_unconfirmed: 4, undated_registrations: 7, source_recorded: 3, source_total: 4,
      sheet_last_dates: {}, sync_paused: true, last_synced_at: null,
    } satisfies SummaryRow;
    const rows = seriesCsvRows({ from: "2026-09-01", to: "2026-09-30", mode: "new", grain: "day" }, summary,
      [row("2026-09-01", "walk_in", 3, 1)]);
    expect(rows[0]).toEqual(["Patient Sources", "2026-09-01 to 2026-09-30", "New customers", "Day"]);
    expect(rows).toContainEqual(["New customers — confirmed", 3]);
    expect(rows).toContainEqual(["New customers — unconfirmed", 1]);
    expect(rows.at(-2)).toEqual(["Period start", "Channel", "Confirmed", "Unconfirmed"]);
    expect(rows.at(-1)).toEqual(["2026-09-01", "Walk-in", 3, 1]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/lib/marketing/patient-sources.ts`:

```ts
/**
 * Patient Sources (Sheet Sync PR 2) — the pure half: types of the 0189 report
 * functions, labels, the per-channel table, chart rows, cost per new patient,
 * the dashboard tile wording, CSV rows and the error classifier. Every COUNT
 * comes from SQL; nothing here re-derives one.
 */
import { REFERRAL_NOT_RECORDED_LABEL, referralSourceLabel } from "@/lib/patients/referral-sources";
import { humaniseCode } from "@/lib/format/humanise-code";
import { daysBetweenISO, isoDateParts, shiftISODate } from "@/lib/dates/manila";

export const NOT_RECORDED = "not_recorded";
export type Mode = "new" | "served";
export type Grain = "day" | "week" | "month";

export interface SummaryRow {
  new_confirmed: number;
  new_unconfirmed: number;
  returning_first_recorded: number;
  served_confirmed: number;
  served_unconfirmed: number;
  undated_registrations: number;
  source_recorded: number;
  source_total: number;
  sheet_last_dates: Record<string, string | null>;
  sync_paused: boolean | null;
  last_synced_at: string | null;
}
export interface SeriesRow { bucket_start: string; channel: string; confirmed: number; unconfirmed: number }
export interface RevenueRow { channel: string; confirmed_php: number; unconfirmed_php: number }
export interface OverlapRow { patient_id: string; drm_id: string; service_date: string; app_php: number; sheet_php: number }
export interface ReferrerRow { doctor_label: string; new_confirmed: number; new_unconfirmed: number }
export interface PeopleRow {
  identity_kind: "confirmed" | "unconfirmed";
  identity: string;
  patient_id: string | null;
  drm_id: string | null;
  display_name: string | null;
  first_date: string;
  total_count: number;
}
export interface SpendTotalRow { spend_date: string; platform: "meta" | "google"; spend_php: number }

export type ReportErrorKind = "converted" | "forbidden" | "invalid" | "error";
export type ReportResult<T> = { ok: true; data: T } | { ok: false; kind: ReportErrorKind; message: string };

const ERROR_MESSAGE: Record<ReportErrorKind, string> = {
  converted: "Patient Sources is being switched to the converted records — ask the developer.",
  forbidden: "Patient Sources is for admins only. If you are using View as, switch back to Admin.",
  invalid: "That period can't be shown — pick a start on or before the end, at most 400 days apart.",
  error: "Couldn't load Patient Sources. Reload the page — these figures are unknown, not zero.",
};

export function classifyReportError(err: unknown): { ok: false; kind: ReportErrorKind; message: string } {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
  const kind: ReportErrorKind =
    code === "0A000" ? "converted" : code === "42501" ? "forbidden" : code === "22023" ? "invalid" : "error";
  return { ok: false, kind, message: ERROR_MESSAGE[kind] };
}

export function parseMode(v: string | undefined): Mode {
  return v === "served" ? "served" : "new";
}
export function parseGrain(v: string | undefined): Grain {
  return v === "week" || v === "month" ? v : "day";
}
export const MODE_LABEL: Record<Mode, string> = { new: "New customers", served: "All customers served" };
export const GRAIN_LABEL: Record<Grain, string> = { day: "Day", week: "Week", month: "Month" };

export function channelLabel(channel: string): string {
  if (channel === NOT_RECORDED) return REFERRAL_NOT_RECORDED_LABEL;
  const label = referralSourceLabel(channel);
  return label && label !== channel ? label : humaniseCode(channel);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function bucketLabel(grain: Grain, iso: string): string {
  const { year, month, day } = isoDateParts(iso);
  if (grain === "month") return `${MONTHS[month - 1]} ${year}`;
  const d = `${day} ${MONTHS[month - 1]}`;
  return grain === "week" ? `Wk of ${d}` : d;
}

export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const len = daysBetweenISO(from, to);
  const prevTo = shiftISODate(from, -1);
  return { from: shiftISODate(prevTo, -len), to: prevTo };
}

export interface ChannelTableRow {
  channel: string;
  label: string;
  confirmed: number;
  unconfirmed: number;
  total: number;
  share: number;
  previousTotal: number;
  change: number;
}

function totalsByChannel(rows: readonly SeriesRow[]): Map<string, { confirmed: number; unconfirmed: number }> {
  const m = new Map<string, { confirmed: number; unconfirmed: number }>();
  for (const r of rows) {
    const t = m.get(r.channel) ?? { confirmed: 0, unconfirmed: 0 };
    t.confirmed += Number(r.confirmed);
    t.unconfirmed += Number(r.unconfirmed);
    m.set(r.channel, t);
  }
  return m;
}

/** `current` / `previous` are 'period'-grain rows (one bucket each). */
export function channelTable(current: readonly SeriesRow[], previous: readonly SeriesRow[]): ChannelTableRow[] {
  const cur = totalsByChannel(current);
  const prev = totalsByChannel(previous);
  const grand = [...cur.values()].reduce((s, t) => s + t.confirmed + t.unconfirmed, 0);
  const channels = new Set([...cur.keys(), ...prev.keys()]);
  return [...channels]
    .map((channel) => {
      const c = cur.get(channel) ?? { confirmed: 0, unconfirmed: 0 };
      const p = prev.get(channel) ?? { confirmed: 0, unconfirmed: 0 };
      const total = c.confirmed + c.unconfirmed;
      const previousTotal = p.confirmed + p.unconfirmed;
      return {
        channel,
        label: channelLabel(channel),
        confirmed: c.confirmed,
        unconfirmed: c.unconfirmed,
        total,
        share: grand > 0 ? total / grand : 0,
        previousTotal,
        change: total - previousTotal,
      };
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label) || a.channel.localeCompare(b.channel));
}

const PALETTE = [
  "#1d4ed8", "#0891b2", "#16a34a", "#ca8a04", "#dc2626", "#7c3aed",
  "#db2777", "#0d9488", "#ea580c", "#4f46e5", "#65a30d", "#64748b",
];
export interface ChartChannel { key: string; label: string; color: string }
export type ChartDatum = { bucket: string; label: string } & Record<string, string | number>;

export function chartData(rows: readonly SeriesRow[], grain: Grain): { rows: ChartDatum[]; channels: ChartChannel[] } {
  const totals = totalsByChannel(rows);
  const channels = [...totals.entries()]
    .sort((a, b) => b[1].confirmed + b[1].unconfirmed - (a[1].confirmed + a[1].unconfirmed) || a[0].localeCompare(b[0]))
    .map(([key], i) => ({ key, label: channelLabel(key), color: PALETTE[i % PALETTE.length] }));
  const buckets = [...new Set(rows.map((r) => r.bucket_start))].sort();
  const byKey = new Map(rows.map((r) => [`${r.bucket_start}|${r.channel}`, r]));
  return {
    channels,
    rows: buckets.map((bucket) => {
      const d: ChartDatum = { bucket, label: bucketLabel(grain, bucket) };
      for (const c of channels) {
        const r = byKey.get(`${bucket}|${c.key}`);
        d[`${c.key}__c`] = r ? Number(r.confirmed) : 0;
        d[`${c.key}__u`] = r ? Number(r.unconfirmed) : 0;
      }
      return d;
    }),
  };
}

export const AD_PLATFORMS = [
  { platform: "meta", label: "Meta (Facebook)", channel: "online_facebook" },
  { platform: "google", label: "Google", channel: "online_google" },
] as const;

export interface CostPerNew {
  platform: "meta" | "google";
  label: string;
  spendPhp: number;
  days: number;
  newConfirmed: number;
  newUnconfirmed: number;
  costPerNewPhp: number | null;
}

/** Spend ÷ new customers of the matching channel, over days that have spend only (spec §2.3). */
export function costPerNewPatient(spend: readonly SpendTotalRow[], newByDay: readonly SeriesRow[]): CostPerNew[] {
  return AD_PLATFORMS.map(({ platform, label, channel }) => {
    const days = new Map<string, number>();
    for (const s of spend) {
      if (s.platform === platform && Number(s.spend_php) > 0) {
        days.set(s.spend_date, (days.get(s.spend_date) ?? 0) + Number(s.spend_php));
      }
    }
    let newConfirmed = 0;
    let newUnconfirmed = 0;
    for (const r of newByDay) {
      if (r.channel === channel && days.has(r.bucket_start)) {
        newConfirmed += Number(r.confirmed);
        newUnconfirmed += Number(r.unconfirmed);
      }
    }
    const spendPhp = Math.round([...days.values()].reduce((a, b) => a + b, 0) * 100) / 100;
    const people = newConfirmed + newUnconfirmed;
    return {
      platform,
      label,
      spendPhp,
      days: days.size,
      newConfirmed,
      newUnconfirmed,
      costPerNewPhp: people > 0 ? Math.round((spendPhp / people) * 100) / 100 : null,
    };
  });
}

/** Admin dashboard tile: "5 Walk-in · 3 Facebook · … · N more (M unconfirmed)". */
export function formatNewToday(rows: readonly SeriesRow[]): { total: number; unconfirmed: number; hint: string } {
  const totals = [...totalsByChannel(rows).entries()]
    .map(([channel, t]) => ({ channel, n: t.confirmed + t.unconfirmed, u: t.unconfirmed }))
    .filter((t) => t.n > 0)
    .sort((a, b) => b.n - a.n || channelLabel(a.channel).localeCompare(channelLabel(b.channel)));
  const total = totals.reduce((s, t) => s + t.n, 0);
  const unconfirmed = totals.reduce((s, t) => s + t.u, 0);
  if (total === 0) return { total: 0, unconfirmed: 0, hint: "No new patients recorded yet today" };
  const top = totals.slice(0, 4).map((t) => `${t.n} ${channelLabel(t.channel)}`);
  const rest = totals.slice(4).reduce((s, t) => s + t.n, 0);
  const parts = rest > 0 ? [...top, `${rest} more`] : top;
  return { total, unconfirmed, hint: parts.join(" · ") + (unconfirmed > 0 ? ` (${unconfirmed} unconfirmed)` : "") };
}

/** Counts CSV: the summary (same numbers as the cards) above the channel × bucket table. */
export function seriesCsvRows(
  p: { from: string; to: string; mode: Mode; grain: Grain },
  summary: SummaryRow,
  series: readonly SeriesRow[],
): (string | number)[][] {
  return [
    ["Patient Sources", `${p.from} to ${p.to}`, MODE_LABEL[p.mode], GRAIN_LABEL[p.grain]],
    ["New customers — confirmed", summary.new_confirmed],
    ["New customers — unconfirmed", summary.new_unconfirmed],
    ["Returning, first time in our records", summary.returning_first_recorded],
    ["All customers served — confirmed", summary.served_confirmed],
    ["All customers served — unconfirmed", summary.served_unconfirmed],
    ["Source recorded", `${summary.source_recorded} of ${summary.source_total}`],
    ["Registrations with no date (not on any day)", summary.undated_registrations],
    [],
    ["Period start", "Channel", "Confirmed", "Unconfirmed"],
    ...series.map((r) => [r.bucket_start, channelLabel(r.channel), Number(r.confirmed), Number(r.unconfirmed)]),
  ];
}
```

- [ ] **Step 4: Run** the test → PASS. Also run `npx vitest run src/lib/dates/date-render-surfaces.test.ts src/lib/dates/manila-usage.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/marketing/patient-sources.ts src/lib/marketing/patient-sources.test.ts && git commit -m "feat(marketing): pure Patient Sources helpers (tables, chart rows, cost per new patient, tile, CSV)"`

### Task 8: Ad spend CSV parser

**Files:**
- Create: `src/lib/marketing/ad-spend-import.ts`, `src/lib/marketing/ad-spend-import.test.ts`

- [ ] **Step 1: Failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { describeAdSpendSave, locateHeader, parseAdSpendCsv, parseDateCell } from "./ad-spend-import";

const meta = (rows: Record<string, string>[]) =>
  parseAdSpendCsv(rows, Object.keys(rows[0] ?? {}));

describe("parseDateCell", () => {
  it("reads ISO, slash and month-name dates", () => {
    expect(parseDateCell("2026-09-01")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("2026-09-01 00:00:00")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("9/1/2026")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("25/9/2026")).toEqual({ ok: true, date: "2026-09-25" });
    expect(parseDateCell("Sep 1, 2026")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("1 September 2026")).toEqual({ ok: true, date: "2026-09-01" });
  });
  it("rejects ranges with different ends and impossible dates", () => {
    expect(parseDateCell("2026-09-01 - 2026-09-30")).toEqual({ ok: false, reason: "date_range" });
    expect(parseDateCell("2026-09-01 - 2026-09-01")).toEqual({ ok: true, date: "2026-09-01" });
    expect(parseDateCell("2026-02-30")).toEqual({ ok: false, reason: "bad_date" });
    expect(parseDateCell("MAX")).toEqual({ ok: false, reason: "bad_date" });
  });
});

describe("locateHeader", () => {
  it("skips a BOM and Google's title lines", () => {
    const text = "﻿Campaign report\nSeptember 1, 2026 - September 30, 2026\nDay,Campaign,Cost,Impr.,Clicks,Currency code\n2026-09-01,Brand,100.00,10,1,PHP\n";
    expect(locateHeader(text).startsWith("Day,Campaign,Cost")).toBe(true);
  });
});

describe("parseAdSpendCsv", () => {
  it("reads a Meta daily export per ad, summing duplicates", () => {
    const r = meta([
      { "Day": "2026-09-01", "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "Beat_the_Hospital-Price", "Ad name": "Video A", "Ad ID": "123", "Amount spent (PHP)": "1,000.50", "Impressions": "900", "Link clicks": "12" },
      { "Day": "2026-09-01", "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-01", "Campaign name": "Beat_the_Hospital-Price", "Ad name": "Video A", "Ad ID": "123", "Amount spent (PHP)": "10", "Impressions": "100", "Link clicks": "1" },
    ]);
    expect(r).toMatchObject({ ok: true, currencyAssumed: false, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([{
      spend_date: "2026-09-01", platform: "meta", campaign_key: "beat the hospital price",
      ad_key: "id:123", campaign_label: "Beat_the_Hospital-Price", spend_php: 1010.5, impressions: 1000, clicks: 13,
    }]);
  });
  it("rejects Meta rows that cover a range (no daily breakdown)", () => {
    const r = meta([{ "Reporting starts": "2026-09-01", "Reporting ends": "2026-09-30", "Campaign name": "C", "Amount spent (PHP)": "50" }]);
    expect(r).toMatchObject({ ok: true, rows: [], rejected: [{ reason: "date_range", count: 1 }] });
  });
  it("refuses a Meta file in another currency", () => {
    expect(meta([{ "Day": "2026-09-01", "Campaign name": "C", "Amount spent (USD)": "5" }]))
      .toEqual({ ok: false, error: expect.stringMatching(/USD/) });
  });
  it("reads a Google export, keys by campaign, ignores Total rows", () => {
    const r = parseAdSpendCsv(
      [
        { "Day": "2026-09-01", "Campaign": "Search - Lab", "Cost": "250", "Impr.": "40", "Clicks": "4", "Currency code": "PHP" },
        { "Day": "", "Campaign": "Total: Account", "Cost": "250", "Impr.": "40", "Clicks": "4", "Currency code": "PHP" },
      ],
      ["Day", "Campaign", "Cost", "Impr.", "Clicks", "Currency code"],
    );
    expect(r).toMatchObject({ ok: true, rejected: [] });
    if (!r.ok) throw new Error();
    expect(r.rows).toEqual([{
      spend_date: "2026-09-01", platform: "google", campaign_key: "search lab", ad_key: "(campaign)",
      campaign_label: "Search - Lab", spend_php: 250, impressions: 40, clicks: 4,
    }]);
  });
  it("refuses a non-PHP currency column", () => {
    expect(parseAdSpendCsv([{ Day: "2026-09-01", Campaign: "C", Cost: "1", "Currency code": "USD" }], ["Day", "Campaign", "Cost", "Currency code"]))
      .toEqual({ ok: false, error: expect.stringMatching(/USD/) });
  });
  it("reads the Ad Performance template (Platform column) and assumes pesos", () => {
    const r = parseAdSpendCsv(
      [
        { Date: "2026-09-01", Platform: "Facebook", Campaign: "C", "Ad name": "A", Spend: "10" },
        { Date: "2026-09-01", Platform: "TikTok", Campaign: "C", "Ad name": "A", Spend: "10" },
      ],
      ["Date", "Platform", "Campaign", "Ad name", "Spend"],
    );
    expect(r).toMatchObject({ ok: true, currencyAssumed: true, rejected: [{ reason: "unknown_platform", count: 1 }] });
    if (!r.ok) throw new Error();
    expect(r.rows[0]).toMatchObject({ platform: "meta", ad_key: "a" });
  });
  it("refuses a file that is neither Meta nor Google", () => {
    expect(parseAdSpendCsv([{ a: "1" }], ["a"])).toEqual({ ok: false, error: expect.stringMatching(/Meta or Google/) });
  });
  it("rejects negative or unreadable spend and missing campaigns", () => {
    const r = parseAdSpendCsv(
      [
        { Day: "2026-09-01", Campaign: "C", Cost: "-5" },
        { Day: "2026-09-01", Campaign: "", Cost: "5" },
        { Day: "2026-09-01", Campaign: "C", Cost: "abc" },
      ],
      ["Day", "Campaign", "Cost"],
    );
    expect(r).toMatchObject({ ok: true, rows: [], rejected: expect.arrayContaining([
      { reason: "bad_spend", count: 2 }, { reason: "no_campaign", count: 1 },
    ]) });
  });
});

describe("describeAdSpendSave", () => {
  it("words a save and a failure", () => {
    expect(describeAdSpendSave({ ok: true, data: { inserted: 3, replaced: 1, days: 2, currencyAssumed: true,
      rejected: [{ reason: "covers more than one day — export with a 1-day breakdown", count: 4 }] } }))
      .toBe("Saved to clinic records: 2 days, 4 rows rejected (4 covers more than one day — export with a 1-day breakdown). No currency column — pesos assumed.");
    expect(describeAdSpendSave({ ok: false, error: "The file is empty." })).toBe("Not saved to clinic records: The file is empty.");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/lib/marketing/ad-spend-import.ts`:

```ts
/**
 * Ad spend CSV → rows for ad_spend_import (spec §2.2; plan P14). Pure, so the
 * server action and the tests share it. The server re-parses the raw file —
 * rows computed in the browser are never trusted.
 *
 * Contract: DAILY rows only (a date range with different ends is rejected, never
 * collapsed to its first day); Meta or Google must be recognisable, else the
 * whole file is refused; a currency that is present and not PHP refuses the
 * file; duplicates of (date, platform, campaign, ad) are summed.
 */
import { daysInMonth } from "@/lib/dates/manila";
import { normaliseCampaignName } from "@/lib/marketing/campaign-results";

export type AdPlatform = "meta" | "google";
export type AdSpendRejectReason = "date_range" | "bad_date" | "no_campaign" | "bad_spend" | "unknown_platform";

export const REJECT_REASON_LABEL: Record<AdSpendRejectReason, string> = {
  date_range: "covers more than one day — export with a 1-day breakdown",
  bad_date: "date not readable",
  no_campaign: "no campaign name",
  bad_spend: "spend not a number of zero or more",
  unknown_platform: "platform is not Meta or Google",
};

export interface AdSpendRow {
  spend_date: string;
  platform: AdPlatform;
  campaign_key: string;
  ad_key: string;
  campaign_label: string;
  spend_php: number;
  impressions: number | null;
  clicks: number | null;
}

export type AdSpendParse =
  | { ok: true; rows: AdSpendRow[]; rejected: { reason: AdSpendRejectReason; count: number }[]; currencyAssumed: boolean }
  | { ok: false; error: string };

export type AdSpendSaveResult =
  | { ok: true; data: { inserted: number; replaced: number; days: number; currencyAssumed: boolean; rejected: { reason: string; count: number }[] } }
  | { ok: false; error: string };

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");
/** "Sep", "Sept", "September" → 9; anything else → null. */
const monthOf = (name: string): number | null =>
  MONTH_INDEX[name.slice(0, 4).toLowerCase()] ?? MONTH_INDEX[name.slice(0, 3).toLowerCase()] ?? null;

function isoOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseOneDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
  if (m) {
    // Month first unless the first number cannot be a month — same rule as the
    // in-browser Ad Performance view (plan P14).
    let month = +m[1];
    let day = +m[2];
    if (month > 12) [month, day] = [day, month];
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return isoOf(year, month, day);
  }
  m = t.match(/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/); // "Sep 1, 2026" / "Mon, Sep 1, 2026"
  if (m) {
    const mon = monthOf(m[1]);
    if (mon) return isoOf(+m[3], mon, +m[2]);
  }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/); // "1 September 2026"
  if (m) {
    const mon = monthOf(m[2]);
    if (mon) return isoOf(+m[3], mon, +m[1]);
  }
  return null;
}

export function parseDateCell(raw: string): { ok: true; date: string } | { ok: false; reason: "date_range" | "bad_date" } {
  const s = String(raw ?? "").trim();
  const range = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (range) {
    const a = parseOneDate(range[1]);
    const b = parseOneDate(range[2]);
    if (!a || !b) return { ok: false, reason: "bad_date" };
    return a === b ? { ok: true, date: a } : { ok: false, reason: "date_range" };
  }
  const d = parseOneDate(s);
  return d ? { ok: true, date: d } : { ok: false, reason: "bad_date" };
}

/** Text from the real header row on: drops a BOM and any title lines above it (Google exports). */
export function locateHeader(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const i = lines.findIndex((l) => /campaign/i.test(l) && /(^|,|")\s*(day|date|reporting starts)\s*("|,|$)/i.test(l));
  return (i > 0 ? lines.slice(i) : lines).join("\n");
}

const h = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function money(v: string | undefined): number | null {
  const s = String(v ?? "").replace(/[₱,\s]|php/gi, "");
  if (s === "") return 0;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
function count(v: string | undefined): number | null {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function parseAdSpendCsv(records: readonly Record<string, string>[], headers: readonly string[]): AdSpendParse {
  const byNorm = new Map(headers.map((x) => [h(x), x]));
  const col = (...names: string[]) => names.map((n) => byNorm.get(n)).find((x) => x !== undefined);
  const colStarts = (prefix: string) => headers.find((x) => h(x).startsWith(prefix));

  const platformCol = col("platform", "source", "network");
  const metaSpendCol = colStarts("amount spent");
  const isMeta = !platformCol && (metaSpendCol !== undefined || col("reporting starts") !== undefined);
  const isGoogle = !platformCol && !isMeta && col("cost") !== undefined && col("campaign") !== undefined;
  if (!platformCol && !isMeta && !isGoogle) {
    return { ok: false, error: "This file is not a Meta or Google Ads export, and it has no Platform column." };
  }

  // Currency (P14): a present, non-PHP currency refuses the whole file.
  const headerCurrency = metaSpendCol?.match(/\(([A-Za-z]{3})\)/)?.[1]?.toUpperCase() ?? null;
  if (headerCurrency && headerCurrency !== "PHP") {
    return { ok: false, error: `This export is in ${headerCurrency}. Export it in PHP.` };
  }
  const currencyCol = col("currency code", "currency");
  if (currencyCol) {
    const other = records.map((r) => String(r[currencyCol] ?? "").trim().toUpperCase()).find((c) => c !== "" && c !== "PHP");
    if (other) return { ok: false, error: `This export is in ${other}. Export it in PHP.` };
  }

  const dayCol = col("day", "date");
  const startCol = col("reporting starts");
  const endCol = col("reporting ends");
  const campaignCol = col("campaign name", "campaign");
  const adIdCol = col("ad id");
  const adNameCol = col("ad name", "ad");
  const spendCol = metaSpendCol ?? col("cost", "spend", "amount");
  const imprCol = col("impressions", "impr.", "impr");
  const clickCol = col("link clicks", "clicks");

  const rejected = new Map<AdSpendRejectReason, number>();
  const reject = (r: AdSpendRejectReason) => rejected.set(r, (rejected.get(r) ?? 0) + 1);
  const rows = new Map<string, AdSpendRow>();

  for (const r of records) {
    const campaign = String((campaignCol && r[campaignCol]) ?? "").trim();
    if (/^total\b/i.test(campaign) || (dayCol && /^total\b/i.test(String(r[dayCol] ?? "").trim()))) continue;

    let platform: AdPlatform;
    if (platformCol) {
      const v = String(r[platformCol] ?? "");
      if (/face|meta|insta|\big\b/i.test(v)) platform = "meta";
      else if (/google|search|goog|adwords/i.test(v)) platform = "google";
      else { reject("unknown_platform"); continue; }
    } else {
      platform = isMeta ? "meta" : "google";
    }

    let date: string;
    if (startCol && endCol && String(r[startCol] ?? "").trim() && String(r[endCol] ?? "").trim()) {
      const a = parseDateCell(r[startCol]);
      const b = parseDateCell(r[endCol]);
      if (!a.ok || !b.ok) { reject(!a.ok ? a.reason : (b as { reason: AdSpendRejectReason }).reason); continue; }
      if (a.date !== b.date) { reject("date_range"); continue; }
      date = a.date;
    } else {
      const d = parseDateCell(String((dayCol && r[dayCol]) ?? ""));
      if (!d.ok) { reject(d.reason); continue; }
      date = d.date;
    }

    if (!campaign) { reject("no_campaign"); continue; }
    const spend = money(spendCol ? r[spendCol] : undefined);
    if (spend === null || spend < 0) { reject("bad_spend"); continue; }
    const impressions = imprCol ? count(r[imprCol]) : null;
    const clicks = clickCol ? count(r[clickCol]) : null;
    if (spend === 0 && !impressions && !clicks) continue; // an empty row, not an error

    const adId = adIdCol ? String(r[adIdCol] ?? "").trim() : "";
    const adName = adNameCol ? normaliseCampaignName(String(r[adNameCol] ?? "")) : "";
    const campaignKey = normaliseCampaignName(campaign);
    const adKey = adId ? `id:${adId}` : adName || "(campaign)";
    const key = `${date}|${platform}|${campaignKey}|${adKey}`;
    const prev = rows.get(key);
    if (prev) {
      prev.spend_php = Math.round((prev.spend_php + spend) * 100) / 100;
      prev.impressions = impressions === null && prev.impressions === null ? null : (prev.impressions ?? 0) + (impressions ?? 0);
      prev.clicks = clicks === null && prev.clicks === null ? null : (prev.clicks ?? 0) + (clicks ?? 0);
    } else {
      rows.set(key, {
        spend_date: date, platform, campaign_key: campaignKey.slice(0, 300), ad_key: adKey.slice(0, 300),
        campaign_label: campaign.slice(0, 300), spend_php: spend, impressions, clicks,
      });
    }
  }

  return {
    ok: true,
    rows: [...rows.values()],
    rejected: [...rejected.entries()].map(([reason, n]) => ({ reason, count: n })),
    currencyAssumed: !headerCurrency && !currencyCol,
  };
}

export function describeAdSpendSave(res: AdSpendSaveResult): string {
  if (!res.ok) return `Not saved to clinic records: ${res.error}`;
  const rejectedTotal = res.data.rejected.reduce((s, r) => s + r.count, 0);
  const detail = rejectedTotal > 0 ? ` (${res.data.rejected.map((r) => `${r.count} ${r.reason}`).join("; ")})` : "";
  const days = `${res.data.days} day${res.data.days === 1 ? "" : "s"}`;
  const rows = `${rejectedTotal} row${rejectedTotal === 1 ? "" : "s"} rejected`;
  return `Saved to clinic records: ${days}, ${rows}${detail}.` +
    (res.data.currencyAssumed ? " No currency column — pesos assumed." : "");
}
```

- [ ] **Step 4: Run** → PASS; then `npx vitest run src/lib/dates` → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/marketing/ad-spend-import.* && git commit -m "feat(marketing): strict daily ad-spend CSV parser (Meta, Google, template)"`

### Task 9: Loaders — the one caller of the RPCs

**Files:**
- Create: `src/lib/marketing/patient-sources.server.ts`

- [ ] **Step 1: Write the module** (no unit test: it is a thin RPC layer; the guard in Task 16 pins who may call the RPCs, and the DB proof pins the SQL):

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { PAGE_SIZE, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  classifyReportError,
  type Grain, type Mode, type OverlapRow, type PeopleRow, type ReferrerRow, type ReportResult,
  type RevenueRow, type SeriesRow, type SpendTotalRow, type SummaryRow,
} from "./patient-sources";

type Db = SupabaseClient<Database>;
type PgErr = { code?: string; message?: string } | null;

function fail(where: string, error: PgErr | unknown) {
  const out = classifyReportError(error);
  if (out.kind === "error") console.error(`[patient-sources] ${where} failed`, (error as PgErr)?.code ?? error);
  return out;
}

/** Pages a set-returning RPC with .range() (PostgREST caps a response at 1,000 rows) keeping the SQLSTATE. */
async function pageAll<T>(
  where: string,
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgErr }>,
  maxRows = REPORT_EXPORT_MAX_ROWS,
): Promise<ReportResult<{ rows: T[]; truncated: boolean }>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return fail(where, error);
    const page = data ?? [];
    rows.push(...page);
    if (rows.length > maxRows) return { ok: true, data: { rows: rows.slice(0, maxRows), truncated: true } };
    if (page.length < PAGE_SIZE) return { ok: true, data: { rows, truncated: false } };
  }
}

export async function loadPatientSourcesSummary(supabase: Db, from: string, to: string): Promise<ReportResult<SummaryRow>> {
  const { data, error } = await supabase.rpc("patient_sources_summary", { p_from: from, p_to: to }).single();
  if (error || !data) return fail("summary", error);
  return { ok: true, data: data as unknown as SummaryRow };
}

export function loadPatientSourcesSeries(supabase: Db, from: string, to: string, grain: Grain | "period", mode: Mode) {
  return pageAll<SeriesRow>("series", (a, b) =>
    supabase
      .rpc("patient_sources_series", { p_from: from, p_to: to, p_grain: grain, p_mode: mode })
      .order("bucket_start")
      .order("channel")
      .range(a, b) as unknown as PromiseLike<{ data: SeriesRow[] | null; error: PgErr }>,
  );
}

export async function loadNewPatientsToday(supabase: Db, todayISO: string): Promise<ReportResult<SeriesRow[]>> {
  const res = await loadPatientSourcesSeries(supabase, todayISO, todayISO, "day", "new");
  return res.ok ? { ok: true, data: res.data.rows } : res;
}

export async function loadPatientSourcesRevenue(supabase: Db, from: string, to: string): Promise<ReportResult<RevenueRow[]>> {
  const { data, error } = await supabase.rpc("patient_sources_revenue", { p_from: from, p_to: to });
  if (error) return fail("revenue", error);
  return { ok: true, data: (data ?? []) as unknown as RevenueRow[] };
}

export function loadPatientSourcesOverlaps(supabase: Db, from: string, to: string) {
  return pageAll<OverlapRow>("overlaps", (a, b) =>
    supabase
      .rpc("patient_sources_overlaps", { p_from: from, p_to: to })
      .order("service_date")
      .order("drm_id")
      .range(a, b) as unknown as PromiseLike<{ data: OverlapRow[] | null; error: PgErr }>,
  );
}

export async function loadPatientSourcesReferrers(supabase: Db, from: string, to: string): Promise<ReportResult<ReferrerRow[]>> {
  const { data, error } = await supabase.rpc("patient_sources_referrers", { p_from: from, p_to: to, p_limit: 20 });
  if (error) return fail("referrers", error);
  return { ok: true, data: (data ?? []) as unknown as ReferrerRow[] };
}

export interface PeopleQuery {
  from: string;
  to: string;
  mode: "new" | "returning" | "served";
  channel: string | null;
}

export async function loadPeoplePage(
  supabase: Db, q: PeopleQuery, limit: number, offset: number,
): Promise<ReportResult<{ rows: PeopleRow[]; total: number }>> {
  const { data, error } = await supabase.rpc("patient_sources_people", {
    p_from: q.from, p_to: q.to, p_mode: q.mode, p_channel: q.channel as string, p_limit: limit, p_offset: offset,
  });
  if (error) return fail("people", error);
  const rows = (data ?? []) as unknown as PeopleRow[];
  return { ok: true, data: { rows, total: rows.length > 0 ? Number(rows[0].total_count) : 0 } };
}

/** Every person for the CSV, 1,000 at a time via the function's own limit/offset (its order is total). */
export async function loadAllPeople(supabase: Db, q: PeopleQuery): Promise<ReportResult<{ rows: PeopleRow[]; truncated: boolean }>> {
  const rows: PeopleRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await loadPeoplePage(supabase, q, PAGE_SIZE, offset);
    if (!page.ok) return page;
    rows.push(...page.data.rows);
    if (rows.length >= REPORT_EXPORT_MAX_ROWS) {
      return { ok: true, data: { rows: rows.slice(0, REPORT_EXPORT_MAX_ROWS), truncated: page.data.total > REPORT_EXPORT_MAX_ROWS } };
    }
    if (page.data.rows.length < PAGE_SIZE) return { ok: true, data: { rows, truncated: false } };
  }
}

export function loadAdSpendTotals(supabase: Db, from: string, to: string) {
  return pageAll<SpendTotalRow>("ad spend", (a, b) =>
    supabase
      .rpc("ad_spend_daily_totals", { p_from: from, p_to: to })
      .order("spend_date")
      .order("platform")
      .range(a, b) as unknown as PromiseLike<{ data: SpendTotalRow[] | null; error: PgErr }>,
  );
}

export interface SpendCoverageRow { platform: "meta" | "google"; first_date: string; last_date: string; days: number; total_php: number }
export async function loadAdSpendCoverage(supabase: Db): Promise<ReportResult<SpendCoverageRow[]>> {
  const { data, error } = await supabase.rpc("ad_spend_coverage");
  if (error) return fail("ad spend coverage", error);
  return { ok: true, data: (data ?? []) as unknown as SpendCoverageRow[] };
}
```
If `PAGE_SIZE` is not exported from `@/lib/reports/paging`, it is (agent-verified: `PAGE_SIZE = 1000`). If the generated RPC arg type for `p_channel` is `string` (not nullable), keep the cast; PostgREST sends `null`.

- [ ] **Step 2:** `npm run typecheck` → PASS.
- [ ] **Step 3: Commit** — `git add src/lib/marketing/patient-sources.server.ts && git commit -m "feat(marketing): Patient Sources loaders (one RPC caller, paged past 1,000 rows)"`

# Phase C — pages and surfaces

### Task 10: Shared period controls; Booking Sources A′

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/marketing/_components/period-controls.tsx`
- Delete: `src/app/(staff)/staff/(dashboard)/marketing/sources/_components/period-chips.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/marketing/sources/page.tsx`, `src/lib/marketing/booking-sources.ts` (+ test), `src/lib/patients/query-surfaces.test.ts`

- [ ] **Step 1: Create the component** (server component — no client JS):

```tsx
/**
 * Period controls shared by the Marketing reports (plan P13): preset pills and
 * a Custom range form. Every link and the form keep the page's other params
 * (mode, grain, channel), so changing the period never resets them. The form
 * is a plain GET, so it carries those params as hidden inputs (CLAUDE.md:
 * "a plain-GET filter form drops whatever it does not carry").
 */
import Link from "next/link";
import { buildMarketingPresets, periodHref } from "@/lib/marketing/period";

const pill =
  "min-h-[36px] rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider";
const pillOn = "bg-[color:var(--color-brand-navy)] text-white";
const pillOff =
  "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]";

export function PeriodControls({
  pathname,
  todayISO,
  from,
  to,
  presetKey,
  error,
  params,
}: {
  pathname: string;
  todayISO: string;
  from: string;
  to: string;
  presetKey: string | null;
  error: string | null;
  /** The page's other params to keep (mode, grain, channel…). */
  params: Readonly<Record<string, string | undefined>>;
}) {
  const presets = buildMarketingPresets(todayISO);
  const hidden = Object.entries(params).filter(([k, v]) => k !== "from" && k !== "to" && k !== "page" && v);
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Period
        </span>
        {presets.map((p) => (
          <Link
            key={p.key}
            href={periodHref(pathname, params, { from: p.start, to: p.end, page: null })}
            className={`${pill} ${p.key === presetKey ? pillOn : pillOff}`}
          >
            {p.label}
          </Link>
        ))}
        <span className={`${pill} ${presetKey === null ? pillOn : pillOff}`}>Custom</span>
      </div>
      <form method="get" action={pathname} className="flex flex-wrap items-end gap-2 text-sm">
        {hidden.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="flex flex-col text-xs font-bold text-[color:var(--color-brand-text-soft)]">
          From
          <input type="date" name="from" defaultValue={from} required className="rounded border px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-col text-xs font-bold text-[color:var(--color-brand-text-soft)]">
          To
          <input type="date" name="to" defaultValue={to} required className="rounded border px-2 py-1 text-sm" />
        </label>
        <button type="submit" className={`${pill} ${pillOff}`}>
          Show
        </button>
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">Up to 400 days.</span>
      </form>
      {error ? (
        <p className="text-sm text-amber-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Rewire Booking Sources** (`marketing/sources/page.tsx`):
  1. Replace `searchParams: Promise<{ from?: string; to?: string }>` with `Promise<Record<string, string | string[] | undefined>>`; compute `const period = resolvePeriod({ from: firstParam(sp.from), to: firstParam(sp.to) }, todayISO)` and use `period.from` / `period.to` everywhere `from` / `to` were used. Drop the `buildPeriodPresets` and `isISODate` imports if now unused.
  2. Replace `<PeriodChips pathname={PATHNAME} from={from} to={to} todayISO={todayISO} />` with `<PeriodControls pathname={PATHNAME} todayISO={todayISO} from={period.from} to={period.to} presetKey={period.presetKey} error={period.error} params={{ from: period.from, to: period.to }} />`.
  3. **Remove** the `patients` `fetchAllRows` read, `patientTruncated` (and its use in the truncation banner), `summarizeNewPatientReferrals`, the `NewPatientSourceRow` import, the `activePatients` import, and the `ProportionTable` titled "New app registrations by how they heard about us".
  4. Add `const summary = await loadPatientSourcesSummary(supabase, period.from, period.to);` (import from `@/lib/marketing/patient-sources.server`) — run it inside the existing `Promise.all`.
  5. Replace the "New app registrations" `StatCard` with:

```tsx
<StatCard
  label="New patients"
  value={
    summary.ok
      ? `${summary.data.new_confirmed.toLocaleString("en-PH")} confirmed · ${summary.data.new_unconfirmed.toLocaleString("en-PH")} unconfirmed`
      : "—"
  }
  hint="First visit recorded, same count as Patient Sources. See by channel →"
  href={`/staff/marketing/patients?from=${period.from}&to=${period.to}`}
  error={!summary.ok}
/>
```
  6. Subtitle: replace the `PageHeader` subtitle with `"Where appointments and website messages came from, for a chosen period. Online bookings and messages tag themselves automatically; a booking made by phone or in person is only countable here from the day reception started picking “How did they reach us?” in the New appointment form. New patients by channel are on Patient Sources."` If any other sentence on the page calls the cards "a funnel", reword it to "the cards".
- [ ] **Step 3: Delete the dead code.** `git rm "src/app/(staff)/staff/(dashboard)/marketing/sources/_components/period-chips.tsx"`. In `src/lib/marketing/booking-sources.ts`, delete `NewPatientSourceRow`, `NewPatientReferralStats`, `summarizeNewPatientReferrals` (and any helper only they use) and their tests in `booking-sources.test.ts` — first confirm with `grep -rn "summarizeNewPatientReferrals\|NewPatientSourceRow\|NewPatientReferralStats" src` that nothing else uses them. In `src/lib/patients/query-surfaces.test.ts`, delete the `[`src/${S}/marketing/sources/page.tsx`]` entry (the page no longer reads `patients`).
- [ ] **Step 4: Run** `npx vitest run src/lib/marketing src/lib/patients/query-surfaces.test.ts src/app/staff-page-titles.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A "src/app/(staff)/staff/(dashboard)/marketing" src/lib/marketing src/lib/patients/query-surfaces.test.ts && git commit -m "feat(marketing): shared period controls; Booking Sources New patients card reads the Patient Sources summary (A′)"`

### Task 11: Route names and the fourth tab

**Files:** `src/lib/staff/route-names.ts`, `src/app/(staff)/staff/(dashboard)/marketing/_components/marketing-tabs.tsx`

- [ ] **Step 1:** In `ROUTE_NAME`, after `"/staff/marketing/sources": "Booking Sources",` add:

```ts
  "/staff/marketing/patients": "Patient Sources",
  "/staff/marketing/patients/people": "Patient Sources — People",
```
- [ ] **Step 2:** In `marketing-tabs.tsx` `TABS`, append `{ href: `${BASE}/patients`, label: ROUTE_NAME["/staff/marketing/patients"] },` (the people page lights the same tab because it is under `/patients`).
- [ ] **Step 3:** `npx vitest run src/app/staff-page-titles.test.ts src/components/staff` → PASS (they fail later if a page lacks `metadata`; Tasks 12–13 add it).
- [ ] **Step 4: Commit** — `git commit -am "feat(marketing): Patient Sources route names and tab"`

### Task 12: Patient Sources page, chart and sections

**Files:**
- Create: `marketing/patients/page.tsx`, `marketing/patients/_components/{channel-chart.tsx,channel-chart-loader.tsx,report-sections.tsx,ad-spend-remove-form.tsx}`, `marketing/ad-spend-actions.ts` (the remove action here; the save action in Task 14)

(All paths below are under `src/app/(staff)/staff/(dashboard)/`.)

- [ ] **Step 1: Chart (client).** `marketing/patients/_components/channel-chart.tsx`:

```tsx
"use client";
/**
 * Stacked bars per channel; each channel has a solid confirmed band and a
 * hatched unconfirmed band (spec §3.2.4). Loaded through channel-chart-loader
 * so recharts is not in the route's first JS bundle (same as ad-charts.tsx).
 */
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

export function ChannelChart({ rows, channels }: { rows: ChartDatum[]; channels: ChartChannel[] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <defs>
          {channels.map((c) => (
            <pattern key={c.key} id={`hatch-${c.key}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="white" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={c.color} strokeWidth="3" />
            </pattern>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {channels.flatMap((c) => [
          <Bar key={`${c.key}-c`} dataKey={`${c.key}__c`} name={c.label} stackId="s" fill={c.color} />,
          <Bar key={`${c.key}-u`} dataKey={`${c.key}__u`} name={`${c.label} (unconfirmed)`} stackId="s" fill={`url(#hatch-${c.key})`} legendType="none" />,
        ])}
      </BarChart>
    </ResponsiveContainer>
  );
}
```

`marketing/patients/_components/channel-chart-loader.tsx`:

```tsx
"use client";
import dynamic from "next/dynamic";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

const ChannelChart = dynamic(() => import("./channel-chart").then((m) => m.ChannelChart), {
  ssr: false,
  loading: () => <div className="h-[320px] animate-pulse rounded bg-[color:var(--color-brand-bg)]" />,
});

export function ChannelChartLoader(props: { rows: ChartDatum[]; channels: ChartChannel[] }) {
  return <ChannelChart {...props} />;
}
```

- [ ] **Step 2: Remove-spend action + form.** Create `marketing/ad-spend-actions.ts` now with the remove action (Task 14 adds the save action to the same file):

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { isISODate } from "@/lib/dates/manila";

export type RemoveAdSpendResult = { ok: true; data: { deleted: number } } | { ok: false; error: string };

export async function removeAdSpendAction(_prev: RemoveAdSpendResult | null, formData: FormData): Promise<RemoveAdSpendResult> {
  await requireAdminStaff();
  const platform = String(formData.get("platform") ?? "");
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  if (platform !== "meta" && platform !== "google") return { ok: false, error: "Pick Meta or Google." };
  if (!isISODate(from) || !isISODate(to) || from > to) return { ok: false, error: "Pick a start date on or before the end date." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ad_spend_delete", { p_platform: platform, p_from: from, p_to: to });
  if (error) {
    console.error("[ad-spend] delete failed", error.code);
    return { ok: false, error: "Couldn't remove the saved spend. Nothing was removed — try again." };
  }
  revalidatePath("/staff/marketing/patients");
  return { ok: true, data: { deleted: Number(data ?? 0) } };
}
```

`marketing/patients/_components/ad-spend-remove-form.tsx`:

```tsx
"use client";
import { useActionState, useState } from "react";
import { removeAdSpendAction, type RemoveAdSpendResult } from "../../ad-spend-actions";

export function AdSpendRemoveForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [state, action, pending] = useActionState<RemoveAdSpendResult | null, FormData>(removeAdSpendAction, null);
  const [confirming, setConfirming] = useState(false);
  const [platform, setPlatform] = useState("meta");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  return (
    <form action={action} onSubmit={() => setConfirming(false)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col text-xs font-bold">
        Platform
        <select name="platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className="rounded border px-2 py-1 text-sm">
          <option value="meta">Meta (Facebook)</option>
          <option value="google">Google</option>
        </select>
      </label>
      <label className="flex flex-col text-xs font-bold">
        From
        <input type="date" name="from" value={from} onChange={(e) => setFrom(e.target.value)} required className="rounded border px-2 py-1 text-sm" />
      </label>
      <label className="flex flex-col text-xs font-bold">
        To
        <input type="date" name="to" value={to} onChange={(e) => setTo(e.target.value)} required className="rounded border px-2 py-1 text-sm" />
      </label>
      {confirming ? (
        <>
          <span className="text-amber-800">
            Remove all saved {platform === "meta" ? "Meta" : "Google"} spend from {from} to {to}?
          </span>
          <button type="submit" disabled={pending} className="rounded bg-red-700 px-3 py-1.5 text-xs font-bold text-white">
            Yes, remove
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded border px-3 py-1.5 text-xs font-bold">
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="rounded border px-3 py-1.5 text-xs font-bold">
          Remove saved spend…
        </button>
      )}
      {state ? (
        <p className={state.ok ? "w-full text-sm text-emerald-700" : "w-full text-sm text-red-600"} role="status">
          {state.ok ? `Removed ${state.data.deleted} saved row${state.data.deleted === 1 ? "" : "s"}.` : state.error}
        </p>
      ) : null}
    </form>
  );
}
```

- [ ] **Step 3: Sections (server).** `marketing/patients/_components/report-sections.tsx` — four exports, all plain tables in `Panel` with `overflow-x-auto` (the `ProportionTable` look). Peso cells use the dashboards' `formatPeso` (`_dashboards/_components/format.ts`) — reuse it; do not build one:

```tsx
import Link from "next/link";
import { Panel } from "@/components/ui/panel";
import { manilaDate } from "@/lib/dates/manila";
import {
  channelLabel, type ChannelTableRow, type CostPerNew, type OverlapRow, type ReferrerRow, type RevenueRow,
} from "@/lib/marketing/patient-sources";
import type { SpendCoverageRow } from "@/lib/marketing/patient-sources.server";
import { formatPeso } from "../../../_dashboards/_components/format";
import { AdSpendRemoveForm } from "./ad-spend-remove-form";

const th = "px-4 py-3";
const thead = "bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]";
const h2 = "mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]";
const note = "mt-2 text-xs text-[color:var(--color-brand-text-soft)]";
const empty = (cols: number, text: string) => (
  <tr><td colSpan={cols} className="px-4 py-6 text-center text-[color:var(--color-brand-text-soft)]">{text}</td></tr>
);

export function ChannelTableSection({ rows, peopleHref, modeLabel }: {
  rows: ChannelTableRow[];
  peopleHref: (channel: string) => string;
  modeLabel: string;
}) {
  return (
    <section className="mt-6">
      <h2 className={h2}>{modeLabel} by channel</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Channel</th>
              <th className={`${th} text-right`}>Confirmed</th>
              <th className={`${th} text-right`}>Unconfirmed</th>
              <th className={`${th} text-right`}>Share</th>
              <th className={`${th} text-right`}>vs previous period</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? empty(5, "Nobody in this period.")
              : rows.map((r) => (
                  <tr key={r.channel} className="border-t">
                    <td className={th}><Link className="underline" href={peopleHref(r.channel)}>{r.label}</Link></td>
                    <td className={`${th} text-right`}>{r.confirmed.toLocaleString("en-PH")}</td>
                    <td className={`${th} text-right`}>{r.unconfirmed.toLocaleString("en-PH")}</td>
                    <td className={`${th} text-right`}>{Math.round(r.share * 100)}%</td>
                    <td className={`${th} text-right`}>
                      {r.change > 0 ? `+${r.change}` : r.change} (was {r.previousTotal})
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        Unconfirmed = a name in the reception sheet not yet matched to a patient record. Click a channel to see the people.
      </p>
    </section>
  );
}

export function CostSection({ costs, coverage, from, to }: {
  costs: CostPerNew[] | null;
  coverage: SpendCoverageRow[] | null;
  from: string;
  to: string;
}) {
  return (
    <section className="mt-6">
      <h2 className={h2}>Cost per new patient</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Ads</th>
              <th className={`${th} text-right`}>Spend</th>
              <th className={`${th} text-right`}>Days with spend</th>
              <th className={`${th} text-right`}>New customers (confirmed + unconfirmed)</th>
              <th className={`${th} text-right`}>Cost per new patient</th>
            </tr>
          </thead>
          <tbody>
            {costs === null
              ? empty(5, "Couldn't load saved ad spend — reload the page.")
              : costs.every((c) => c.days === 0)
                ? empty(5, "No ad spend saved for this period. Upload a daily export on Ad Performance.")
                : costs.map((c) => (
                    <tr key={c.platform} className="border-t">
                      <td className={th}>{c.label}</td>
                      <td className={`${th} text-right`}>{formatPeso(c.spendPhp)}</td>
                      <td className={`${th} text-right`}>{c.days}</td>
                      <td className={`${th} text-right`}>{c.newConfirmed} + {c.newUnconfirmed}</td>
                      <td className={`${th} text-right`}>{c.costPerNewPhp === null ? "—" : formatPeso(c.costPerNewPhp)}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        Spend ÷ new customers whose channel is Facebook (Meta) or Google, counted only on days that have saved spend —
        days without spend are left out. Instagram and TikTok are not counted against Meta spend.
      </p>
      {coverage && coverage.length > 0 ? (
        <p className={note}>
          Saved spend on file:{" "}
          {coverage.map((c) => `${c.platform === "meta" ? "Meta" : "Google"} ${manilaDate(c.first_date)} – ${manilaDate(c.last_date)} (${c.days} days, ${formatPeso(Number(c.total_php))})`).join(" · ")}
        </p>
      ) : null}
      <AdSpendRemoveForm defaultFrom={from} defaultTo={to} />
    </section>
  );
}

export function RevenueSection({ revenue, overlaps }: { revenue: RevenueRow[] | null; overlaps: OverlapRow[] | null }) {
  return (
    <section className="mt-6">
      <h2 className={h2}>Channel revenue — billed (clinic share)</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Channel</th>
              <th className={`${th} text-right`}>Confirmed</th>
              <th className={`${th} text-right`}>Unconfirmed</th>
            </tr>
          </thead>
          <tbody>
            {revenue === null
              ? empty(3, "Couldn't load revenue — reload the page.")
              : revenue.length === 0
                ? empty(3, "No billed services in this period.")
                : revenue.map((r) => (
                    <tr key={r.channel} className="border-t">
                      <td className={th}>{channelLabel(r.channel)}</td>
                      <td className={`${th} text-right`}>{formatPeso(Number(r.confirmed_php))}</td>
                      <td className={`${th} text-right`}>{formatPeso(Number(r.unconfirmed_php))}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        What was billed on the service date — app lab lines at their final price, consultations at the clinic fee — not
        what was collected.
      </p>
      {overlaps && overlaps.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold">Possible double entry ({overlaps.length})</summary>
          <p className={note}>
            The same patient on the same day has an app visit and sheet lines. The sheet amount is left out of the revenue
            above; check which record is right.
          </p>
          <Panel className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={thead}>
                <tr>
                  <th className={th}>DRM-ID</th>
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>App amount</th>
                  <th className={`${th} text-right`}>Sheet amount</th>
                </tr>
              </thead>
              <tbody>
                {overlaps.map((o) => (
                  <tr key={`${o.patient_id}|${o.service_date}`} className="border-t">
                    <td className={th}><Link className="underline" href={`/staff/patients/${o.patient_id}`}>{o.drm_id}</Link></td>
                    <td className={th}>{manilaDate(o.service_date)}</td>
                    <td className={`${th} text-right`}>{formatPeso(Number(o.app_php))}</td>
                    <td className={`${th} text-right`}>{formatPeso(Number(o.sheet_php))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </details>
      ) : null}
    </section>
  );
}

export function ReferrersSection({ rows }: { rows: ReferrerRow[] | null }) {
  return (
    <section className="mt-6">
      <h2 className={h2}>Top referring doctors</h2>
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Doctor (as most often written)</th>
              <th className={`${th} text-right`}>New — confirmed</th>
              <th className={`${th} text-right`}>New — unconfirmed</th>
            </tr>
          </thead>
          <tbody>
            {rows === null
              ? empty(3, "Couldn't load referring doctors — reload the page.")
              : rows.length === 0
                ? empty(3, "No new customer in this period named a referring doctor.")
                : rows.map((r) => (
                    <tr key={r.doctor_label} className="border-t">
                      <td className={th}>{r.doctor_label}</td>
                      <td className={`${th} text-right`}>{r.new_confirmed}</td>
                      <td className={`${th} text-right`}>{r.new_unconfirmed}</td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </Panel>
      <p className={note}>
        Spellings are grouped ignoring “Dr.”, “Dra.”, “Doc”, capitals and punctuation. Top 20.
      </p>
    </section>
  );
}
```
The patient page is `/staff/patients/[id]` (verified).

- [ ] **Step 4: The page.** `marketing/patients/page.tsx`:

```tsx
import Link from "next/link";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PageHeader } from "@/components/staff/page-header";
import { createClient } from "@/lib/supabase/server";
import { manilaDate, manilaDateTime, todayManilaISODate } from "@/lib/dates/manila";
import { firstParam, periodHref, resolvePeriod } from "@/lib/marketing/period";
import {
  GRAIN_LABEL, MODE_LABEL, channelTable, chartData, costPerNewPatient, parseGrain, parseMode, previousPeriod,
  type Grain, type Mode,
} from "@/lib/marketing/patient-sources";
import {
  loadAdSpendCoverage, loadAdSpendTotals, loadPatientSourcesOverlaps, loadPatientSourcesReferrers,
  loadPatientSourcesRevenue, loadPatientSourcesSeries, loadPatientSourcesSummary,
} from "@/lib/marketing/patient-sources.server";
import { StatCard } from "../../_dashboards/_components/stat-card";
import { PeriodControls } from "../_components/period-controls";
import { ChannelChartLoader } from "./_components/channel-chart-loader";
import { ChannelTableSection, CostSection, ReferrersSection, RevenueSection } from "./_components/report-sections";

export const metadata = { title: ROUTE_NAME["/staff/marketing/patients"] };
export const dynamic = "force-dynamic";

const PATHNAME = "/staff/marketing/patients";
const SHEET_TABS: Record<string, string> = { lab: "Lab", consult: "Consultations", customers: "Customers" };

export default async function PatientSourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const todayISO = todayManilaISODate();
  const period = resolvePeriod({ from: firstParam(sp.from), to: firstParam(sp.to) }, todayISO);
  const mode: Mode = parseMode(firstParam(sp.mode));
  const grain: Grain = parseGrain(firstParam(sp.grain));
  const params = { from: period.from, to: period.to, mode, grain };
  const prev = previousPeriod(period.from, period.to);
  const supabase = await createClient();

  const [summary, series, current, previous, newByDay, revenue, overlaps, referrers, spend, coverage] = await Promise.all([
    loadPatientSourcesSummary(supabase, period.from, period.to),
    loadPatientSourcesSeries(supabase, period.from, period.to, grain, mode),
    loadPatientSourcesSeries(supabase, period.from, period.to, "period", mode),
    loadPatientSourcesSeries(supabase, prev.from, prev.to, "period", mode),
    loadPatientSourcesSeries(supabase, period.from, period.to, "day", "new"),
    loadPatientSourcesRevenue(supabase, period.from, period.to),
    loadPatientSourcesOverlaps(supabase, period.from, period.to),
    loadPatientSourcesReferrers(supabase, period.from, period.to),
    loadAdSpendTotals(supabase, period.from, period.to),
    loadAdSpendCoverage(supabase),
  ]);

  const header = (
    <PageHeader
      eyebrow={SECTION_NAME["/staff/marketing"]}
      title={ROUTE_NAME["/staff/marketing/patients"]}
      subtitle="Where new and returning customers came from, per day, week or month — from the app and, once the sheet sync runs, from the reception Google Sheet."
    />
  );

  if (!summary.ok) {
    return (
      <div>
        {header}
        <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
          {summary.message}
        </p>
      </div>
    );
  }
  const s = summary.data;
  const lastDates = Object.entries(s.sheet_last_dates ?? {}).filter(([, d]) => d);
  const toggle = (patch: Record<string, string>, label: string, on: boolean) => (
    <Link
      key={label}
      href={periodHref(PATHNAME, params, patch)}
      className={
        "min-h-[36px] rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider " +
        (on ? "bg-[color:var(--color-brand-navy)] text-white" : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]")
      }
    >
      {label}
    </Link>
  );
  const peopleHref = (m: "new" | "returning" | "served", channel?: string) =>
    periodHref(`${PATHNAME}/people`, { from: period.from, to: period.to }, { mode: m, channel });
  const chart = series.ok ? chartData(series.data.rows, grain) : null;
  const table = current.ok && previous.ok ? channelTable(current.data.rows, previous.data.rows) : null;
  const costs = spend.ok && newByDay.ok ? costPerNewPatient(spend.data.rows, newByDay.data.rows) : null;

  return (
    <div>
      {header}
      <PeriodControls pathname={PATHNAME} todayISO={todayISO} from={period.from} to={period.to}
        presetKey={period.presetKey} error={period.error} params={params} />
      <div className="mb-4 flex flex-wrap gap-2">
        {toggle({ mode: "new" }, MODE_LABEL.new, mode === "new")}
        {toggle({ mode: "served" }, MODE_LABEL.served, mode === "served")}
        <span className="mx-2" />
        {(["day", "week", "month"] as const).map((g) => toggle({ grain: g }, GRAIN_LABEL[g], grain === g))}
        <a className="ml-auto text-sm underline"
          href={periodHref("/api/admin/reports/patient-sources.csv", params, {})}>Download CSV</a>
      </div>

      {s.sync_paused !== false || s.last_synced_at === null ? (
        <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Sheet data is not included yet — the sheet sync is paused. Showing app records only.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="New customers" href={peopleHref("new")}
          value={`${s.new_confirmed.toLocaleString("en-PH")} confirmed · ${s.new_unconfirmed.toLocaleString("en-PH")} unconfirmed`}
          hint="First visit recorded since Dec 2023 (or registration, if no visit yet)" />
        <StatCard label="Returning, first time in our records" href={peopleHref("returning")}
          value={s.returning_first_recorded.toLocaleString("en-PH")}
          hint="The sheet marks them as repeat customers" />
        <StatCard label="All customers served" href={peopleHref("served")}
          value={`${s.served_confirmed.toLocaleString("en-PH")} confirmed · ${s.served_unconfirmed.toLocaleString("en-PH")} unconfirmed`}
          hint="Everyone with a visit in the period, counted once" />
        <StatCard label="Source recorded"
          value={`${s.source_recorded.toLocaleString("en-PH")} of ${s.source_total.toLocaleString("en-PH")}`}
          hint="New customers whose channel is known" />
      </div>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        {s.undated_registrations.toLocaleString("en-PH")} people registered with no date and no recorded visit — not on any day.
        {lastDates.length > 0
          ? ` Sheet last updated: ${lastDates.map(([tab, d]) => `${SHEET_TABS[tab] ?? tab} ${manilaDate(d as string)}`).join(" · ")}.`
          : ""}
        {s.last_synced_at ? ` Last sync: ${manilaDateTime(s.last_synced_at)}.` : ""}
      </p>

      <section className="mt-6">
        <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          {MODE_LABEL[mode]} per {GRAIN_LABEL[grain].toLowerCase()}
        </h2>
        {chart === null ? (
          <p className="text-sm text-amber-700">Couldn&apos;t load the chart — reload the page.</p>
        ) : chart.rows.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">Nobody in this period.</p>
        ) : (
          <ChannelChartLoader rows={chart.rows} channels={chart.channels} />
        )}
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Solid = confirmed patient records. Hatched = unconfirmed: a name in the reception sheet not yet matched to a patient record.
        </p>
      </section>

      {table === null ? (
        <p className="mt-6 text-sm text-amber-700">Couldn&apos;t load the channel table — reload the page.</p>
      ) : (
        <ChannelTableSection rows={table} modeLabel={MODE_LABEL[mode]}
          peopleHref={(channel) => peopleHref(mode === "served" ? "served" : "new", channel)} />
      )}
      <CostSection costs={costs} coverage={coverage.ok ? coverage.data : null} from={period.from} to={period.to} />
      <RevenueSection revenue={revenue.ok ? revenue.data : null} overlaps={overlaps.ok ? overlaps.data.rows : null} />
      <ReferrersSection rows={referrers.ok ? referrers.data : null} />

      <section className="mt-8 text-sm text-[color:var(--color-brand-text-soft)]">
        <h2 className="mb-1 font-bold text-[color:var(--color-brand-navy)]">How these numbers work</h2>
        <p>
          A new customer counts on their first visit recorded since December 2023, in the app or the reception sheet — or on
          the day they registered, if they have not visited yet. Counts can move when an earlier registration later gets its
          first recorded visit. Merged duplicate records count once; deleted records are left out.
        </p>
      </section>
    </div>
  );
}
```
Run `grep -n "export function manilaDate\b\|export function manilaDateTime" src/lib/dates/manila.ts` — both exist (CLAUDE.md). If `StatCard`'s `value` type rejects the confirmed/unconfirmed string, it accepts `number | string` (verified).

- [ ] **Step 5:** `npm run typecheck && npm run lint && npx vitest run src/app/staff-page-titles.test.ts src/lib/dates` → PASS.
- [ ] **Step 6: Commit** — `git add -A "src/app/(staff)/staff/(dashboard)/marketing" && git commit -m "feat(marketing): Patient Sources page — cards, chart, channel table, cost, revenue, referrers"`

### Task 13: People list and CSV exports

**Files:**
- Create: `marketing/patients/people/page.tsx`, `src/app/api/admin/reports/patient-sources.csv/route.ts`, `src/app/api/admin/reports/patient-sources-people.csv/route.ts`

- [ ] **Step 1: People page** (`src/app/(staff)/staff/(dashboard)/marketing/patients/people/page.tsx`):

```tsx
import Link from "next/link";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { manilaDate, todayManilaISODate } from "@/lib/dates/manila";
import { firstParam, periodHref, resolvePeriod } from "@/lib/marketing/period";
import { channelLabel } from "@/lib/marketing/patient-sources";
import { loadPeoplePage, type PeopleQuery } from "@/lib/marketing/patient-sources.server";
import { PeriodControls } from "../../_components/period-controls";

export const metadata = { title: ROUTE_NAME["/staff/marketing/patients/people"] };
export const dynamic = "force-dynamic";

const PATHNAME = "/staff/marketing/patients/people";
const PAGE = 50;
const MODE_TITLE = { new: "New customers", returning: "Returning, first time in our records", served: "All customers served" } as const;

export default async function PatientSourcesPeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireAdminStaff();
  const sp = await searchParams;
  const todayISO = todayManilaISODate();
  const period = resolvePeriod({ from: firstParam(sp.from), to: firstParam(sp.to) }, todayISO);
  const rawMode = firstParam(sp.mode);
  const mode: PeopleQuery["mode"] = rawMode === "served" || rawMode === "returning" ? rawMode : "new";
  const channel = firstParam(sp.channel) || null;
  const page = Math.max(1, Number.parseInt(firstParam(sp.page) ?? "1", 10) || 1);
  const params = { from: period.from, to: period.to, mode, channel: channel ?? undefined, page: String(page) };
  const supabase = await createClient();
  const q: PeopleQuery = { from: period.from, to: period.to, mode, channel };
  const res = await loadPeoplePage(supabase, q, PAGE, (page - 1) * PAGE);

  if (res.ok) {
    // RA 10173: a list of names is a disclosure. Counts and filters only, no names.
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: staff.user_id,
      actor_type: "staff",
      action: "patient_sources.viewed",
      resource_type: "report",
      metadata: { from: period.from, to: period.to, mode, channel, page, shown: res.data.rows.length, total: res.data.total },
      ip_address: ip,
      user_agent: ua,
    });
  }

  const title = `${MODE_TITLE[mode]}${channel ? ` — ${channelLabel(channel)}` : ""}`;
  return (
    <div>
      <PageHeader eyebrow={SECTION_NAME["/staff/marketing"]} title={ROUTE_NAME["/staff/marketing/patients/people"]} subtitle={title} />
      <p className="mb-3 text-sm">
        <Link className="underline" href={periodHref("/staff/marketing/patients", { from: period.from, to: period.to }, {})}>
          ← Back to Patient Sources
        </Link>{" "}
        ·{" "}
        <a className="underline" href={periodHref("/api/admin/reports/patient-sources-people.csv", { from: period.from, to: period.to, mode, channel: channel ?? undefined }, {})}>
          Download CSV
        </a>
      </p>
      <PeriodControls pathname={PATHNAME} todayISO={todayISO} from={period.from} to={period.to}
        presetKey={period.presetKey} error={period.error} params={params} />
      {!res.ok ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">{res.message}</p>
      ) : (
        <>
          <Panel className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">DRM-ID</th>
                  <th className="px-4 py-3">Record</th>
                </tr>
              </thead>
              <tbody>
                {res.data.rows.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-[color:var(--color-brand-text-soft)]">Nobody here for this period.</td></tr>
                ) : (
                  res.data.rows.map((r) => (
                    <tr key={r.identity} className="border-t">
                      <td className="px-4 py-3">{manilaDate(r.first_date)}</td>
                      <td className="px-4 py-3">
                        {r.patient_id ? <Link className="underline" href={`/staff/patients/${r.patient_id}`}>{r.display_name}</Link> : r.display_name}
                      </td>
                      <td className="px-4 py-3">{r.drm_id ?? "—"}</td>
                      <td className="px-4 py-3">{r.identity_kind === "confirmed" ? "Patient record" : "Name in the sheet (unconfirmed)"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Panel>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span>
              {res.data.total === 0 ? "0" : `${(page - 1) * PAGE + 1}–${(page - 1) * PAGE + res.data.rows.length}`} of {res.data.total.toLocaleString("en-PH")}
            </span>
            <span className="flex gap-3">
              {page > 1 ? <Link className="underline" href={periodHref(PATHNAME, params, { page: String(page - 1) })}>← Previous</Link> : null}
              {page * PAGE < res.data.total ? <Link className="underline" href={periodHref(PATHNAME, params, { page: String(page + 1) })}>Next →</Link> : null}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
```
`ipAndAgent` is the helper `reportCsvResponse` uses. If the page-render audit pattern in `patients/[id]/consent/signed/page.tsx` differs, match it.

- [ ] **Step 2: Counts CSV** (`src/app/api/admin/reports/patient-sources.csv/route.ts`):

```ts
import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { resolvePeriod } from "@/lib/marketing/period";
import { parseGrain, parseMode, seriesCsvRows } from "@/lib/marketing/patient-sources";
import { loadPatientSourcesSeries, loadPatientSourcesSummary } from "@/lib/marketing/patient-sources.server";

// Admin-only, RLS-scoped client, row ceiling, audit row (report-CSV pattern;
// plan P12). Counts only — no names.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const sp = req.nextUrl.searchParams;
  const todayISO = todayManilaISODate();
  const period = resolvePeriod({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, todayISO);
  const mode = parseMode(sp.get("mode") ?? undefined);
  const grain = parseGrain(sp.get("grain") ?? undefined);
  const supabase = await createClient();
  const [summary, series] = await Promise.all([
    loadPatientSourcesSummary(supabase, period.from, period.to),
    loadPatientSourcesSeries(supabase, period.from, period.to, grain, mode),
  ]);
  if (!summary.ok) return new Response(summary.message, { status: summary.kind === "forbidden" ? 403 : 500 });
  if (!series.ok) return new Response(series.message, { status: series.kind === "forbidden" ? 403 : 500 });
  return reportCsvResponse({
    staff,
    report: "patient_sources",
    filename: `patient-sources-${period.from}-to-${period.to}-${mode}-${grain}.csv`,
    rows: seriesCsvRows({ from: period.from, to: period.to, mode, grain }, summary.data, series.data.rows),
    truncated: series.data.truncated,
    filters: { from: period.from, to: period.to, mode, grain },
  });
}
```

- [ ] **Step 3: People CSV** (`src/app/api/admin/reports/patient-sources-people.csv/route.ts`):

```ts
import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { resolvePeriod } from "@/lib/marketing/period";
import { channelLabel } from "@/lib/marketing/patient-sources";
import { loadAllPeople, type PeopleQuery } from "@/lib/marketing/patient-sources.server";

// Names ⇒ its own audit action (report.patient_sources_people.exported).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const sp = req.nextUrl.searchParams;
  const period = resolvePeriod({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, todayManilaISODate());
  const raw = sp.get("mode");
  const mode: PeopleQuery["mode"] = raw === "served" || raw === "returning" ? raw : "new";
  const channel = sp.get("channel") || null;
  const supabase = await createClient();
  const res = await loadAllPeople(supabase, { from: period.from, to: period.to, mode, channel });
  if (!res.ok) return new Response(res.message, { status: res.kind === "forbidden" ? 403 : 500 });
  return reportCsvResponse({
    staff,
    report: "patient_sources_people",
    filename: `patient-sources-people-${period.from}-to-${period.to}-${mode}.csv`,
    rows: [
      ["Date", "Name", "DRM-ID", "Record", "Channel filter"],
      ...res.data.rows.map((r) => [
        r.first_date,
        r.display_name ?? "",
        r.drm_id ?? "",
        r.identity_kind === "confirmed" ? "Patient record" : "Name in the sheet (unconfirmed)",
        channel ? channelLabel(channel) : "All channels",
      ]),
    ],
    truncated: res.data.truncated,
    filters: { from: period.from, to: period.to, mode, channel },
  });
}
```
If a sibling route handler takes `(request: Request)` instead of `NextRequest`, match it (`new URL(request.url).searchParams`).

- [ ] **Step 4:** `npm run typecheck && npm run lint && npx vitest run src/app src/lib/reports` → PASS.
- [ ] **Step 5: Commit** — `git add -A "src/app/(staff)/staff/(dashboard)/marketing/patients/people" src/app/api/admin/reports/patient-sources*.csv && git commit -m "feat(marketing): audited people list and Patient Sources CSV exports"`

### Task 14: Ad Performance upload saves spend

**Files:** `marketing/ad-spend-actions.ts` (append), `marketing/_components/ad-dashboard.tsx`

- [ ] **Step 1: Append the save action** to `src/app/(staff)/staff/(dashboard)/marketing/ad-spend-actions.ts`:

```ts
import { randomUUID } from "node:crypto";
import Papa from "papaparse";
import type { Json } from "@/types/database";
import {
  locateHeader, parseAdSpendCsv, REJECT_REASON_LABEL, type AdSpendSaveResult,
} from "@/lib/marketing/ad-spend-import";

const MAX_CSV_CHARS = 5_000_000;

export async function saveAdSpendAction(csvText: string): Promise<AdSpendSaveResult> {
  await requireAdminStaff();
  if (typeof csvText !== "string" || csvText.trim() === "") return { ok: false, error: "The file is empty." };
  if (csvText.length > MAX_CSV_CHARS) return { ok: false, error: "The file is larger than 5 MB — export a shorter date range." };

  const parsed = Papa.parse<Record<string, string>>(locateHeader(csvText), { header: true, skipEmptyLines: true });
  const result = parseAdSpendCsv(parsed.data, parsed.meta.fields ?? []);
  if (!result.ok) return { ok: false, error: result.error };
  const rejected = result.rejected.map((r) => ({ reason: REJECT_REASON_LABEL[r.reason], count: r.count }));
  if (result.rows.length === 0) {
    return { ok: true, data: { inserted: 0, replaced: 0, days: 0, currencyAssumed: result.currencyAssumed, rejected } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ad_spend_import", {
    p_upload_id: randomUUID(),
    p_rows: result.rows as unknown as Json,
  });
  if (error || !data) {
    console.error("[ad-spend] import failed", error?.code);
    return { ok: false, error: "Couldn't save the ad spend. Nothing was saved — try again." };
  }
  const counts = data as { inserted: number; replaced: number; days: number };
  revalidatePath("/staff/marketing/patients");
  return { ok: true, data: { ...counts, currencyAssumed: result.currencyAssumed, rejected } };
}
```
Move the new imports to the top of the file with the others.

- [ ] **Step 2: Call it from the upload.** In `marketing/_components/ad-dashboard.tsx`:
  - import `{ saveAdSpendAction } from "../ad-spend-actions"` and `{ describeAdSpendSave } from "@/lib/marketing/ad-spend-import"`;
  - add `const [saveNote, setSaveNote] = useState("");` beside `note`;
  - in `onUpload`, right after `if (!file) return;`, add:

```ts
    // Also save the spend to the clinic's records for Patient Sources' cost per
    // new patient (spec §2.3). The server re-parses the raw file with the strict
    // daily-only contract; the in-browser view below is unchanged.
    setSaveNote("Saving to clinic records…");
    void file
      .text()
      .then((text) => saveAdSpendAction(text))
      .then((res) => setSaveNote(describeAdSpendSave(res)))
      .catch(() => setSaveNote("Not saved to clinic records: the upload failed — try again."));
```
  - in `reset`, add `setSaveNote("");`;
  - render `{saveNote ? <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]" role="status">{saveNote}</p> : null}` immediately after the element that renders `note` (`grep -n "{note" ad-dashboard.tsx`).
- [ ] **Step 3:** `npm run typecheck && npm run lint && npx vitest run src/lib/patients/write-guards.test.ts src/lib/marketing` → PASS.
- [ ] **Step 4: Commit** — `git add -A "src/app/(staff)/staff/(dashboard)/marketing" && git commit -m "feat(marketing): Ad Performance upload also saves daily ad spend (server re-parse, all-or-nothing)"`

### Task 15: Admin dashboard tile

**Files:** `src/lib/dashboards/cards.ts`, `src/lib/dashboards/cards.test.ts`, `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx`

- [ ] **Step 1: Failing test** — append to `cards.test.ts`:

```ts
it("ships the New patients today tile on for admin", () => {
  const card = DASHBOARD_CARDS.find((c) => c.id === "admin.new_patients_today");
  expect(card).toMatchObject({ label: "New patients today", roles: ["admin"], group: "people" });
  expect(hiddenCardIdsFor("admin", []).has("admin.new_patients_today")).toBe(false);
});
```
(Use the file's existing imports; add `DASHBOARD_CARDS` if missing.) Run → FAIL.

- [ ] **Step 2: Register** — in `DASHBOARD_CARDS`, next to the other admin `people` cards (or after `admin.patient_ar` if none): `{ id: "admin.new_patients_today", label: "New patients today", roles: ["admin"], group: "people" },`. Run → PASS.

- [ ] **Step 3: Render.** In `admin-dashboard.tsx`:
  - import `{ loadNewPatientsToday }` from `@/lib/marketing/patient-sources.server` and `{ formatNewToday }` from `@/lib/marketing/patient-sources`;
  - in `loadAdminStats`, add to the `Promise.all` array (last element) `show("admin.new_patients_today") ? loadNewPatientsToday(supabase, todayManilaISODate()) : Promise.resolve(null)` using the file's RLS `createClient()` instance, destructure it as `newToday`, and return it on the stats object (type `ReportResult<SeriesRow[]> | null`);
  - render, beside the other `people` cards:

```tsx
{show("admin.new_patients_today") && (() => {
  const today = todayManilaISODate();
  const f = stats.newToday?.ok ? formatNewToday(stats.newToday.data) : null;
  return (
    <StatCard
      label="New patients today"
      value={f ? f.total : 0}
      hint={f?.hint}
      href={`/staff/marketing/patients?from=${today}&to=${today}`}
      error={!stats.newToday?.ok}
    />
  );
})()}
```
  If the file avoids inline IIFEs, compute `newTodayTile` before the JSX instead — same values.
- [ ] **Step 4:** `npx vitest run src/lib/dashboards && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(dashboard): New patients today tile from the Patient Sources series"`

### Task 16: Reception prompt on the new-visit form

**Files:** `src/lib/patients/referral-sources.ts` (+ test), `visits/new/page.tsx`, `visits/new/visit-form.tsx`, `visits/new/actions.ts`

- [ ] **Step 1: Failing test** — append to `src/lib/patients/referral-sources.test.ts`:

```ts
describe("parseReferralAnswer", () => {
  it("accepts a known id and treats blank or unknown as no answer", () => {
    expect(parseReferralAnswer("online_facebook")).toBe("online_facebook");
    expect(parseReferralAnswer("")).toBeNull();
    expect(parseReferralAnswer(null)).toBeNull();
    expect(parseReferralAnswer("not_recorded")).toBeNull();
    expect(parseReferralAnswer("hacker")).toBeNull();
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** in `referral-sources.ts` (after `isReferralSource`):

```ts
/** A form's optional "How did you hear about us?" answer: a known id, or null for skipped/unknown. */
export function parseReferralAnswer(value: FormDataEntryValue | null | undefined): ReferralSourceId | null {
  return typeof value === "string" && isReferralSource(value) ? value : null;
}
```
Run → PASS.

- [ ] **Step 3: Load the source.** In `visits/new/page.tsx` change the patient select to `"id, drm_id, first_name, last_name, referral_source"`; in `visit-form.tsx` add `referral_source: string | null;` to `PatientLite`.

- [ ] **Step 4: Render the prompt** in `visit-form.tsx`, directly above the receptionist-remarks field (import `REFERRAL_SOURCE_IDS`, `REFERRAL_SOURCE_LABEL`, `PUBLIC_REFERRAL_QUESTION` from `@/lib/patients/referral-sources`):

```tsx
{patient.referral_source === null ? (
  <label className="block text-sm">
    <span className="font-bold">{PUBLIC_REFERRAL_QUESTION}</span>{" "}
    <span className="text-[color:var(--color-brand-text-soft)]">(optional — ask the patient; skip if they don&apos;t say)</span>
    <select name="referral_source" defaultValue="" className="mt-1 block w-full rounded border px-2 py-2">
      <option value="">— Skip —</option>
      {REFERRAL_SOURCE_IDS.map((id) => (
        <option key={id} value={id}>{REFERRAL_SOURCE_LABEL[id]}</option>
      ))}
    </select>
  </label>
) : null}
```
Match the label/select classes used by the neighbouring fields in the form.

- [ ] **Step 5: Save it** in `actions.ts` inside `createVisitAction` (never in a helper — P15): import `parseReferralAnswer`; after the `patient.identity_verified` block (`if (verifiedRows && …) { … }`) add:

```ts
  // Patient Sources (spec §3.7): reception answered "How did you hear about
  // us?" for a patient with no source yet. Conditional on it still being empty,
  // so a value set meanwhile is never overwritten. RLS client with no
  // app.referral_origin → 0170's trigger records origin 'staff'. Optional:
  // a failure here never undoes the visit.
  const referralAnswer = parseReferralAnswer(formData.get("referral_source"));
  if (referralAnswer) {
    const { data: sourced, error: sourceErr } = await supabase
      .from("patients")
      .update({ referral_source: referralAnswer })
      .eq("id", parsed.data.patient_id)
      .is("referral_source", null)
      .select("id");
    if (sourceErr) {
      console.error("[visits/new] referral source not saved", sourceErr.code);
    } else if (sourced && sourced.length > 0) {
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: parsed.data.patient_id,
        action: "patient.referral_source_recorded",
        resource_type: "patient",
        resource_id: parsed.data.patient_id,
        metadata: { referral_source: referralAnswer, via: "new_visit" },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }
```
- [ ] **Step 6:** `npx vitest run src/lib/patients && npm run typecheck && npm run lint` → PASS (`write-guards.test.ts` credits the write to `createVisitAction`'s own `assertPatientActive(` call).
- [ ] **Step 7: Commit** — `git add -A src/lib/patients "src/app/(staff)/staff/(dashboard)/visits/new" && git commit -m "feat(visits): optional How did you hear about us? prompt for patients with no source"`

### Task 17: Surface guard — one definition, one caller

**Files:**
- Create: `src/lib/marketing/patient-sources-surfaces.test.ts`

- [ ] **Step 1: Write the guard.**

```ts
/**
 * Spec §5 "Equality": Booking Sources, Patient Sources, the dashboard tile and
 * the CSV header must show the same numbers. They do by construction if every
 * surface reads the report RPCs through the ONE loader module — this pins it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const RPCS = [
  "patient_sources_summary", "patient_sources_series", "patient_sources_revenue", "patient_sources_overlaps",
  "patient_sources_referrers", "patient_sources_people", "ad_spend_daily_totals", "ad_spend_coverage",
  "ad_spend_import", "ad_spend_delete",
];
const CALLERS: Record<string, string> = {
  "src/lib/marketing/patient-sources.server.ts": "the loader module",
  "src/app/(staff)/staff/(dashboard)/marketing/ad-spend-actions.ts": "the two ad-spend write actions",
  "src/types/database.ts": "generated types",
};
const S = "src/app/(staff)/staff/(dashboard)";
const SURFACES: Record<string, string> = {
  [`${S}/marketing/patients/page.tsx`]: "loadPatientSourcesSummary",
  [`${S}/marketing/sources/page.tsx`]: "loadPatientSourcesSummary",
  [`${S}/_dashboards/admin-dashboard.tsx`]: "loadNewPatientsToday",
  ["src/app/api/admin/reports/patient-sources.csv/route.ts"]: "loadPatientSourcesSummary",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

describe("Patient Sources has one definition and one caller", () => {
  it("only the loader module and the ad-spend actions name the report RPCs", () => {
    const offenders = walk(join(ROOT, "src"))
      .map(rel)
      .filter((f) => !(f in CALLERS) && !f.endsWith(".test.ts"))
      .filter((f) => {
        const src = readFileSync(join(ROOT, f), "utf8");
        return RPCS.some((r) => src.includes(`"${r}"`) || src.includes(`'${r}'`));
      });
    expect(offenders).toEqual([]);
  });
  it("every summary surface reads through the shared loader", () => {
    for (const [file, loader] of Object.entries(SURFACES)) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, file).toContain("@/lib/marketing/patient-sources.server");
      expect(src, file).toContain(`${loader}(`);
    }
  });
  it("guards itself: the loader really calls the summary RPC", () => {
    expect(readFileSync(join(ROOT, "src/lib/marketing/patient-sources.server.ts"), "utf8")).toContain('"patient_sources_summary"');
  });
});
```
- [ ] **Step 2: Run** → PASS. **Control:** temporarily add `supabase.rpc("patient_sources_summary"` in a comment to `marketing/sources/page.tsx` → test 1 FAILS; revert.
- [ ] **Step 3: Commit** — `git add src/lib/marketing/patient-sources-surfaces.test.ts && git commit -m "test(marketing): pin Patient Sources to one loader across its four surfaces"`

# Phase D — docs, verification, reviews, ship

### Task 18: Docs

**Files:** `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `.claude/skills/drmed-migrations/SKILL.md`, `docs/superpowers/specs/2026-09-28-patient-sources-pr2-design.md`

- [ ] **User guide** (every label must match the code — the guide says it was checked):
  - §5.8 "Books, payroll and marketing (orientation)" paragraph (≈ line 1164): Marketing now has **four** tabs. Rewrite the Booking Sources sentence (appointments and website messages; the **New patients** card shows "N confirmed · M unconfirmed", the same count as Patient Sources, and links to it; the "by how they heard about us" table moved to Patient Sources). Add a Patient Sources paragraph: what New / Returning, first time in our records / All customers served mean; confirmed vs unconfirmed; Day/Week/Month and the presets incl. Custom (≤ 400 days); the paused-sync banner; the undated footnote; cost per new patient (daily exports only; Meta ↔ Facebook, Google ↔ Google; remove saved spend); channel revenue "billed (clinic share)" + Possible double entry; top referring doctors; people list and both CSVs (audited); the restatement sentence.
  - Ad Performance sentence: the upload is also saved to the clinic's records ("Saved to clinic records: N days, M rows rejected"), needs a 1-day breakdown.
  - The New visit section: the optional "How did you hear about us?" select appears only when the patient has no source.
  - Admin dashboard section: the "New patients today" card.
  - Glossary: add "Confirmed / unconfirmed (Patient Sources)" and "Returning, first time in our records"; update the "Referral source" entry's cross-reference to Patient Sources.
  - Bump the TOC tag (line ≈ 250) and footer (≈ 1330) to **v2.37**, the merge date, "at migration 0189" (keep the existing out-of-order list).
- [ ] **CLAUDE.md:** guide version line → v2.37; migration ledger: add 0189 (`patient_sources`) in the same style once applied (Task 21 fills the date); "Where things live" row: `Patient Sources (Marketing): SQL counting in 0189 (admin-gated report functions over an identity core); the one RPC caller src/lib/marketing/patient-sources.server.ts; pure helpers patient-sources.ts, period.ts, ad-spend-import.ts; pages marketing/patients(/people); CSVs /api/admin/reports/patient-sources*.csv`.
- [ ] **drmed-staff-ui skill:** `grep -n "period-chips\|Booking Sources\|marketing" .claude/skills/drmed-staff-ui/SKILL.md` — point any `period-chips` citation at `marketing/_components/period-controls.tsx`; add the Patient Sources tab and the `admin.new_patients_today` card.
- [ ] **drmed-migrations skill:** add a 0189 line (additive; report functions `security definer` + `has_role(array['admin'])` gate + `#variable_conflict use_column`; helpers revoked from every role; `ad_spend_daily` writes only via RPC).
- [ ] **Spec:** append "§8 Planning refinements (2026-09-28)" with P1–P17, one line each.
- [ ] Commit — `git commit -am "docs(patient-sources): user guide v2.37, CLAUDE.md, skills, spec refinements"`

### Task 19: End-to-end verification on the local stack

- [ ] **Step 1: Full replay.** Check the stack is not in use by another session (Task 1 Step 2). `supabase db reset` from this worktree → all migrations apply, including 0189's post-conditions. Then `npm run patient-sources:db-proof` → all PASS; `npm run sheet-sync:db-proof` → all PASS (0189 must not disturb PR 1).
- [ ] **Step 2: Gate.** `npm test && npm run typecheck && npm run lint && npm run build` (capture to the scratchpad, read only failures). `build` needs Supabase env (memory: main's `/all-services` prerender) — use the local stack's env, never the main checkout's `.env.local` (it points at PROD).
- [ ] **Step 3: Seed a realistic local picture.** With the sync still paused, unpause locally and run the real sheet into the local DB (`npm run sheet:sync -- --commit --confirm=local` after the PR 1 env setup in memory `drmed-sheet-sync`), so the mirror holds ~21k lab / ~9k consult lines. Time `select count(*) from public._patient_sources_identities()` as postgres with `\timing` — **must be < 2 s**; the page makes ten report calls in parallel. If slower, profile (`explain (analyze, buffers)`) and fix before continuing (likely an index on `patients (merged_into_id)` already exists from 0025; check `sheet_customer_rows (patient_id)` / `(loose_key)` usage).
- [ ] **Step 4: Browser pass** (Playwright MCP, text-first; sign in as admin on port 4000 per CLAUDE.md, or the cookie-injection recipe): Patient Sources renders with the banner state right; every preset and Custom keep `mode`/`grain`; Day/Week/Month and New/Served toggle; a channel link opens the people list and pages; both CSVs download (check the audit rows with psql: `report.patient_sources.exported`, `report.patient_sources_people.exported`, `patient_sources.viewed`); Booking Sources card equals Patient Sources' New card for the same period; the dashboard tile's total equals Patient Sources for Today; upload a small Meta daily CSV on Ad Performance → "Saved to clinic records: …" and the cost card fills; upload a range export → rejected count shown; remove saved spend (two-step confirm); on a new visit for a patient with no source, pick a channel → the patient's `referral_source_origin` is `staff` and a `patient.referral_source_recorded` audit row exists; a patient WITH a source shows no prompt; as an admin in View-as reception, Patient Sources is not reachable. `browser_console_messages` clean. At most one screenshot (the Patient Sources page).
- [ ] **Step 5:** Fix anything found — each fix its own commit.

### Task 20: Reviews — Sonnet code review, then Codex

- [ ] **Step 1: Sonnet review.** Dispatch `Agent` (`model: "sonnet"`, subagent_type `superpowers:code-reviewer`) with the spec path, this plan path, `git diff origin/main...HEAD`, and the focus list: counting rules vs spec §1 (merged survivors, deleted survivors, first encounter over full history, suppression, Returning, undated, name-identity channel); security (every report function gated first thing, helpers unreachable from JWT roles, View-as refusal, CSV/people audit rows carry no names, `ad_spend_import` all-or-nothing); PostgREST caps (every multi-row read paged); Manila dates; date-render and plain-language rules; A′ (no merged number anywhere). Findings with severity + file:line + failure scenario.
- [ ] **Step 2: Codex review.** `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, invoke the `codex-review` skill (astra, high) on the branch diff. Never pipe it; open the report and confirm `Status: Completed` and real content (CLAUDE.md).
- [ ] **Step 3:** Triage with `superpowers:receiving-code-review`; fix real findings matching existing patterns (user rule 4); re-run Task 19 Steps 1–2 and the relevant Step 4 checks. Record a "PR 2 review log" table in the spec.

### Task 21: Push, PR, apply 0189, merge

Order: migration on prod **before** the merge (CLAUDE.md). 0189 is additive (new functions, one new table), so pushing it early cannot break the live app.

- [ ] **Step 1: Re-check the number and main.** `git fetch origin && git merge origin/main`; `npm run claim -- list` shows 0189 as ours; the open-branch scan from memory `drmed-migration-number-collision` shows no other 0189. Re-run the Task 19 Step 2 gate. If main moved the guide version, bump to the next one.
- [ ] **Step 2: Ask the user once** before the outward steps: push the branch (public repo — the diff holds no personal data; the proof uses invented `Zzproof*` names), open the PR, `supabase db push` 0189 to prod, merge. Then proceed.
- [ ] **Step 3: Push + PR** (`gh`, PATH fix first). Body: what it does in plain words; P1–P17; the A′ change on Booking Sources; the reception prompt; the ad-spend contract ("daily exports only"); verification evidence (test counts, proof N/N PASS, six controls, identity-core timing, browser pass, review outcomes); post-merge checklist. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Mark ready immediately (memory: ready-for-review cancel trap).
- [ ] **Step 4: Apply 0189 to prod** (owner-authorised Claude pushes, memory `feedback-drmed-apply-migrations-yourself`). From this worktree on current main with `supabase/.temp/{project-ref,linked-project.json,pooler-url}` copied in: `supabase db push --dry-run` must list **only** 0189 (add `--include-all` only if the dry run says a lower number is missing and it is 0184's known gap — then it must still list only 0189). `supabase db push`. **Verify by object** (MCP `execute_sql`, read-only): ledger has `0189`; `to_regclass('public.ad_spend_daily')` not null with RLS on; `has_function_privilege('anon','public.patient_sources_summary(date,date)','execute')` = false and `'authenticated'` = true; `has_function_privilege('authenticated','public._patient_sources_identities()','execute')` = false. Timing on prod data (counts only, no names): `explain (analyze) select count(*) from public._patient_sources_identities()` → record the time.
- [ ] **Step 5: Merge**, then confirm the Vercel production deploy is READY (merge ≠ deploy). Smoke on prod as admin (Playwright on the deployed URL if authable, else ask the user to open it): Patient Sources shows the paused banner and app-only numbers; Booking Sources' card matches it.
- [ ] **Step 6: Wrap-up** per CLAUDE.md: plain-English summary, next step (owner decides the sync unpause; then PR 3 small tabs), context-hygiene check. Update memory `drmed-sheet-sync` (PR 2 merged, 0189 on prod, P-decisions worth keeping) and its `MEMORY.md` line; update CLAUDE.md's ledger paragraph with the applied date.

---

## Self-review (done while writing)

- **Spec coverage.** §0 S1–S4: whole scope in one PR (all tasks), A′ card + table removed (T10), #244 card replaced (T10), no `/register` change (only T16). §1.1 survivors/deleted/facts group rule (T2, proof 5–8). §1.2 encounters, converted raise, 2023-12-01 floor (T2, proof 14, 18). §1.3 whole-history first encounter, Returning, registration fallbacks, undated, suppression, restatement note (T2, T12, proof 7–12). §1.4 served once (T3, proof 5). §1.5 channel (T2, proof 13). §1.6 revenue + overlaps + label (T2–T3, T12, proof 5, 14). §1.7 five functions + gate + grants + bucket rules (T3–T4, proof 1, 16, 19). §2.1 table (T4). §2.2 parser + RPC + audit + delete (T4, T8, T12, T14, proof 21). §2.3 upload note + cost card (T12, T14). §3.1 shared controls with presets/custom/param-keeping (T6, T10). §3.2 page order 1–9 (T12). §3.3 people + audit (T13). §3.4 two CSVs (T13, P12). §3.5 Booking Sources (T10). §3.6 tile (T15). §3.7 reception prompt (T16). §3.8 wiring: route names/tabs (T11), mirror-readers (T4), guide/glossary (T18), staff-ui skill (T18). §4 errors (T7 classifier, T12). §5 tests: TS units (T6–T8, T15–T16), proof incl. >1,000 rows and the access matrix on .167 (T1, T5), equality (T17 + proof 16), repo gates (T19). §6 deploy (T21). §7 out-of-scope stays out.
- **Placeholders.** None left as TBD. Three spots tell the implementer to confirm a path/helper name against the repo before use (`formatPeso` import path, the staff patient page URL, `services` NOT NULL columns) — each names the exact grep.
- **Type consistency.** `SeriesRow`/`SummaryRow`/`PeopleRow`/`ReportResult` (T7) are what the loaders return (T9) and the pages consume (T12–T15). `AdSpendSaveResult` is defined in T8 and returned by `saveAdSpendAction` (T14). `PeopleQuery.mode` = `new | returning | served` matches `patient_sources_people`'s check (T3). Grain `'period'` is accepted by the SQL (T3) and by `loadPatientSourcesSeries` (T9) but never by `parseGrain` (T7), so the URL cannot select it.
