# Corrected-result follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Help the clinic act on a corrected result. Reception and admin get a list of patients holding an out-of-date copy, staff can opt in to notify the patient, stale printouts are flagged, staff can see what changed, and withdrawn critical alerts are kept as history.

**Architecture:** One migration, **0179** (claimed), adds follow-up columns to `result_amendments`, withdrawal columns to `critical_alerts`, and a set of SECURITY DEFINER RPCs built on one internal copy-state function. It also redefines `result_edit_commit` by applying three text hunks to the 0176 body, pinned by a test. The TypeScript side adds pure logic modules, with unit tests, plus thin server loaders. The UI wires those into existing pages following the house patterns.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before writing a page — `searchParams`/`params` are Promises), Supabase Postgres 17, vitest, Resend (email) + Semaphore (SMS) via `src/lib/notifications/{email,sms}.ts`.

**Spec:** `docs/superpowers/specs/2026-09-25-result-copy-followups-design.md` (Task 0 records small refinements).

**Claimed numbers:** migration **0179**, P-code **P0068** (both claimed 2026-09-25 with `npm run claim`). Do not claim or use any other number without running `npm run -s claim -- …` first.

**Worktree:** `/Users/jamila/Claude/DRMed/.worktrees/result-copy-followups`, branch `feat/result-copy-followups`. Run every command from there.

---

## Ground rules for every task

- Read `CLAUDE.md` (the worktree copy) once before starting. It is binding. Key rules:
  - Every `test_requests`/`visits` read filters `deleted_at is null`.
  - Manila date helpers only.
  - Server Actions return `{ ok, data } | { ok, error }`.
  - Every staff write is audited.
  - Never import the admin client from a client component.
- Skills to consult when a task touches their area: `drmed-result-templates` (results, edit path, print), `drmed-staff-ui` (nav, dashboard cards, page headers), `drmed-rls-and-auth` (grants, audit, portal), `drmed-migrations` (migration checklist).
- **Never copy `.env.local`** (prod) into the worktree.
- The local Supabase stack is **shared** with other sessions, and they reset it. If an object you applied disappears, re-apply 0179 (Task 4 step 1).
- Run `npx vitest run <file>` for single tests. Run `npm test && npm run typecheck && npm run lint` before each commit that touches TS.
- Commit messages: Conventional Commits, ending with the line
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/0179_result_copy_followups.sql` | create | Columns, indexes, redefined `result_edit_commit`, 6 functions + grants |
| `src/lib/results/edit-commit-0179-hunks.ts` | create | The 3 text hunks + `extractFunction` / `applyHunks` (pure) |
| `src/lib/results/result-copy-followups-migration.test.ts` | create | Pins 0179 function text + ACLs |
| `scripts/smoke/result-copy-followups.sql` | create | Local SQL smoke: grants, withdrawal, re-page, notify once, P0068 |
| `scripts/smoke/result-edit-followups.sql` | modify | Its alert assertion now expects a withdrawn row, not a deleted one |
| `src/lib/accounting/pg-errors.ts` | modify | P0068 translation |
| `src/lib/results/copy-followups.ts` (+ `.test.ts`) | create | Pure: types, `shouldOfferNotify`, `followUpStatusLabel`, `copyKindLabel`, `outdatedCopyChip` |
| `src/lib/results/copy-followups.server.ts` | create | `fetchCopyStates`, `fetchCopyStateAdmin`, `fetchOutdatedCopies` |
| `src/lib/actions/results/result-edit-core.ts` (+ test) | modify | Return `amendmentId` |
| `src/lib/notifications/corrected-result-message.ts` (+ `.test.ts`) | create | Pure email/SMS copy for "updated copy ready" |
| `src/lib/notifications/notify-corrected.ts` | create | Claim → send → record → audit (server-only) |
| `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts` | modify | Both single-test edit actions honour `notify_patient` |
| `src/lib/actions/results/amend-consolidated.ts` + consolidated `actions.ts` | modify | Consolidated edit honours `notifyPatient` |
| `queue/[id]/amend-form.tsx`, `queue/[id]/structured-form.tsx`, `queue/consolidated/[visitId]/[groupId]/report-edit-form.tsx` | modify | Checkbox + outcome message |
| `src/components/staff/notify-patient-checkbox.tsx` | create | Shared checkbox UI |
| `src/app/(staff)/staff/(dashboard)/result-follow-ups/{page.tsx,actions.ts,mark-contacted-button.tsx}` | create | The follow-up list |
| `src/components/staff/staff-nav-config.ts` + the `ROUTE_NAME` map | modify | Nav entry (reception + admin) |
| `src/lib/dashboards/cards.ts`, `_dashboards/{reception,admin,lab}-dashboard.tsx` | modify | Follow-ups cards + lab "Updated (last 7 days)" card |
| `visits/[id]/page.tsx` | modify | Outdated-copy chip + stale-print warning |
| `src/lib/results/print-summary.ts` (+ test), `print-history.ts`, `src/components/staff/stale-print-warning.tsx` | modify/create | Stale-print detection + warning |
| `queue/page.tsx` | modify | Stale-print warning on Released today |
| `src/lib/results/version-diff.ts` (+ test), `version-diff.server.ts`, `src/components/staff/result-changes.tsx` | create | "What changed" |
| `queue/[id]/page.tsx`, `queue/consolidated/[visitId]/[groupId]/{page.tsx,report-cards.tsx}` | modify | Render What changed; gate View PDF by every member |
| `critical-alerts/{page.tsx,actions.ts}`, `_dashboards/lab-dashboard.tsx` | modify | Active = not withdrawn; Withdrawn section |
| `src/lib/results/updated-filter.ts` (+ test), `results/page.tsx` | create/modify | Archive "Updated" filters, stale-print chip, every-member PDF link |
| `src/lib/results/report-section-gate.ts` | modify | Batch `resultsMemberSections` |
| `src/lib/audit/presets.ts` | modify | Two quick filters |
| `src/lib/portal/export-audit.ts` (+ test) | modify | System-code allowlist |
| `src/types/database.ts` | modify | Spliced types for 0179 only |
| `.claude/skills/drmed-result-templates/SKILL.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `docs/drmed-user-guide.html`, `CLAUDE.md` | modify | Docs |

---

### Task 0: Worktree setup + spec refinements

**Files:** `.env.development.local` (worktree, untracked), `docs/superpowers/specs/2026-09-25-result-copy-followups-design.md`

- [ ] **Step 1: Install and env**

```bash
cd /Users/jamila/Claude/DRMed/.worktrees/result-copy-followups
npm ci > /tmp/rcf-npm-ci.log 2>&1; tail -2 /tmp/rcf-npm-ci.log
cp /Users/jamila/Claude/DRMed/.env.development.local .env.development.local
printf '\nPATIENT_SESSION_SECRET=%s\n' "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" >> .env.development.local
printf 'SUPABASE_JWT_SECRET=%s\n' "$(docker exec supabase_auth_DRMed printenv GOTRUE_JWT_SECRET)" >> .env.development.local
grep -c CONSULTANT_ .env.development.local   # expect >= 1; if 0, copy the CONSULTANT_*_STAFF_ID lines from main's file
```

- [ ] **Step 2: Record the refinements in the spec.** Edit the spec so it matches this plan:
  - §Definitions "printed copy": count only `result.printed_staff` rows whose `metadata.role` is `reception` or `admin`. Those are the roles that hand paper to patients; lab prints are internal. Out of date = the highest printed `amendment_count` < the result's current `amendment_count`.
  - §1 table: drop `patient_notify_requested`. The claim RPC stamps `patient_notified_at` directly, so `result_edit_commit` keeps its signature. The claim returns a row only the first time.
  - §1 RPCs: add `result_copy_states_internal(uuid[])` (service_role) and `result_copy_state(uuid[])` (staff, per-row gate). The list RPC returns `notify_failed boolean`, not the error text.
  - §2: the route is `/staff/result-follow-ups`, labelled "Result follow-ups".
  - §4: the Results archive has no Print button, so it gets a "Printed copy out of date" chip in its Updated column instead.
  - §7: "Updated this week" becomes **"Updated · last 7 days"** (a rolling 7×24h window on a timestamptz, which is timezone-safe per CLAUDE.md).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-25-result-copy-followups-design.md
git commit -m "docs(spec): record plan refinements for result follow-ups

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Hunk module for the `result_edit_commit` redefinition (TDD)

**Files:**
- Create: `src/lib/results/edit-commit-0179-hunks.ts`
- Create: `src/lib/results/result-copy-followups-migration.test.ts` (first half; Task 3 extends it)

- [ ] **Step 1: Write the hunk module**

```ts
// The 0179 redefinition of result_edit_commit is 0176's body plus exactly these
// text hunks — generated, never hand-copied, so the rest of the function
// cannot drift. result-copy-followups-migration.test.ts pins
// applyHunks(0176) === 0179. Pure: no server-only, no IO.

export interface Hunk {
  label: string;
  from: string;
  to: string;
}

const lines = (...l: string[]) => l.join("\n");

export const EDIT_COMMIT_0179_HUNKS: readonly Hunk[] = [
  {
    label: "a withdrawn alert is not a live match, so a value corrected back to it pages again",
    from: lines(
      "            and ca.observed_value_si is not distinct from d.observed_value_si",
      "       )",
      "      returning parameter_name, direction, observed_value_si, threshold_si",
    ),
    to: lines(
      "            and ca.observed_value_si is not distinct from d.observed_value_si",
      "            -- 0179: a withdrawn alert is history, not a live match — a value",
      "            -- corrected back to it pages again.",
      "            and ca.withdrawn_at is null",
      "       )",
      "      returning parameter_name, direction, observed_value_si, threshold_si",
    ),
  },
  {
    label: "removed alerts are withdrawn (kept as history), never deleted",
    from: lines(
      "    with gone as (",
      "      delete from public.critical_alerts ca",
      "       where ca.result_id = p_result_id",
      "         and ca.acknowledged_at is null",
    ),
    to: lines(
      "    -- 0179: a removed alert is WITHDRAWN (kept as history), never deleted.",
      "    with gone as (",
      "      update public.critical_alerts ca",
      "         set withdrawn_at = now(),",
      "             withdrawn_by = p_editor,",
      "             withdrawn_by_amendment = v_amend_id",
      "       where ca.result_id = p_result_id",
      "         and ca.acknowledged_at is null",
      "         and ca.withdrawn_at is null",
    ),
  },
  {
    label: "kept-acknowledged count ignores withdrawn rows",
    from: lines(
      "     where result_id = p_result_id",
      "       and acknowledged_at is not null;",
    ),
    to: lines(
      "     where result_id = p_result_id",
      "       and acknowledged_at is not null",
      "       and withdrawn_at is null; -- 0179",
    ),
  },
];

/** The `create or replace function public.<name>(` … `$$;` block, verbatim. */
export function extractFunction(sql: string, name: string): string {
  const head = `create or replace function public.${name}(`;
  const start = sql.indexOf(head);
  if (start < 0) throw new Error(`${name} not found`);
  const end = sql.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`${name} has no closing $$;`);
  return sql.slice(start, end + "\n$$;".length);
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/** Apply each hunk; every `from` must occur exactly once. */
export function applyHunks(body: string, hunks: readonly Hunk[]): string {
  let out = body;
  for (const h of hunks) {
    const n = count(out, h.from);
    if (n !== 1) throw new Error(`hunk "${h.label}" matched ${n} times (want 1)`);
    out = out.replace(h.from, h.to);
  }
  return out;
}
```

- [ ] **Step 2: Write the pin test (the 0179 half fails until Task 2)**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EDIT_COMMIT_0179_HUNKS,
  applyHunks,
  extractFunction,
} from "./edit-commit-0179-hunks";

const read = (f: string) => readFileSync(`supabase/migrations/${f}`, "utf8");
const M0176 = read("0176_result_patient_download_and_remarks.sql");
const M0179 = () => read("0179_result_copy_followups.sql");

describe("0179 result_edit_commit = 0176 + the marked hunks", () => {
  it("every hunk matches 0176's function exactly once", () => {
    expect(() =>
      applyHunks(extractFunction(M0176, "result_edit_commit"), EDIT_COMMIT_0179_HUNKS),
    ).not.toThrow();
  });

  it("0179 redefines the function as exactly the hunked 0176 text", () => {
    const expected = applyHunks(
      extractFunction(M0176, "result_edit_commit"),
      EDIT_COMMIT_0179_HUNKS,
    );
    expect(extractFunction(M0179(), "result_edit_commit")).toBe(expected);
  });

  it("0179 no longer deletes critical alerts in the edit", () => {
    const fn = extractFunction(M0179(), "result_edit_commit");
    expect(fn).not.toMatch(/delete\s+from\s+public\.critical_alerts/i);
    expect(fn).toMatch(/withdrawn_by_amendment\s*=\s*v_amend_id/);
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run src/lib/results/result-copy-followups-migration.test.ts`. Expected: test 1 PASSES; tests 2–3 FAIL with ENOENT (no 0179 yet). If test 1 fails with "matched 0 times", the whitespace in a `from` differs from 0176. Inspect the file with `sed -n 423,480p supabase/migrations/0176_result_patient_download_and_remarks.sql | cat -A` and fix the `from`/`to` strings. Never touch 0176.

- [ ] **Step 4: Commit** (`feat(results): hunk module for the 0179 edit-commit redefinition`).

---

### Task 2: Migration 0179, part 1 (columns, indexes, redefined `result_edit_commit`)

**Files:** Create `supabase/migrations/0179_result_copy_followups.sql`.

- [ ] **Step 1: Generate the function text**

```bash
npx tsx -e '
import { readFileSync } from "node:fs";
import { EDIT_COMMIT_0179_HUNKS, applyHunks, extractFunction } from "./src/lib/results/edit-commit-0179-hunks";
const sql = readFileSync("supabase/migrations/0176_result_patient_download_and_remarks.sql","utf8");
process.stdout.write(applyHunks(extractFunction(sql,"result_edit_commit"), EDIT_COMMIT_0179_HUNKS));
' > /tmp/rcf-edit-commit.sql && wc -l /tmp/rcf-edit-commit.sql
```

- [ ] **Step 2: Write the migration head.** Paste `/tmp/rcf-edit-commit.sql` **byte-for-byte** where marked. Do not re-indent it.

```sql
-- 0179 — Corrected-result follow-ups (spec 2026-09-25-result-copy-followups-design.md)
--
-- 1. result_amendments carries the patient follow-up for each correction:
--    contacted by staff, or notified (email/SMS) once, on the editor's opt-in.
-- 2. critical_alerts keeps history: a correction WITHDRAWS an unacknowledged
--    alert it removed (withdrawn_at/by/by_amendment) instead of deleting it.
--    result_edit_commit is 0176's body plus three "-- 0179" hunks, generated
--    from 0176 (src/lib/results/edit-commit-0179-hunks.ts) and pinned by
--    result-copy-followups-migration.test.ts. The FINALISE path's cleanup of
--    pre-0172 leftovers (result_finalise_commit) stays a delete: it is not a
--    correction.
-- 3. One internal copy-state function and five wrappers: which patients hold an
--    out-of-date copy (portal download or a reception/admin print), for
--    reception + admin, never with reasons or values.

-- 1) Follow-up state per correction ------------------------------------------
alter table public.result_amendments
  add column patient_contacted_at      timestamptz,
  add column patient_contacted_by      uuid references auth.users(id),
  add column patient_notified_at       timestamptz,
  add column patient_notified_channels text[],
  add column patient_notify_error      text;

comment on column public.result_amendments.patient_contacted_at is
  'Reception/admin marked the patient contacted about THIS correction (result_mark_copy_contacted).';
comment on column public.result_amendments.patient_notified_at is
  'Send claim for the opt-in "updated copy ready" notice — set once by result_claim_patient_notify; never cleared, so nothing re-sends.';
comment on column public.result_amendments.patient_notify_error is
  'Why the notice did not go out (provider error / skipped). Clinic-only; the follow-up list shows only "Send failed".';

-- 2) Withdrawn critical alerts ------------------------------------------------
alter table public.critical_alerts
  add column withdrawn_at           timestamptz,
  add column withdrawn_by           uuid references auth.users(id),
  add column withdrawn_by_amendment uuid references public.result_amendments(id) on delete set null;

drop index if exists public.idx_critical_alerts_unacked;
create index idx_critical_alerts_unacked
  on public.critical_alerts(created_at desc)
  where acknowledged_at is null and withdrawn_at is null;
create index idx_critical_alerts_withdrawn
  on public.critical_alerts(withdrawn_at desc)
  where withdrawn_at is not null;

-- 3) Print lookups by result (the follow-up list reads these) ---------------
create index if not exists idx_audit_log_result_printed
  on public.audit_log ((metadata->>'result_id'))
  where action = 'result.printed_staff';

-- 4) result_edit_commit — 0176 + the three 0179 hunks (generated) ------------
<<< paste /tmp/rcf-edit-commit.sql here, then a blank line >>>
revoke all on function public.result_edit_commit(
  uuid, uuid, int, uuid, text, uuid, text, int, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.result_edit_commit(
  uuid, uuid, int, uuid, text, uuid, text, int, jsonb, jsonb, jsonb
) to service_role;
```

- [ ] **Step 3: Run the pin test.** Expected: all 3 PASS. (Task 3 adds the ACL tests.)
- [ ] **Step 4: Commit** (`feat(db): 0179 part 1 — follow-up columns, withdrawn alerts, edit-commit hunks`).

---

### Task 3: Migration 0179, part 2 (copy-state functions + grants + P0068)

**Files:** Modify `supabase/migrations/0179_result_copy_followups.sql`, `src/lib/results/result-copy-followups-migration.test.ts`, `src/lib/accounting/pg-errors.ts`.

Before writing, verify three names with a `grep` in `supabase/migrations` and adjust the SQL if one differs:
- the columns `patients.first_name` / `last_name` / `drm_id` / `email` / `phone`
- `services.name`, `test_requests.service_id`
- `staff_profiles.full_name`
- the type of `audit_log.resource_id` (if it is `text`, cast `v_am.test_request_id::text`)

- [ ] **Step 1: Write the failing ACL tests** (append to the test file):

```ts
const SERVICE_ONLY = [
  "result_copy_states_internal",
  "result_claim_patient_notify",
  "result_record_patient_notify",
];
const STAFF_CALLABLE = [
  "result_copy_state",
  "result_outdated_copies",
  "result_mark_copy_contacted",
];

describe("0179 function ACLs", () => {
  const sql = () => M0179();
  it.each(SERVICE_ONLY)("%s is service_role only", (fn) => {
    expect(sql()).toMatch(
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated;`),
    );
    expect(sql()).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role;`));
    expect(sql()).not.toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to [^;]*authenticated`));
  });
  it.each(STAFF_CALLABLE)("%s is callable by signed-in staff only", (fn) => {
    expect(sql()).toMatch(
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon;`),
    );
    expect(sql()).toMatch(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to authenticated, service_role;`),
    );
  });
  it("reception/admin-only functions check the role and raise 42501", () => {
    for (const fn of ["result_outdated_copies", "result_mark_copy_contacted"]) {
      const body = extractFunction(sql(), fn);
      expect(body).toMatch(/v_role not in \('reception', 'admin'\)/);
      expect(body).toMatch(/errcode = '42501'/);
    }
  });
  it("the list never selects a reason, a value snapshot or the notify error text", () => {
    const body = extractFunction(sql(), "result_outdated_copies");
    expect(body).not.toMatch(/\breason\b|prior_values|notify_error\s*[,)]/);
  });
});
```

Run it. Expected: the new tests FAIL (the functions are not written yet).

- [ ] **Step 2: Append the functions to 0179**

```sql
-- 5) Copy state ---------------------------------------------------------------
-- One row per result: does the patient hold a copy, is it out of date, and has
-- the latest correction been followed up. p_result_ids null = every corrected
-- result. A "printed copy" is a result.printed_staff row stamped by reception or
-- admin (the roles that hand paper over); lab prints are internal. Service role
-- only — the wrappers below decide who sees which rows and columns.
create or replace function public.result_copy_states_internal(p_result_ids uuid[])
returns table (
  result_id                 uuid,
  anchor_test_request_id    uuid,
  visit_id                  uuid,
  patient_id                uuid,
  amendment_count           int,
  amended_at                timestamptz,
  latest_amendment_id       uuid,
  portal_downloaded_at      timestamptz,
  last_handover_print_count int,
  holds_copy                boolean,
  portal_outdated           boolean,
  printed_outdated          boolean,
  contacted_at              timestamptz,
  contacted_by              uuid,
  notified_at               timestamptz,
  notified_channels         text[],
  notify_error              text,
  followed_up               boolean,
  has_email                 boolean,
  has_phone                 boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select res.id, res.test_request_id, res.amendment_count, res.amended_at,
           res.patient_last_downloaded_at
      from public.results res
     where case when p_result_ids is null then res.amendment_count > 0
                else res.id = any(p_result_ids) end
  ),
  prints as (
    select (a.metadata->>'result_id')::uuid as result_id,
           max((a.metadata->>'amendment_count')::int) as last_count
      from public.audit_log a
     where a.action = 'result.printed_staff'
       and a.metadata->>'result_id' in (select r.id::text from r)
       and a.metadata->>'role' in ('reception', 'admin')
       and a.metadata->>'amendment_count' ~ '^[0-9]+$'
     group by 1
  )
  select r.id,
         anchor.test_request_id,
         anchor.visit_id,
         v.patient_id,
         r.amendment_count,
         r.amended_at,
         la.id,
         r.patient_last_downloaded_at,
         p.last_count,
         (r.patient_last_downloaded_at is not null or p.last_count is not null),
         (r.amendment_count > 0
            and r.patient_last_downloaded_at is not null
            and r.patient_last_downloaded_at < r.amended_at),
         (r.amendment_count > 0 and p.last_count is not null and p.last_count < r.amendment_count),
         la.patient_contacted_at,
         la.patient_contacted_by,
         la.patient_notified_at,
         la.patient_notified_channels,
         la.patient_notify_error,
         (la.patient_contacted_at is not null
            or (la.patient_notified_at is not null
                and coalesce(cardinality(la.patient_notified_channels), 0) > 0
                and la.patient_notify_error is null)),
         nullif(btrim(pt.email), '') is not null,
         nullif(btrim(pt.phone), '') is not null
    from r
    left join lateral (
      select tr.id as test_request_id, tr.visit_id
        from public.test_requests tr
       where tr.id = coalesce(
               (select rtr.test_request_id
                  from public.result_test_requests rtr
                 where rtr.result_id = r.id
                 order by rtr.test_request_id
                 limit 1),
               r.test_request_id)
    ) anchor on true
    left join public.visits v    on v.id = anchor.visit_id
    left join public.patients pt on pt.id = v.patient_id
    left join lateral (
      select ra.*
        from public.result_amendments ra
       where ra.result_id = r.id
         and ra.amendment_seq = r.amendment_count
    ) la on true
    left join prints p on p.result_id = r.id;
$$;
revoke all on function public.result_copy_states_internal(uuid[]) from public, anon, authenticated;
grant execute on function public.result_copy_states_internal(uuid[]) to service_role;

-- Per-result copy state for staff pages (visit chip, edit-form checkbox).
-- Reception/admin see every row; lab roles only results they may read
-- (staff_can_read_finished_result). No reasons, no values, no error text.
create or replace function public.result_copy_state(p_result_ids uuid[])
returns table (
  result_id           uuid,
  latest_amendment_id uuid,
  amendment_count     int,
  amended_at          timestamptz,
  holds_copy          boolean,
  portal_outdated     boolean,
  printed_outdated    boolean,
  followed_up         boolean,
  notified_at         timestamptz,
  notify_failed       boolean,
  has_email           boolean,
  has_phone           boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.staff_role();
begin
  if v_role is null then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if p_result_ids is null or cardinality(p_result_ids) > 200 then
    raise exception 'pass up to 200 result ids' using errcode = '22023';
  end if;
  return query
    select s.result_id, s.latest_amendment_id, s.amendment_count, s.amended_at,
           s.holds_copy, s.portal_outdated, s.printed_outdated, s.followed_up,
           s.notified_at, (s.notify_error is not null), s.has_email, s.has_phone
      from public.result_copy_states_internal(p_result_ids) s
     where v_role in ('reception', 'admin')
        or public.staff_can_read_finished_result(s.result_id);
end;
$$;
revoke all on function public.result_copy_state(uuid[]) from public, anon;
grant execute on function public.result_copy_state(uuid[]) to authenticated, service_role;

-- The follow-up list: patients holding an out-of-date copy of a corrected
-- result whose latest correction is not followed up. Reception + admin only.
create or replace function public.result_outdated_copies(p_include_followed_up boolean default false)
returns table (
  result_id           uuid,
  latest_amendment_id uuid,
  amendment_count     int,
  amended_at          timestamptz,
  visit_id            uuid,
  patient_id          uuid,
  patient_name        text,
  drm_id              text,
  phone               text,
  has_email           boolean,
  test_names          text,
  portal_outdated     boolean,
  printed_outdated    boolean,
  followed_up         boolean,
  contacted_at        timestamptz,
  contacted_by_name   text,
  notified_at         timestamptz,
  notified_channels   text[],
  notify_failed       boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.staff_role();
begin
  if v_role is null or v_role not in ('reception', 'admin') then
    raise exception 'reception or admin only' using errcode = '42501';
  end if;
  return query
    select s.result_id, s.latest_amendment_id, s.amendment_count, s.amended_at,
           s.visit_id, s.patient_id,
           nullif(btrim(concat_ws(' ', pt.first_name, pt.last_name)), ''),
           pt.drm_id, pt.phone, s.has_email,
           (select string_agg(x.name, ', ' order by x.name)
              from (select distinct sv.name
                      from public.result_test_requests rtr
                      join public.test_requests tr
                        on tr.id = rtr.test_request_id and tr.deleted_at is null
                      join public.services sv on sv.id = tr.service_id
                     where rtr.result_id = s.result_id) x),
           s.portal_outdated, s.printed_outdated, s.followed_up,
           s.contacted_at, sp.full_name, s.notified_at, s.notified_channels,
           (s.notify_error is not null)
      from public.result_copy_states_internal(null) s
      join public.visits v on v.id = s.visit_id and v.deleted_at is null
      left join public.patients pt       on pt.id = s.patient_id
      left join public.staff_profiles sp on sp.id = s.contacted_by
     where (s.portal_outdated or s.printed_outdated)
       and (p_include_followed_up or not s.followed_up)
     order by s.amended_at desc, s.result_id;
end;
$$;
revoke all on function public.result_outdated_copies(boolean) from public, anon;
grant execute on function public.result_outdated_copies(boolean) to authenticated, service_role;

-- Mark the patient contacted about a correction. Only the result's LATEST
-- correction can be marked (P0068 otherwise: it was corrected again since the
-- list loaded). Idempotent. Audited in the same transaction.
create or replace function public.result_mark_copy_contacted(p_amendment_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role    text := public.staff_role();
  v_am      public.result_amendments%rowtype;
  v_count   int;
  v_patient uuid;
begin
  if v_role is null or v_role not in ('reception', 'admin') then
    raise exception 'reception or admin only' using errcode = '42501';
  end if;
  select * into v_am from public.result_amendments where id = p_amendment_id for update;
  if not found then
    raise exception 'correction not found' using errcode = 'P0068';
  end if;
  select amendment_count into v_count from public.results where id = v_am.result_id;
  if v_am.amendment_seq is distinct from v_count then
    raise exception 'this result was corrected again' using errcode = 'P0068';
  end if;
  if v_am.patient_contacted_at is not null then
    return v_am.patient_contacted_at;
  end if;
  update public.result_amendments
     set patient_contacted_at = now(),
         patient_contacted_by = auth.uid()
   where id = p_amendment_id;
  select s.patient_id into v_patient
    from public.result_copy_states_internal(array[v_am.result_id]) s;
  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', v_patient, 'result.patient_contacted', 'test_request', v_am.test_request_id,
          jsonb_build_object('result_id', v_am.result_id, 'amendment_id', v_am.id,
                             'amendment_seq', v_am.amendment_seq));
  return now();
end;
$$;
revoke all on function public.result_mark_copy_contacted(uuid) from public, anon;
grant execute on function public.result_mark_copy_contacted(uuid) to authenticated, service_role;

-- The opt-in notice: claim once (returns a row only the first time), then
-- record what went out. Server only.
create or replace function public.result_claim_patient_notify(p_amendment_id uuid)
returns table (result_id uuid, amendment_seq int, anchor_test_request_id uuid, patient_id uuid)
language sql
volatile
security definer
set search_path = public
as $$
  with c as (
    update public.result_amendments
       set patient_notified_at = now()
     where id = p_amendment_id
       and patient_notified_at is null
    returning result_id, amendment_seq
  )
  select c.result_id, c.amendment_seq, s.anchor_test_request_id, s.patient_id
    from c
    cross join lateral public.result_copy_states_internal(array[c.result_id]) s;
$$;
revoke all on function public.result_claim_patient_notify(uuid) from public, anon, authenticated;
grant execute on function public.result_claim_patient_notify(uuid) to service_role;

create or replace function public.result_record_patient_notify(
  p_amendment_id uuid, p_channels text[], p_error text
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.result_amendments
     set patient_notified_channels = coalesce(p_channels, '{}'::text[]),
         patient_notify_error      = nullif(btrim(coalesce(p_error, '')), '')
   where id = p_amendment_id
     and patient_notified_at is not null;
$$;
revoke all on function public.result_record_patient_notify(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.result_record_patient_notify(uuid, text[], text) to service_role;
```

- [ ] **Step 3: P0068 translation.** In `src/lib/accounting/pg-errors.ts`, add it before `default:`, matching the P0065–P0067 style:

```ts
    // 0179: result_mark_copy_contacted — the list row is for an older
    // correction; the result was corrected again since the page loaded.
    case "P0068":
      return "This result was corrected again since the list loaded. Refresh and follow up the newest correction.";
```

- [ ] **Step 4: Run** `npx vitest run src/lib/results/result-copy-followups-migration.test.ts src/lib/accounting` (the pg-error coverage test lives there; grep `pg-error-coverage` if it lives elsewhere). Expected: all PASS.
- [ ] **Step 5: Commit** (`feat(db): 0179 part 2 — copy-state RPCs, follow-up + notify claims, P0068`).

---

### Task 4: Apply locally + SQL smoke

**Files:** Create `scripts/smoke/result-copy-followups.sql`; modify `scripts/smoke/result-edit-followups.sql`.

- [ ] **Step 1: Apply to the shared local DB** (there is no host psql):

```bash
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -q < supabase/migrations/0179_result_copy_followups.sql && echo APPLIED
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -Atc "select count(*) from pg_proc where proname in ('result_copy_states_internal','result_copy_state','result_outdated_copies','result_mark_copy_contacted','result_claim_patient_notify','result_record_patient_notify')"
```
Expected: `APPLIED`, then `6`. If it fails because 0176 objects are missing, the shared DB was reset to an older state. Apply 0176 first the same way.

- [ ] **Step 2: Write the smoke.** Open `scripts/smoke/result-edit-followups.sql` and copy its structure verbatim: the `begin;` … `rollback;` wrapper, its fixture block (patient, visit, service, test request, a finalised structured result, template params), and its role-switch helper (`set local role authenticated` + `request.jwt.claims` with a staff user id). Then add these assertions, each as a `do $$ … $$` block that raises on failure:
  1. **Withdraw, not delete.** Seed one unacknowledged `critical_alerts` row for the result (as that file already does). Call `result_edit_commit` as `service_role` with `p_alerts := '[]'::jsonb`. Assert the row still exists with `withdrawn_at is not null`, `withdrawn_by = editor` and `withdrawn_by_amendment = (the new amendment id)`, and that the returned `alerts_removed = 1`.
  2. **Re-page.** Call `result_edit_commit` again with `p_alerts` containing the SAME parameter/direction/value. Assert a NEW `critical_alerts` row exists with `withdrawn_at is null`, and `alerts_added` has 1 element.
  3. **Acknowledged untouched.** Acknowledge the live alert and edit with `'[]'`. Assert `withdrawn_at is null` on the acknowledged row.
  4. **Finalise path still deletes.** `grep` 0172 for `result_finalise_commit` and confirm the `delete from public.critical_alerts` is still there: `select prosrc ~ 'delete from public.critical_alerts' from pg_proc where proname='result_finalise_commit'` → true.
  5. **Copy state.** Set `results.patient_last_downloaded_at` to before `amended_at`. Assert `result_copy_states_internal(array[id])` gives `portal_outdated = true` and `followed_up = false`. Insert an `audit_log` row (`action 'result.printed_staff'`, metadata `{"result_id": id, "amendment_count": "0", "role": "reception"}`) and assert `printed_outdated = true`. A row with `"role": "medtech"` alone must NOT set it.
  6. **Grants.** As a medtech JWT, `result_outdated_copies()` raises `42501`. As reception, it returns the row, and its columns contain no reason (the column list is fixed by the signature; assert `patient_name` is not null). As reception, `result_copy_state(array[id])` returns 1 row. As a medtech whose sections exclude the service, it returns 0 rows.
  7. **Mark contacted.** As reception, call `result_mark_copy_contacted(<latest amendment id>)`. Assert `followed_up = true` and that exactly one `audit_log` row has `action = 'result.patient_contacted'`. Calling it with the PREVIOUS amendment id raises `P0068`. Calling it twice with the latest writes no second audit row.
  8. **Notify once.** As `service_role`, the first `result_claim_patient_notify(id)` returns 1 row and the second returns 0. After `result_record_patient_notify(id, '{email}', null)`, `followed_up = true`. With `(id, '{}', 'provider down')` instead, `followed_up = false` and `notify_failed = true` in `result_copy_state`.
  9. **Two-session race** (run separately, outside the transaction): in session A, `begin; select * from result_claim_patient_notify('<id>'); select pg_sleep(4); commit;` in the background. Session B, started 1 s later, calls the same claim. Only one returns a row. Use the recipe in memory `drmed-result-edit-followups` (background `docker exec … psql` with `&`).

- [ ] **Step 3: Fix the old smoke.** In `scripts/smoke/result-edit-followups.sql`, find the assertion that the edit removed the alert (it seeds a `critical_alerts` row near L196). Where it checks the row is gone, assert `withdrawn_at is not null` instead. The replay assertion on `alerts_removed` is unchanged.

- [ ] **Step 4: Run both**

```bash
for f in result-copy-followups result-edit-followups; do
  docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < scripts/smoke/$f.sql > /tmp/rcf-smoke-$f.log 2>&1; echo "$f exit $?"; done
```
Expected: `exit 0` for both. On failure, read the log tail.

- [ ] **Step 5: Commit** (`test(db): smoke for 0179 copy state, withdrawal, notify claim`).

---

### Task 5: Types

- [ ] **Step 1:** `npm run db:types > /tmp/rcf-types.log 2>&1`. Then run `git diff --stat src/types/database.ts`. The shared local DB carries other branches' objects, so **splice only 0179's entries**:
  - the 5 `result_amendments` columns (Row/Insert/Update)
  - the 3 `critical_alerts` columns
  - the 6 functions under `Functions`

  Keep them and `git checkout -p src/types/database.ts` everything else.
- [ ] **Step 2:** `npm run typecheck` → PASS. Commit (`chore(types): 0179 columns and functions`).

---

### Task 6: Pure copy-follow-up logic (TDD)

**Files:** Create `src/lib/results/copy-followups.ts`, `src/lib/results/copy-followups.test.ts`.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import {
  copyKindLabel,
  followUpStatusLabel,
  outdatedCopyChip,
  shouldOfferNotify,
  type CopyState,
} from "./copy-followups";

const base: CopyState = {
  result_id: "r1", latest_amendment_id: "a1", amendment_count: 1,
  amended_at: "2026-09-25T02:00:00.000001+00:00",
  holds_copy: true, portal_outdated: true, printed_outdated: false,
  followed_up: false, notified_at: null, notify_failed: false,
  has_email: true, has_phone: false,
};

describe("shouldOfferNotify", () => {
  it("offers when the patient holds a copy and can be reached", () => {
    expect(shouldOfferNotify(base)).toEqual({ offered: true });
  });
  it("does not offer when the patient never downloaded or was handed a copy", () => {
    expect(shouldOfferNotify({ ...base, holds_copy: false })).toEqual({
      offered: false, reason: "The patient hasn't downloaded or been handed a copy yet.",
    });
  });
  it("does not offer without an email or mobile number", () => {
    expect(shouldOfferNotify({ ...base, has_email: false, has_phone: false })).toEqual({
      offered: false, reason: "No email or mobile number on file.",
    });
  });
  it("does not offer when the state could not be read", () => {
    expect(shouldOfferNotify(undefined).offered).toBe(false);
  });
});

describe("copyKindLabel", () => {
  it.each([
    [true, false, "Portal download"],
    [false, true, "Printed copy"],
    [true, true, "Portal download + printed copy"],
  ])("portal=%s printed=%s → %s", (portal, printed, label) => {
    expect(copyKindLabel({ portal_outdated: portal, printed_outdated: printed })).toBe(label);
  });
});

describe("followUpStatusLabel", () => {
  it("contacted wins", () => {
    expect(followUpStatusLabel({ contacted_at: "x", notified_at: null, notify_failed: false, notified_channels: null }))
      .toBe("Contacted");
  });
  it("names the channels that went out", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: "x", notify_failed: false, notified_channels: ["email", "sms"] }))
      .toBe("Notified by email and SMS");
  });
  it("a failed send stays visible", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: "x", notify_failed: true, notified_channels: [] }))
      .toBe("Send failed — call the patient");
  });
  it("a claim with no record yet counts as not sent", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: "x", notify_failed: false, notified_channels: null }))
      .toBe("Send status unknown — call the patient");
  });
  it("nothing yet", () => {
    expect(followUpStatusLabel({ contacted_at: null, notified_at: null, notify_failed: false, notified_channels: null }))
      .toBe("Not contacted");
  });
});

describe("outdatedCopyChip", () => {
  it("is null when followed up or not out of date", () => {
    expect(outdatedCopyChip({ ...base, followed_up: true })).toBeNull();
    expect(outdatedCopyChip({ ...base, portal_outdated: false })).toBeNull();
  });
  it("words the copy kind", () => {
    expect(outdatedCopyChip(base)).toBe("Patient has an older copy (portal download)");
    expect(outdatedCopyChip({ ...base, portal_outdated: false, printed_outdated: true }))
      .toBe("Patient has an older copy (printed) — reprint before handing over");
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement**

```ts
// Pure rules for corrected-result follow-ups (0179). No server-only, no IO.

/** One row of result_copy_state(). */
export interface CopyState {
  result_id: string;
  latest_amendment_id: string | null;
  amendment_count: number;
  amended_at: string | null;
  holds_copy: boolean;
  portal_outdated: boolean;
  printed_outdated: boolean;
  followed_up: boolean;
  notified_at: string | null;
  notify_failed: boolean;
  has_email: boolean;
  has_phone: boolean;
}

export type NotifyOffer = { offered: true } | { offered: false; reason: string };

/** The edit form offers "Let the patient know…" only when it can mean something. */
export function shouldOfferNotify(s: CopyState | undefined): NotifyOffer {
  if (!s) return { offered: false, reason: "Couldn't check whether the patient has a copy." };
  if (!s.holds_copy) {
    return { offered: false, reason: "The patient hasn't downloaded or been handed a copy yet." };
  }
  if (!s.has_email && !s.has_phone) {
    return { offered: false, reason: "No email or mobile number on file." };
  }
  return { offered: true };
}

export function copyKindLabel(s: { portal_outdated: boolean; printed_outdated: boolean }): string {
  if (s.portal_outdated && s.printed_outdated) return "Portal download + printed copy";
  return s.portal_outdated ? "Portal download" : "Printed copy";
}

const CHANNEL_WORD: Record<string, string> = { email: "email", sms: "SMS" };

export function followUpStatusLabel(s: {
  contacted_at: string | null;
  notified_at: string | null;
  notify_failed: boolean;
  notified_channels: readonly string[] | null;
}): string {
  if (s.contacted_at) return "Contacted";
  if (!s.notified_at) return "Not contacted";
  if (s.notify_failed) return "Send failed — call the patient";
  if (!s.notified_channels) return "Send status unknown — call the patient";
  if (s.notified_channels.length === 0) return "Send failed — call the patient";
  const words = s.notified_channels.map((c) => CHANNEL_WORD[c] ?? c);
  return `Notified by ${words.join(" and ")}`;
}

/** Visit-page chip text, or null when there is nothing to chase. */
export function outdatedCopyChip(s: CopyState | undefined): string | null {
  if (!s || s.followed_up || !(s.portal_outdated || s.printed_outdated)) return null;
  if (s.printed_outdated && !s.portal_outdated) {
    return "Patient has an older copy (printed) — reprint before handing over";
  }
  if (s.printed_outdated) return "Patient has an older copy (portal + printed) — reprint before handing over";
  return "Patient has an older copy (portal download)";
}

export const PATIENT_CONTACTED_ACTION = "result.patient_contacted";
```

- [ ] **Step 4: Run it.** Expected: PASS. Commit (`feat(results): pure copy follow-up rules`).

---

### Task 7: Server loaders

**Files:** Create `src/lib/results/copy-followups.server.ts`.

- [ ] **Step 1: Implement.** Follow the house pattern:
  - `import "server-only"` at the top.
  - The signed-in client comes in as a parameter.
  - The admin client is lazy-imported inside the function (CLAUDE.md: never at module scope under `src/lib/results/`).

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { CopyState } from "./copy-followups";

type Db = SupabaseClient<Database>;

/** result_copy_state for staff pages (signed-in client — the RPC gates rows). null = read failed. */
export async function fetchCopyStates(db: Db, resultIds: readonly string[]): Promise<Map<string, CopyState> | null> {
  const ids = [...new Set(resultIds)];
  const out = new Map<string, CopyState>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.rpc("result_copy_state", { p_result_ids: ids.slice(i, i + 200) });
    if (error) return null;
    for (const row of data ?? []) out.set(row.result_id, row as CopyState);
  }
  return out;
}

/** Server-side re-check before sending a notice (service role, internal function). */
export async function fetchCopyStateAdmin(resultId: string): Promise<CopyState | undefined> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient().rpc("result_copy_states_internal", { p_result_ids: [resultId] });
  if (error || !data?.[0]) return undefined;
  const r = data[0];
  return {
    result_id: r.result_id, latest_amendment_id: r.latest_amendment_id,
    amendment_count: r.amendment_count, amended_at: r.amended_at,
    holds_copy: r.holds_copy, portal_outdated: r.portal_outdated,
    printed_outdated: r.printed_outdated, followed_up: r.followed_up,
    notified_at: r.notified_at, notify_failed: r.notify_error != null,
    has_email: r.has_email, has_phone: r.has_phone,
  };
}

export type OutdatedCopyRow = Database["public"]["Functions"]["result_outdated_copies"]["Returns"][number];

/** The follow-up list (signed-in client; reception/admin, else the RPC raises 42501). */
export async function fetchOutdatedCopies(db: Db, includeFollowedUp: boolean) {
  const { data, error } = await db.rpc("result_outdated_copies", { p_include_followed_up: includeFollowedUp });
  return error ? { ok: false as const, error } : { ok: true as const, rows: (data ?? []) as OutdatedCopyRow[] };
}
```

- [ ] **Step 2:** `npm run typecheck` → PASS. Commit (`feat(results): copy follow-up loaders`).

---

### Task 8: `commitResultEdit` returns the amendment id

**Files:** Modify `src/lib/actions/results/result-edit-core.ts` and `result-edit-core.test.ts`.

- [ ] **Step 1: Failing test.** In `result-edit-core.test.ts`, find the success-path test that mocks the RPC response. Add `amendment_id: "am-1"` to the mocked RPC `data`, and assert `res.data.amendmentId === "am-1"`. In the replay/probe test (the one that selects `result_amendments` by `attempt_id`), make the probe mock return `id: "am-2"` and assert `amendmentId === "am-2"`. Run it → FAIL.
- [ ] **Step 2: Implement.**
  - Add `amendmentId: string` to `CommitResultEditData` (L141–150).
  - Read it from `d.amendment_id` where the other fields are read (L225–250). The RPC already returns `amendment_id` on both the fresh and the replay path; see 0176 L284/L491.
  - In the `probe()` select (L207–216), add `id` to the selected columns and map it to `amendmentId`.
- [ ] **Step 3:** Run it → PASS. Commit (`feat(results): commitResultEdit returns the amendment id`).

---

### Task 9: "Updated copy ready" message + sender

**Files:** Create `src/lib/notifications/corrected-result-message.ts` (+ `.test.ts`) and `src/lib/notifications/notify-corrected.ts`.

- [ ] **Step 1: Read** `src/lib/notifications/notify-released.ts` in full. Note:
  - where it builds the portal URL for `emailButton` (reuse that exact expression/constant)
  - the SMS wording style
  - how it calls `sendEmail`/`sendSms`
  - how it writes the `result.notified` audit row

- [ ] **Step 2: Failing test for the pure message builder**

```ts
import { describe, expect, it } from "vitest";
import { buildCorrectedResultMessages } from "./corrected-result-message";

describe("buildCorrectedResultMessages", () => {
  const m = buildCorrectedResultMessages({ firstName: "Ana", testName: "Chemistry", portalUrl: "https://drmed.ph/portal" });
  it("tells the patient an updated copy is ready, in the portal", () => {
    expect(m.sms).toContain("updated copy of your Chemistry result");
    expect(m.sms).toContain("https://drmed.ph/portal");
    expect(m.emailSubject).toBe("An updated copy of your DRMed result is ready");
    expect(m.emailHtml).toContain("Chemistry");
  });
  it("never carries a reason, a value or the word amended", () => {
    for (const text of [m.sms, m.emailHtml]) {
      expect(text).not.toMatch(/reason|amend|error|mmol|mg\/dL/i);
    }
  });
  it("escapes the test name in HTML", () => {
    const x = buildCorrectedResultMessages({ firstName: "A", testName: "<b>X</b>", portalUrl: "u" });
    expect(x.emailHtml).not.toContain("<b>X</b>");
  });
});
```

- [ ] **Step 3: Implement the builder**, reusing `renderEmailShell`, `emailParagraph`, `emailButton`, `emailFinePrint` and `escapeHtml` from `./branded-email` exactly as `notify-released.ts` does:

```ts
import {
  emailButton,
  emailFinePrint,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "./branded-email";

export interface CorrectedResultMessageInput {
  firstName: string | null;
  testName: string;
  portalUrl: string;
}

/** Patient notice for a corrected result. No reason and no values — owner decision 2026-09-25. */
export function buildCorrectedResultMessages(i: CorrectedResultMessageInput) {
  const hi = i.firstName ? `Hi ${i.firstName}, ` : "";
  const sms =
    `${hi}an updated copy of your ${i.testName} result from DRMed is ready. ` +
    `Please view and download the latest version in the patient portal: ${i.portalUrl}`;
  const emailHtml = renderEmailShell({
    heading: "An updated copy of your result is ready",
    contentHtml:
      emailParagraph(
        `${i.firstName ? `Hi ${escapeHtml(i.firstName)}, ` : ""}an updated copy of your <b>${escapeHtml(i.testName)}</b> result is ready. Please view and download the latest version securely in the patient portal.`,
      ) +
      emailButton({ href: i.portalUrl, label: "Open the patient portal" }) +
      emailFinePrint("If you printed or saved an earlier copy, please use this updated one instead."),
    receivedNote: "You received this because a result from your DRMed visit was updated.",
  });
  return { sms, emailSubject: "An updated copy of your DRMed result is ready", emailHtml };
}
```
Match `emailButton`'s real signature; if it takes positional args, adapt it. Run the test → PASS.

- [ ] **Step 4: Implement the sender.** It is `server-only`, never throws, and returns an outcome:

```ts
import "server-only";
import { reportError } from "@/lib/observability/report-error"; // use the same import notify-released.ts uses
import { audit } from "@/lib/audit/log";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { buildCorrectedResultMessages } from "./corrected-result-message";

export type NotifyOutcome = "sent" | "failed" | "already";

export async function notifyResultCorrected(args: {
  amendmentId: string;
  testName: string;
  actorId: string;
}): Promise<NotifyOutcome> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: claimed, error: claimErr } = await admin.rpc("result_claim_patient_notify", {
    p_amendment_id: args.amendmentId,
  });
  if (claimErr) {
    reportError(claimErr, { scope: "notify/result-corrected:claim" });
    return "failed";
  }
  const c = claimed?.[0];
  if (!c) return "already";

  let channels: string[] = [];
  let error: string | null = null;
  let smsMeta: unknown = null;
  let emailMeta: unknown = null;
  try {
    const { data: p } = await admin
      .from("patients")
      .select("id, first_name, phone, email")
      .eq("id", c.patient_id)
      .maybeSingle();
    const msg = buildCorrectedResultMessages({
      firstName: p?.first_name ?? null,
      testName: args.testName,
      portalUrl: PORTAL_URL, // same value notify-released.ts uses — import or reuse it, don't retype
    });
    const [sms, email] = await Promise.all([
      p?.phone ? sendSms({ to: p.phone, message: msg.sms }) : Promise.resolve(null),
      p?.email ? sendEmail({ to: p.email, subject: msg.emailSubject, html: msg.emailHtml }) : Promise.resolve(null),
    ]);
    smsMeta = sms;
    emailMeta = email;
    if (sms?.ok) channels.push("sms");
    if (email?.ok) channels.push("email");
    if (channels.length === 0) {
      error = [sms, email]
        .filter(Boolean)
        .map((r) => ("reason" in r! ? r!.reason : "error" in r! ? String(r!.error) : "not sent"))
        .join("; ") || "no contact on file";
    }
  } catch (e) {
    reportError(e, { scope: "notify/result-corrected:send" });
    channels = [];
    error = "internal error while sending";
  }
  await admin.rpc("result_record_patient_notify", {
    p_amendment_id: args.amendmentId,
    p_channels: channels,
    p_error: error,
  });
  await audit({
    actor_id: args.actorId,
    actor_type: "staff",
    patient_id: c.patient_id,
    action: "result.notified",
    resource_type: "test_request",
    resource_id: c.anchor_test_request_id,
    metadata: {
      kind: "corrected",
      result_id: c.result_id,
      amendment_id: args.amendmentId,
      amendment_seq: c.amendment_seq,
      sms: smsMeta,
      email: emailMeta,
    },
  });
  return channels.length > 0 ? "sent" : "failed";
}
```
Replace `PORTAL_URL` and the `sendEmail`/`sendSms` argument shapes with the real ones from `notify-released.ts`, and match its `sms`/`email` metadata shape (`{ok, id, to}` / skipped / error) rather than dumping raw results. Result types are `{ ok: true, id } | { ok: false, kind: "skipped", reason } | { ok: false, error }`; narrow them with their discriminant, not with `in`.

- [ ] **Step 5:** `npm test -- src/lib/notifications && npm run typecheck` → PASS. Commit (`feat(notifications): opt-in "updated copy ready" notice, sent once`).

---

### Task 10: Checkbox on both edit forms

**Files:**
- Create: `src/components/staff/notify-patient-checkbox.tsx`
- Modify: `queue/[id]/amend-form.tsx`, `queue/[id]/structured-form.tsx`, `queue/[id]/page.tsx`, `queue/[id]/actions.ts`, `queue/consolidated/[visitId]/[groupId]/{report-edit-form.tsx,page.tsx,report-cards.tsx,actions.ts}`, `src/lib/actions/results/amend-consolidated.ts`

- [ ] **Step 1: Shared checkbox component** (client-safe, no server imports):

```tsx
"use client";
import type { NotifyOffer } from "@/lib/results/copy-followups";

export function NotifyPatientCheckbox({
  offer, checked, onChange, name, id,
}: {
  offer: NotifyOffer;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  name?: string;
  id: string;
}) {
  if (!offer.offered) {
    return <p className="text-xs text-slate-500">Patient notice not available: {offer.reason}</p>;
  }
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        name={name}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
      />
      <span>
        Let the patient know an updated copy is ready
        <span className="block text-xs text-slate-500">
          Sends one email/SMS. It never says why the result changed.
        </span>
      </span>
    </label>
  );
}
```
For the uncontrolled FormData form (`amend-form.tsx` uploaded branch), pass `name="notify_patient"` and no `checked`/`onChange`. Check the `stable-fields.tsx` house pattern (memory `drmed-form-reset-selects-checkboxes`: React 19 form reset snaps checkboxes back). If that file exports a stable checkbox, use it for the uncontrolled case.

- [ ] **Step 2: Pages compute the offer.**
  - In `queue/[id]/page.tsx`: where the page knows the result id for the amend form, call `fetchCopyStates(staffDb, [resultId])` with the signed-in client. Compute `shouldOfferNotify(states?.get(resultId))` and pass `notifyOffer` down through `AmendResultForm` → `StructuredResultForm` (amend mode).
  - In the consolidated `page.tsx`: fetch the states for all report result ids in one call, and put `notifyOffer` on each `ReportCardData`, which `report-cards.tsx` passes to `ReportEditForm`.

- [ ] **Step 3: Forms send the choice.**
  - The uploaded branch of `amend-form.tsx` renders the checkbox inside the `<form>` (FormData carries `notify_patient=on`).
  - `structured-form.tsx` amend mode: `const [notify, setNotify] = useState(false)`, controlled checkbox, and `if (notify) fd.append("notify_patient", "on")` beside the `reason` append (L213–224).
  - `report-edit-form.tsx`: controlled state; send `notifyPatient: notify` in the `amendConsolidated({...})` object.
  - Replace the old copy "Patients with the result already downloaded need to be notified manually." (amend-form.tsx L133, structured branch L78–79) and "A patient who already downloaded the old PDF is not told automatically." (report-edit-form.tsx L78–79) with: "Patients who already have a copy appear on Result follow-ups until someone contacts them."

- [ ] **Step 4: Actions honour it.** In each of `amendResultAction`, `amendStructuredResultAction` and `amendConsolidatedReport`, right after the successful `commitResultEdit` and its existing `result.amended` audit:

```ts
let notify: NotifyOutcome | "not_offered" | undefined;
if (wantsNotify) {
  const offer = shouldOfferNotify(await fetchCopyStateAdmin(resultId));
  notify = offer.offered
    ? await notifyResultCorrected({ amendmentId: committed.data.amendmentId, testName, actorId: session.user_id })
    : "not_offered";
}
return { ok: true, notify } as const;
```
Where:
- `wantsNotify = formData.get("notify_patient") === "on"` (single-test actions).
- For consolidated, `wantsNotify = parsed.notifyPatient === true`: add `notifyPatient: z.boolean().optional()` to the Zod schema in the consolidated `actions.ts` (L158 wrapper) and to `AmendConsolidatedInput`.
- `testName` is the service name in single-test actions (already selected for the audit/PDF) and the report group's display name in consolidated.

Widen each action's success type from `{ ok: true }` to `{ ok: true; notify?: NotifyOutcome | "not_offered" }`.

- [ ] **Step 5: Forms show the outcome.** On success, append to the existing success message:

```ts
const NOTIFY_TEXT: Record<string, string> = {
  sent: " The patient was sent an update notice.",
  failed: " The patient notice could not be sent — they're on Result follow-ups.",
  already: " The patient was already notified about this correction.",
  not_offered: " No patient notice was sent (no copy or no contact on file).",
};
```
Note that `amend-form.tsx` currently closes and refreshes on success. Show the message in a `role="status"` line before `router.refresh()`, or keep the panel open for the message.

- [ ] **Step 6:** `npm test && npm run typecheck && npm run lint` → PASS. Commit (`feat(results): opt-in patient notice on result edits`).

---

### Task 11: Result follow-ups page

**Files:** Create `src/app/(staff)/staff/(dashboard)/result-follow-ups/{page.tsx,actions.ts,mark-contacted-button.tsx}`; modify `src/components/staff/staff-nav-config.ts` and the `ROUTE_NAME` map (grep `ROUTE_NAME = ` to find it).

- [ ] **Step 1: Action**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { translatePgError } from "@/lib/accounting/pg-errors";

export async function markCopyContactedAction(amendmentId: string) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false as const, error: "Only reception or admin can do this." };
  }
  const db = await createClient();
  const { error } = await db.rpc("result_mark_copy_contacted", { p_amendment_id: amendmentId });
  if (error) return { ok: false as const, error: translatePgError(error) };
  revalidatePath("/staff/result-follow-ups");
  return { ok: true as const, data: null };
}
```
Match `translatePgError`'s real signature; the audit row is written inside the RPC.

- [ ] **Step 2: Button** (`"use client"`, `useTransition`): it calls the action, shows the error in `role="alert"`, and is labelled "Mark as contacted" / "Saving…".

- [ ] **Step 3: Page.** It's a server component:
  - `metadata = { title: "Result follow-ups" }`.
  - Gate: `requireActiveStaff()`, then `notFound()` unless the role is reception/admin.
  - `searchParams.all === "1"` → include followed-up rows.
  - `fetchOutdatedCopies(await createClient(), includeAll)`. On `!ok`, render "Couldn't load follow-ups." (fail closed, never an empty "all clear").
  - Page header per `drmed-staff-ui`.
  - A filter chip link "Show followed-up" / "Hide followed-up".
  - A table with columns: Patient (name + DRM-ID, linking to `/staff/visits/${visit_id}`) · Phone · Test · Corrected (`manilaDateTime(amended_at)`) · Copy (`copyKindLabel`) · Status (`followUpStatusLabel`, plus "by <contacted_by_name>" when contacted) · action (`MarkContactedButton` when `!followed_up && latest_amendment_id`).
  - Empty state: "No patients are holding an out-of-date copy."
  - An in-band note under the header: "Lists patients who downloaded or were handed a result before it was corrected. Reasons for corrections are not shown here."

- [ ] **Step 4: Nav.** Add `{ href: "/staff/result-follow-ups", label: ROUTE_NAME["/staff/result-follow-ups"], description: "Patients holding a copy of a result that was corrected afterwards — call them or mark them contacted.", roles: ["reception", "admin"] }` to the section that holds the reception visit/queue items (read the file; pick the section containing `/staff/visits`). Add `"/staff/result-follow-ups": "Result follow-ups"` to `ROUTE_NAME`. Run the nav tests (`npx vitest run src/components/staff`); fix any snapshot/label test by adding the new item to its expected list.

- [ ] **Step 5:** `npm test && npm run typecheck && npm run lint` → PASS. Commit (`feat(staff): Result follow-ups page for reception and admin`).

---

### Task 12: Dashboard cards

**Files:** Modify `src/lib/dashboards/cards.ts`, `_dashboards/reception-dashboard.tsx`, `_dashboards/admin-dashboard.tsx`, `_dashboards/lab-dashboard.tsx`.

- [ ] **Step 1: Registry entries** (next to their siblings):

```ts
{ id: "reception.result_followups", label: "Result follow-ups", roles: ["reception"], group: "attention" },
{ id: "admin.result_followups", label: "Result follow-ups", roles: ["admin"], group: "attention" },
{ id: "lab.updated_7d", label: "Updated (last 7 days)", roles: ["medtech", "pathologist", "xray_technician"], group: "snapshot" },
```
If `cards.test.ts` pins ids/labels, add them there.

- [ ] **Step 2: Reception + admin.** Guard the fetch with `show(id)`, following the `admin.queue_unclaimed` pattern:
  - The fetch: `fetchOutdatedCopies(signedInClient, false)`, then `count = rows.length`.
  - Hidden at 0 unless there was an error, like `showDupCard`: `show(id) && (err || count > 0)`.
  - Render a `<StatCard label="Patients with an out-of-date copy" value={count} href="/staff/result-follow-ups" accent="warn" />` (match StatCard's real props).
  - Push errors into the dashboard's `namedResults`.

- [ ] **Step 3: Lab.** `lab.updated_7d` counts `result_amendments` with the signed-in client, which RLS scopes to readable results:

```ts
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
staffDb.from("result_amendments").select("id", { count: "exact", head: true }).gte("amended_at", since)
```
It links to `/staff/results?updated=7d` (Task 17).

- [ ] **Step 4:** `npm test && npm run typecheck` → PASS. Commit (`feat(dashboards): result follow-ups + updated-last-7-days cards`).

---

### Task 13: Visit page chip

**Files:** Modify `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx`.

- [ ] **Step 1:** After `pdfStates = await resultPdfStates(...)` (~L221), collect `resultIds = [...new Set([...pdfStates.values()].map((s) => s.resultId))]` and call `const copyStates = await fetchCopyStates(supabase, resultIds)` with the signed-in client (the page's `supabase`, if it is the signed-in one; confirm).
- [ ] **Step 2:** In both status cells (component rows ~L1080–1135 and plain rows ~L1330–1350), right after `<HandedBackBadge … />`, render:

```tsx
{(() => {
  const s = pdfStates.get(id);
  const chip = s ? outdatedCopyChip(copyStates?.get(s.resultId)) : null;
  return chip ? (
    <span className="ml-1 inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">
      {chip}
    </span>
  ) : null;
})()}
```
Use the row's real id variable (`c.id` / `t.id`). Extract a tiny `OutdatedCopyChip` component in the same file if the IIFE repeats twice. Package headers get no chip, same rule as `HandedBackBadge`.

- [ ] **Step 3:** `npm run typecheck && npm run lint` → PASS. Commit (`feat(visits): flag results the patient holds an older copy of`).

---

### Task 14: Stale-print warning (TDD)

**Files:** Modify `src/lib/results/print-summary.ts` (+ its test) and `src/lib/results/print-history.ts`. Create `src/components/staff/stale-print-warning.tsx`. Modify `visits/[id]/page.tsx`, `queue/page.tsx` and `results/page.tsx`.

- [ ] **Step 1: Failing test** (add to `print-summary.test.ts`):

```ts
import { foldStalePrints } from "./print-summary";

describe("foldStalePrints", () => {
  const row = (result_id: string, amendment_count: string | null) =>
    ({ result_id, amendment_count, created_at: "2026-09-25T01:00:00Z", actor_id: "u" });
  it("flags a result whose newest print is an older version", () => {
    const m = foldStalePrints([row("r1", "0")], new Map([["r1", 1]]));
    expect(m.get("r1")).toEqual({ printedVersion: 1, currentVersion: 2 });
  });
  it("a print of the current version clears it", () => {
    expect(foldStalePrints([row("r1", "0"), row("r1", "1")], new Map([["r1", 1]])).has("r1")).toBe(false);
  });
  it("ignores unstamped rows and unknown results", () => {
    expect(foldStalePrints([row("r1", null), row("r2", "0")], new Map([["r1", 1]])).size).toBe(0);
  });
  it("reports the newest stale version", () => {
    expect(foldStalePrints([row("r1", "0"), row("r1", "1")], new Map([["r1", 2]])).get("r1"))
      .toEqual({ printedVersion: 2, currentVersion: 3 });
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** in `print-summary.ts` (versions are `amendment_count + 1`):

```ts
export interface StalePrint { printedVersion: number; currentVersion: number }

/** Results whose newest print is an OLDER file than the current one (and no print of the current file). */
export function foldStalePrints(
  rows: readonly PrintEventRow[],
  currentVersions: ReadonlyMap<string, number>,
): Map<string, StalePrint> {
  const newest = new Map<string, number>();
  for (const r of rows) {
    const cur = currentVersions.get(r.result_id);
    if (cur === undefined || r.amendment_count == null || !/^\d+$/.test(r.amendment_count)) continue;
    const n = Number(r.amendment_count);
    newest.set(r.result_id, Math.max(newest.get(r.result_id) ?? -1, n));
  }
  const out = new Map<string, StalePrint>();
  for (const [id, n] of newest) {
    const cur = currentVersions.get(id)!;
    if (n < cur) out.set(id, { printedVersion: n + 1, currentVersion: cur + 1 });
  }
  return out;
}
```
Run → PASS.

- [ ] **Step 3: Loader.** In `print-history.ts`, add `fetchPrintState(files, opts)`, which returns `{ summaries, stale }` from ONE read of the rows, and make `fetchPrintSummaries` return `(await fetchPrintState(files, opts)).summaries`, so existing callers don't change. Build `currentVersions` the same way `fetchPrintSummaries` builds its map today.

- [ ] **Step 4: Component**

```tsx
import type { StalePrint } from "@/lib/results/print-summary";

export function StalePrintWarning({ stale }: { stale: StalePrint | undefined }) {
  if (!stale) return null;
  return (
    <p className="text-xs text-amber-800" role="note">
      Printed copy is v{stale.printedVersion} — the current version is v{stale.currentVersion}. Reprint before handing over.
    </p>
  );
}
```

- [ ] **Step 5: Wire it.**
  - The visit page: switch to `fetchPrintState`; pass `stale={printState.stale.get(resultId)}` into `ReleasedPdfActions`, which renders `<StalePrintWarning>` under `<PrintedNote>`.
  - The queue "Released today" `ReleasedPrintActions` (~L1195) gets the same treatment.
  - The results archive: fetch `fetchPrintState` for the page's result ids and show `Printed copy out of date` in the Updated column when stale is set.

- [ ] **Step 6:** `npm test && npm run typecheck && npm run lint` → PASS. Commit (`feat(results): warn when the printed copy is an older version`).

---

### Task 15: Withdrawn critical alerts in the UI

**Files:** Modify `critical-alerts/page.tsx`, `critical-alerts/actions.ts`, `_dashboards/lab-dashboard.tsx`.

- [ ] **Step 1: Active means not withdrawn.** Add `.is("withdrawn_at", null)` to:
  - page.tsx L154–163 (the unacknowledged worklist)
  - lab-dashboard.tsx L185–191 (`lab.critical_alerts` count)
  - L291–300 (the pathologist strip)
  - L273–284 (the medtech strip; a withdrawn alert is not a critical anymore)

  The "Recently acknowledged" query needs nothing (withdrawn rows are never acknowledged), but add the filter anyway for clarity.
- [ ] **Step 2: No acknowledging a withdrawn alert.** In `actions.ts` L35–44, add `.is("withdrawn_at", null)` to the update chain. When it returns no row, re-read the alert. If `withdrawn_at` is set, return `{ ok: false, error: "This alert was withdrawn by a correction to the result." }`.
- [ ] **Step 3: Withdrawn section.** Add a third `<details>` after "Recently acknowledged":
  - Heading: "Withdrawn by a correction (N)".
  - Query: `.not("withdrawn_at", "is", null).order("withdrawn_at", { ascending: false }).order("id", { ascending: true }).range(0, 49)` with `count: "exact"`. Wrap it in the same `scopeToOwn` for medtechs.
  - Rows: patient, parameter, direction badge, the value, "Withdrawn <manilaDateTime> by <name>". Look up `withdrawn_by` names the way the acknowledged table resolves `acknowledged_by` names.
  - When `count > 50`, show the in-band line "Showing the latest 50 of N." (CLAUDE.md: never a silent cap).
  - No acknowledge button.
- [ ] **Step 4:** `npm run typecheck && npm run lint` → PASS. Commit (`feat(alerts): keep alerts a correction withdrew, as history`).

---

### Task 16: "What changed" (TDD)

**Files:**
- Create: `src/lib/results/version-diff.ts` (+ `.test.ts`), `src/lib/results/version-diff.server.ts`, `src/components/staff/result-changes.tsx`
- Modify: `queue/[id]/page.tsx`, the consolidated `page.tsx` + `report-cards.tsx`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { changesPerAmendment, diffResultVersions, type SnapshotValue } from "./version-diff";

const v = (id: string, name: string, si: number | null, flag: string | null = null, extra: Partial<SnapshotValue> = {}): SnapshotValue => ({
  parameter_id: id, parameter_name: name, numeric_value_si: si, numeric_value_conv: null,
  text_value: null, select_value: null, flag, is_blank: si == null, ...extra,
});

describe("diffResultVersions", () => {
  it("lists only changed parameters, in the new order", () => {
    const d = diffResultVersions([v("g", "Glucose", 55, "H"), v("c", "Cholesterol", 4)], [v("g", "Glucose", 5.5), v("c", "Cholesterol", 4)]);
    expect(d).toEqual([{ parameterId: "g", name: "Glucose", before: "55", after: "5.5", flagBefore: "H", flagAfter: null }]);
  });
  it("shows added and removed values as —", () => {
    const d = diffResultVersions([v("a", "A", 1)], [v("b", "B", 2)]);
    expect(d.map((x) => [x.name, x.before, x.after])).toEqual([["B", "—", "2"], ["A", "1", "—"]]);
  });
  it("compares text and select values", () => {
    const d = diffResultVersions(
      [v("u", "Urine colour", null, null, { select_value: "Yellow", is_blank: false })],
      [v("u", "Urine colour", null, null, { select_value: "Amber", is_blank: false })],
    );
    expect(d[0]).toMatchObject({ before: "Yellow", after: "Amber" });
  });
  it("a flag-only change counts", () => {
    expect(diffResultVersions([v("g", "G", 5, "H")], [v("g", "G", 5, null)])).toHaveLength(1);
  });
});

describe("changesPerAmendment", () => {
  it("pairs each correction's snapshot with the next one, the last with current values", () => {
    const out = changesPerAmendment(
      [
        { id: "a1", amendment_seq: 1, amended_at: "t1", prior_values_json: [v("g", "G", 1)] },
        { id: "a2", amendment_seq: 2, amended_at: "t2", prior_values_json: [v("g", "G", 2)] },
      ],
      [v("g", "G", 3)],
    );
    expect(out.map((o) => [o.fromVersion, o.toVersion, o.changes[0]?.before, o.changes[0]?.after]))
      .toEqual([[2, 3, "2", "3"], [1, 2, "1", "2"]]); // newest first
  });
  it("a PDF-only correction (no snapshot) says so", () => {
    const [o] = changesPerAmendment([{ id: "a1", amendment_seq: 1, amended_at: "t", prior_values_json: null }], []);
    expect(o.structured).toBe(false);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement**

```ts
// "What changed" between result versions (0172 snapshots). Pure. Staff-only surface.

export interface SnapshotValue {
  parameter_id: string;
  parameter_name: string | null;
  numeric_value_si: number | null;
  numeric_value_conv: number | null;
  text_value: string | null;
  select_value: string | null;
  flag: string | null;
  is_blank: boolean | null;
}

export interface ValueChange {
  parameterId: string;
  name: string;
  before: string;
  after: string;
  flagBefore: string | null;
  flagAfter: string | null;
}

export interface AmendmentSnapshot {
  id: string;
  amendment_seq: number;
  amended_at: string;
  prior_values_json: SnapshotValue[] | null;
}

export function displayValue(x: SnapshotValue | undefined): string {
  if (!x || x.is_blank) return "—";
  if (x.numeric_value_si != null) return String(x.numeric_value_si);
  return x.select_value ?? x.text_value ?? "—";
}

export function diffResultVersions(before: readonly SnapshotValue[], after: readonly SnapshotValue[]): ValueChange[] {
  const b = new Map(before.map((x) => [x.parameter_id, x]));
  const a = new Map(after.map((x) => [x.parameter_id, x]));
  const order = [...after.map((x) => x.parameter_id), ...before.map((x) => x.parameter_id).filter((id) => !a.has(id))];
  const out: ValueChange[] = [];
  for (const id of order) {
    const x = b.get(id);
    const y = a.get(id);
    const change: ValueChange = {
      parameterId: id,
      name: y?.parameter_name ?? x?.parameter_name ?? "Parameter",
      before: displayValue(x),
      after: displayValue(y),
      flagBefore: x?.flag ?? null,
      flagAfter: y?.flag ?? null,
    };
    if (change.before !== change.after || change.flagBefore !== change.flagAfter) out.push(change);
  }
  return out;
}

export interface AmendmentChanges {
  amendmentId: string;
  seq: number;
  amendedAt: string;
  fromVersion: number;
  toVersion: number;
  structured: boolean;
  changes: ValueChange[];
}

/** Newest first. Correction N turned version N into N+1; its "after" is the next snapshot or current values. */
export function changesPerAmendment(
  amendments: readonly AmendmentSnapshot[],
  current: readonly SnapshotValue[],
): AmendmentChanges[] {
  const sorted = [...amendments].sort((x, y) => x.amendment_seq - y.amendment_seq);
  return sorted
    .map((am, i) => {
      const next = sorted[i + 1];
      const after = next ? next.prior_values_json : current;
      const structured = am.prior_values_json != null && after != null;
      return {
        amendmentId: am.id,
        seq: am.amendment_seq,
        amendedAt: am.amended_at,
        fromVersion: am.amendment_seq,
        toVersion: am.amendment_seq + 1,
        structured,
        changes: structured ? diffResultVersions(am.prior_values_json!, after!) : [],
      };
    })
    .reverse();
}
```
Run → PASS.

- [ ] **Step 3: Server loader** `version-diff.server.ts` (`server-only`, signed-in client, so RLS gates reception and out-of-section staff to nothing):
  - Read `result_amendments` (`id, amendment_seq, amended_at, prior_values_json`) for `result_id`.
  - Read current `result_values` (`parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank`) and the parameter names via `result_template_params(parameter_name)`. Check the FK embed name in `database.ts`.
  - Return `changesPerAmendment(...)`, or `null` on any read error.
- [ ] **Step 4: Component** `result-changes.tsx`: nothing when the list is empty. Otherwise a `<details>` titled "What changed" with one block per correction: "v{from} → v{to} · {manilaDateTime(amendedAt)}". For each change, a row "Name: before → after" plus the flag change when it differs. For `structured === false`: "File replaced; values unchanged." For no changes: "Values unchanged."
- [ ] **Step 5: Wire it.**
  - `queue/[id]/page.tsx`: under the `ClaimHistory` block, for a result with `amendment_count > 0`.
  - Each chemistry report card (`report-cards.tsx`): under `<ClaimHistory>`, fed from the consolidated `page.tsx` (one loader call per report).
- [ ] **Step 6:** `npm test && npm run typecheck && npm run lint` → PASS. Commit (`feat(results): staff "What changed" between result versions`).

---

### Task 17: Archive "Updated" filters (TDD)

**Files:** Create `src/lib/results/updated-filter.ts` (+ test); modify `results/page.tsx`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseUpdatedFilter, updatedSinceIso } from "./updated-filter";

describe("parseUpdatedFilter", () => {
  it.each([["7d", "7d"], ["mine", "mine"], ["x", null], [undefined, null], [["7d"], "7d"]])("%s → %s", (i, o) => {
    expect(parseUpdatedFilter(i as never)).toBe(o);
  });
});
describe("updatedSinceIso", () => {
  it("is exactly 7×24h before now", () => {
    expect(updatedSinceIso(Date.parse("2026-09-25T00:00:00Z"))).toBe("2026-09-18T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Implement**

```ts
export type UpdatedFilter = "7d" | "mine";

export function parseUpdatedFilter(v: string | string[] | undefined): UpdatedFilter | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "7d" || s === "mine" ? s : null;
}

/** Rolling 7×24h on a timestamptz — timezone-independent (CLAUDE.md "rolling window"). */
export function updatedSinceIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export const UPDATED_FILTER_LABEL: Record<UpdatedFilter, string> = {
  "7d": "Updated · last 7 days",
  mine: "Updated by me",
};
```
Run → PASS.

- [ ] **Step 3: Apply it IN the query** (CLAUDE.md: a post-fetch filter breaks paging). In `results/page.tsx`, before the main `test_requests` query:

```ts
const updated = parseUpdatedFilter(sp.updated);
let updatedTestIds: string[] | null = null;
if (updated) {
  let q = staffDb.from("result_amendments").select("result_id").order("result_id");
  q = updated === "7d" ? q.gte("amended_at", updatedSinceIso()) : q.eq("amended_by", session.user_id);
  const { data: am, error: amErr } = await q.limit(1000);
  const resultIds = [...new Set((am ?? []).map((r) => r.result_id))];
  const { data: links } = resultIds.length
    ? await admin.from("result_test_requests").select("test_request_id").in("result_id", resultIds)
    : { data: [] as { test_request_id: string }[] };
  updatedTestIds = amErr ? [] : (links ?? []).map((l) => l.test_request_id);
}
// …then on the main query chain:
if (updatedTestIds) query = query.in("id", updatedTestIds.length ? updatedTestIds : ["00000000-0000-0000-0000-000000000000"]);
```
Surface `amErr` as an in-band "Couldn't apply the Updated filter" line. If `am.length === 1000`, add an in-band "Showing results from the latest 1000 corrections." Ids linked only through `results.test_request_id` (no `result_test_requests` row): also read `admin.from("results").select("test_request_id").in("id", resultIds)` and merge.

- [ ] **Step 4: UI.** Add two chip links next to the status tabs ("Updated · last 7 days", "Updated by me"), toggling `?updated=`. Carry `updated` as a hidden input in the plain-GET filter `<form>`, and carry `sort`/`dir`/`size` on the chips (CLAUDE.md "a plain-GET filter form drops what it does not carry").
- [ ] **Step 5:** `npm test && npm run typecheck && npm run lint` → PASS. Commit (`feat(results): archive filters for recently updated results`).

---

### Task 18: Every-member check on the archive and report-card PDF links

**Files:** Modify `src/lib/results/report-section-gate.ts` (+ test if one exists), `results/page.tsx`, the consolidated `page.tsx` and `report-cards.tsx`.

- [ ] **Step 1: Batch reader** in `report-section-gate.ts`, beside `resultMemberSections`, using the same select it uses:

```ts
/** Member sections for many results at once; null = read failed (deny). Deleted members included. */
export async function resultsMemberSections(
  db: SupabaseClient<Database>,
  resultIds: readonly string[],
): Promise<Map<string, (string | null)[]> | null> {
  const out = new Map<string, (string | null)[]>();
  const ids = [...new Set(resultIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from("result_test_requests")
      .select("result_id, test_requests!inner ( services!inner ( section ) )")
      .in("result_id", ids.slice(i, i + 200));
    if (error) return null;
    for (const r of data ?? []) {
      const list = out.get(r.result_id) ?? [];
      list.push(r.test_requests?.services?.section ?? null);
      out.set(r.result_id, list);
    }
  }
  return out;
}
```
Mirror `resultMemberSections`'s exact embed and its deleted-members rule (it must NOT filter `deleted_at`). If `resultMemberSections` has a unit test with a fake client, add one case for the batch reader.

- [ ] **Step 2: Archive.** For the rows with `pdfTestRequestId`, collect their result ids (add `resultId` to `ArchiveItem` in `archive-fold.ts` if it's absent) and call `resultsMemberSections(admin, ids)`. In `ArchiveItemActions`, render the "PDF →" link only when `sections && membersWithinSections(sectionsForRole(session.role), sections.get(resultId) ?? [])`. Otherwise render `—`. Admin/pathologist (`sectionsForRole` → null) always pass.
- [ ] **Step 3: Report card.** In the consolidated `page.tsx`, compute the same per report and set `canViewPdf` on `ReportCardData`. In `report-cards.tsx` L149, render "View PDF →" only when `rep.canViewPdf`.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` → PASS. Commit (`fix(results): archive and report-card PDF links follow the every-member rule`).

---

### Task 19: Audit Log quick filters + export allowlist (TDD)

**Files:** Modify `src/lib/audit/presets.ts` and `src/lib/portal/export-audit.ts` + `export-audit.test.ts`.

- [ ] **Step 1: Presets.** Append:

```ts
{ label: "Result corrections", action: "result.amended", hint: "Finished results staff corrected, with the reason" },
{ label: "Result follow-ups", action: "result.patient_contacted", hint: "Patients marked contacted about a corrected result" },
```
Run `npx vitest run src/lib/audit/presets.test.ts`. If it fails because `result.patient_contacted` is only emitted from SQL, read how the test finds emitted actions. The `PATIENT_CONTACTED_ACTION` constant in `copy-followups.ts` exists for exactly this, so point the test's scan (or its allowlist) at it, following the test's own mechanism.

- [ ] **Step 2: Export allowlist, failing test first** (add to `export-audit.test.ts`):

```ts
it("keeps known system codes under a reason key, still drops staff text", () => {
  const [a, b] = patientSafeAuditRows([
    { id: 1, action: "visit_pin.issued", actor_type: "staff", created_at: "t", metadata: { reason: "visit_created" } },
    { id: 2, action: "visit.deleted", actor_type: "staff", created_at: "t", metadata: { reason: "Wrong patient, re-entered" } },
  ]);
  expect(a.metadata).toEqual({ reason: "visit_created" });
  expect(b.metadata).toEqual({});
});
it("a system code under a non-reason key is untouched, and a code-like staff note is still dropped", () => {
  const [a] = patientSafeAuditRows([
    { id: 1, action: "x", actor_type: "staff", created_at: "t", metadata: { note: "visit_created!", kind: "manual_reissue" } },
  ]);
  expect(a.metadata).toEqual({ kind: "manual_reissue" });
});
```
Run → FAIL on the first.

- [ ] **Step 3: Implement.** In `export-audit.ts`:

```ts
/** Machine-written codes that may sit under a clinic-only key name. Exact match only. Owner decision 2026-09-25. */
const SYSTEM_CODES: ReadonlySet<string> = new Set(["visit_created", "manual_reissue"]);
```
In `scrub`: `if (CLINIC_ONLY_KEY.test(k)) { if (typeof v === "string" && SYSTEM_CODES.has(v)) out[k] = v; continue; }`. Update the header comment to say codes are kept. Run → PASS.

- [ ] **Step 4:** Commit (`feat(audit,portal): correction quick filters; export keeps system codes`).

---

### Task 20: Docs

**Files:** `.claude/skills/drmed-result-templates/SKILL.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, `.claude/skills/drmed-rls-and-auth/SKILL.md`, `docs/drmed-user-guide.html`, `CLAUDE.md`.

- [ ] **Step 1: Skill `drmed-result-templates`.** Under "Writing a structured result — one path (0172)", add bullets:
  - "0179: removed alerts are withdrawn, not deleted (hunk-generated redefinition, pinned by `result-copy-followups-migration.test.ts`; finalise cleanup still deletes)"
  - the copy-state functions and who may call each
  - the notify claim/record (sent once, never re-sent, no reason)
  - "What changed" (`version-diff.ts`)
  - the stale-print warning (`foldStalePrints`)
  - the archive `?updated=` filter

  Also update the file-list header (the `0172_result_edit_commit.sql ←` line block) with 0179.
- [ ] **Step 2: Skill `drmed-staff-ui`.** Add the `/staff/result-follow-ups` route (reception + admin), the three card ids, and `StalePrintWarning`.
- [ ] **Step 3: Skill `drmed-rls-and-auth`.** Under function ACLs / audit: the 0179 grants table, and that `result.patient_contacted` is audited from SQL.
- [ ] **Step 4: User guide.** Bump to **v2.24** (check `git log origin/main -1 -- docs/drmed-user-guide.html` first; if main moved to v2.24+, take the next number). Add:
  - under **Reception**: "Result follow-ups" (what the list shows, Mark as contacted, the visit chip, the reprint warning)
  - under **Lab & Imaging**: the notify checkbox wording and "What changed"
  - under Critical Alerts: "Withdrawn by a correction"
  - under **Admin**: the dashboard card and the Audit Log quick filters
  - under **For patients**: nothing new, except that a notice may arrive when staff choose to send one

  Update the CLAUDE.md user-guide version line to match.
- [ ] **Step 5: `CLAUDE.md`.** In the migration ledger paragraph, add **0179** (`result_copy_followups`) as "on prod once pushed". In the P-code sentence, add P0068 to the in-use list.
- [ ] **Step 6:** Commit (`docs: result follow-ups — skills, user guide v2.24, CLAUDE.md`).

---

### Task 21: Full verification

- [ ] **Step 1: The whole suite**

```bash
npm test > /tmp/rcf-test.log 2>&1; echo "test $?"; tail -5 /tmp/rcf-test.log
npm run typecheck > /tmp/rcf-tsc.log 2>&1; echo "tsc $?"
npm run lint > /tmp/rcf-lint.log 2>&1; echo "lint $?"
```
Expected: all `0`.

- [ ] **Step 2: Replay proof.** A full `db:reset` on the SHARED stack would destroy other sessions' state. Don't run it. Instead, re-apply 0179 onto the current local DB (Task 4 step 1) and re-run both smokes (Task 4 step 4). Then apply 0179 a second time to prove the column adds fail loudly rather than silently duplicating. **Expected:** error "column … already exists". That is fine: the migration is not meant to be re-runnable.
- [ ] **Step 3: Render smokes.** Run `npm run smoke:results` and `npm run smoke:chemistry` (the latter via `tsx --require ./scripts/lib/server-only-shim.cjs` if the npm script needs it; see memory `drmed-released-chemistry-view`). Expected: pass. Then run `npm run smoke:print` with `APP_BASE=http://localhost:3017` after Step 4's server is up.
- [ ] **Step 4: Click-through on :3017.**
  - Start `next dev -p 3017` from the worktree with its own `.env.development.local` (never `.env.local`).
  - Use throwaway staff users (reception, medtech, admin) and a ZZSMK fixture patient with an email. The recipes are in memory `drmed-released-chemistry-view` / `drmed-result-edit-followups`.
  - Verify with Playwright MCP using text-first checks (`browser_snapshot` / `browser_evaluate`), and screenshot only the final list:
    1. Finalise + release a structured result. As reception, print it. Mint a patient portal session (jose, iss `drmed.ph`) and download it in the portal (click consent first).
    2. As medtech, edit the result. The checkbox shows; tick it. Expect the success line "…could not be sent — they're on Result follow-ups" (`NOTIFICATIONS_LIVE` is off locally, so the send is skipped → failed).
    3. As reception, `/staff/result-follow-ups` lists the patient with "Portal download + printed copy · Send failed — call the patient". The visit page shows the chip and the stale-print warning. Mark as contacted → the row leaves the list. "Show followed-up" shows it as "Contacted by …".
    4. Edit again → the patient is back on the list (a newer correction re-opens it).
    5. As medtech: `/staff/result-follow-ups` → 404. The dashboard shows "Updated (last 7 days)". `/staff/results?updated=7d` lists the result. "What changed" shows the before → after.
    6. A critical value: edit to a critical value (alert pages), then edit back → Critical Alerts shows it under "Withdrawn by a correction", with no acknowledge button.
    7. The patient portal still shows "Result updated" and no reason. The data export ZIP keeps `visit_created` codes and drops staff reasons.
  - Delete all fixtures and throwaway users afterwards (`audit_log.patient_id` FK: delete audit rows first).
- [ ] **Step 5:** Record the results in the PR body. Commit any fixes found (`fix: …`).

---

### Task 22: Reviews, PR, prod, merge

- [ ] **Step 1: Reviews.**
  - Find the real merge base: `git merge-base HEAD origin/main` (never the stale local `main`).
  - Run `/codex-review` at Astra **high** with `--base <that sha>`:
    - `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`
    - no pipe
    - open the report and confirm `Status: Completed` and content before trusting it
  - In parallel, dispatch a **Fable** review subagent (`model: "fable"`) over `git diff <merge-base>...HEAD` with the spec and this plan attached.
  - Fix every real P1/P2 in a follow-up commit, matching existing patterns (user rule 4). Re-run the affected tests.
- [ ] **Step 2: PR.** `git push -u origin feat/result-copy-followups`. Open a PR titled "feat(results): corrected-result follow-ups — out-of-date copies list, opt-in patient notice, stale prints, what changed, withdrawn alerts (0179)". The body contains:
  - what changed (plain English)
  - the migration + P0068
  - the owner decisions
  - the test/smoke/click-through results
  - "0179 must be on prod before merge"
  - ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

  Mark it ready BEFORE any further push (memory: a ready-for-review cancel trap).
- [ ] **Step 3: Prod migration** (Claude runs it; owner authorisation in CLAUDE.md), right before the merge, from this worktree rebased on current `origin/main`:
  - Copy `supabase/.temp/{project-ref,linked-project.json,pooler-url}` from the main checkout.
  - Run `/opt/homebrew/bin/supabase db push --dry-run`. Expect exactly `0179_result_copy_followups.sql`; if the dry run lists another branch's file, stop and ask.
  - Then run `supabase db push` (add `--include-all` only if the dry run says 0179 is out of order).
  - Verify **by object** on prod with MCP `execute_sql` (read-only):
    - the ledger has `0179`
    - `information_schema.columns` shows the 5 + 3 new columns
    - `pg_proc` has the 6 functions
    - `has_function_privilege('authenticated', 'public.result_copy_states_internal(uuid[])', 'execute') = false`
    - `has_function_privilege('authenticated', 'public.result_outdated_copies(boolean)', 'execute') = true`
    - `prosrc` of `result_edit_commit` contains `withdrawn_by_amendment`
- [ ] **Step 4: Merge + deploy.**
  - Merge the PR.
  - Confirm `gh pr view --json state` = MERGED.
  - Confirm the Vercel production deploy for the merge commit succeeded (merge ≠ deploy).
  - Smoke prod read-only: `/staff/result-follow-ups` loads for an admin (empty list expected; prod has 0 corrections).
- [ ] **Step 5: Memory.** Update `drmed-result-copy-followups.md` + the `MEMORY.md` line to MERGED/on prod, with the lessons.
