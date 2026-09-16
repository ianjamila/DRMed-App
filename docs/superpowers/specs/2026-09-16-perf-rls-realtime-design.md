# Performance: RLS InitPlan hoisting + realtime channel churn

**Date:** 2026-09-16
**Branch:** `perf/rls-initplan-realtime`
**Migration:** `0150_rls_initplan_and_policy_consolidation.sql`
**Status:** design approved, pending spec review

---

## 1. Summary

The DRMed staff app is slow for two reasons, both overhead, neither data volume.

1. **Row-level security calls a database function once per row.** 130 of 160 policies
   invoke `has_role()` unwrapped. Postgres cannot hoist a bare function call out of a
   policy qual, so it runs per row. `has_role()` is `SECURITY DEFINER` and does an index
   lookup on `staff_profiles` on every call.
2. **A React dependency-array bug tears down and rebuilds every realtime channel on
   every render.** This burns 85.4% of all production database CPU.

Neither fix changes what any user can see. Both are mechanical.

---

## 2. Measured baseline

All figures read from production (`qhptbmafrosgibooelpp`) on 2026-09-16 via
`pg_stat_statements` and `pg_stat_user_tables`. These are the numbers the change is
scored against.

### 2.1 Table sizes — the data is not the problem

| Table | Rows | Size |
|---|---:|---:|
| `journal_lines` | 50,679 | 10 MB |
| `test_requests` | 25,604 | 12 MB |
| `journal_entries` | 22,432 | 9.5 MB |
| `visits` | 14,267 | 9.8 MB |
| `payments` | 7,697 | 3.1 MB |
| `patients` | 7,060 | 15 MB |

The largest table in the system is 50k rows. Nothing here justifies a multi-second query.

### 2.2 Slow application queries

| Query | Calls | Mean | Max |
|---|---:|---:|---:|
| `visits_classification_summary` RPC | 43 | **2,733 ms** | 7,571 ms |
| Visits list (PostgREST) | 39 | 1,850 ms | 6,103 ms |
| `v_patients_directory` | 24 | 833 ms | 1,093 ms |
| Visits (second shape) | 18 | 1,112 ms | 2,198 ms |
| Patients (three shapes) | 174 / 121 / 82 | 355 / 468 / 595 ms | 1,746 ms |

### 2.3 Database CPU distribution

| Consumer | Total time | Calls | Share |
|---|---:|---:|---:|
| Realtime WAL filter (query A) | 5,224,990 ms | 546,362 | **43.4%** |
| Realtime WAL filter (query B) | 5,049,996 ms | 753,963 | **42.0%** |
| `SELECT name FROM pg_timezone_names` | 230,895 ms | 682 | 1.9% |
| Everything else | — | — | 12.7% |

Realtime consumes **10.27 million ms — roughly 2.85 hours of database time — across 1.3
million calls**, with individual calls peaking at 14.5 seconds.

### 2.4 Advisor findings

`unindexed_foreign_keys` 126 (INFO) · `unused_index` 46 (INFO) ·
`multiple_permissive_policies` 47 (WARN) · `auth_rls_initplan` 10 (WARN) ·
`auth_db_connections_absolute` 1 (INFO).

Note the advisor's `auth_rls_initplan` count of 10 **understates the problem by an order
of magnitude**. It only detects direct `auth.*()` and `current_setting()` calls. It cannot
see that `has_role()` wraps `auth.uid()` one level down, so the 130 policies that call
`has_role()` per row are invisible to it. This is the single most important finding in
this document and it is not in any advisor output.

---

## 3. Root causes

### 3.1 Per-row RLS function evaluation

```sql
CREATE OR REPLACE FUNCTION public.has_role(roles text[])
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  select exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and is_active = true and role = any(roles)
  );
$$;
```

`STABLE` guarantees the result will not change within a statement. It does **not** instruct
the planner to evaluate the call once. Only wrapping the call in a scalar subquery —
`(select has_role(...))` — turns it into an InitPlan, computed a single time per query.

Written bare in a policy `USING` clause, it is a per-row filter. For a staff user reading
`test_requests`, each of the 25,604 rows evaluates:

- `has_role(...)` from `test_requests: staff select`
- `has_role(...)` from `test_requests: reception/admin write` (an `ALL` policy, so it
  applies to `SELECT` too)
- `current_patient_id()` and a correlated `visit_id IN (SELECT ... FROM visits)` subquery
  from `test_requests: patient own visits` — a policy a staff user can never satisfy

That is roughly 75,000–100,000 `staff_profiles` index lookups plus 25,604 correlated
subqueries for one page load. It is the entire explanation for 2,733 ms on a 12 MB table.

Inventory across the whole database:

| Pattern | Policies affected |
|---|---:|
| Bare `has_role(...)` | 130 |
| Bare `auth.uid()` / `auth.jwt()` / `auth.role()` | 10 |
| Bare `current_patient_id()` | 8 |
| **Total policies** | **160 across 91 tables** |

### 3.2 Realtime channel churn

`src/components/staff/realtime-refresher.tsx`:

```tsx
const channel = supabase.channel(
  `${channelName}-${Math.random().toString(36).slice(2)}`,   // line 76
);
// ...
}, [supabase, router, subscriptions, debounceMs, channelName]);   // line 95
```

`subscriptions` sits in the dependency array, and all six call sites pass an inline array
literal:

```tsx
subscriptions={[{ table: "visits", event: "UPDATE" }, ...]}   // new identity every render
```

The failure loop:

1. A subscribed table changes; the channel fires.
2. `scheduleRefresh()` calls `router.refresh()`.
3. The RSC payload re-renders the client component with a **new** array literal.
4. The dependency comparison fails; the effect tears down and re-runs.
5. `removeChannel` + `supabase.channel()` under a **new random name** — a brand-new
   subscription the realtime server must register and RLS-check from scratch.

The refresh is triggered by the subscription that the refresh destroys and rebuilds. The
random channel-name suffix on line 76 is a workaround for a re-mount crash that is itself
a symptom of this churn — with stable dependencies, the re-mounts stop.

Call sites (all six pass inline literals):

- `src/app/(staff)/staff/(dashboard)/appointments/page.tsx:498`
- `src/app/(staff)/staff/(dashboard)/visits/queue/page.tsx:236`
- `src/app/(staff)/staff/(dashboard)/queue/page.tsx:498`
- `src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:531`
- `src/app/(staff)/staff/(dashboard)/_dashboards/reception-dashboard.tsx:610`
- `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx:732` (poll-only,
  `subscriptions={[]}`)

Published tables: `appointments`, `critical_alerts`, `payments`, `test_requests`, `visits`.
`test_requests` alone took 25,567 inserts in the sampled window, and every insert is
RLS-evaluated against every live subscription.

---

## 4. Scope

Four phases in one PR. **Phase 2 is separable and should be dropped if there is any
hesitation** — see §4.2 and §7.

### 4.1 Phase 1 — InitPlan hoisting (semantically inert)

Wrap every bare call site in a scalar subquery.

The §3.1 figures (130 / 10 / 8) count **policies matching each pattern**, not call sites.
A single policy may contain several calls, and a policy may match more than one pattern, so
those figures neither sum nor equal the number of edits. The generator's contract is defined
by the idempotence check in this section, not by a target count: rewrite every match, then
prove zero matches remain.

```sql
-- before
using (has_role(ARRAY['reception','medtech','pathologist','admin','xray_technician']))
-- after
using ((select has_role(ARRAY['reception','medtech','pathologist','admin','xray_technician'])))
```

**This cannot change row visibility.** Both functions are `STABLE`; a scalar subquery over a
`STABLE` function returns the identical value it would have returned per row. The only
difference is how many times Postgres computes it.

**Generated, not hand-written.** 130 hand edits is an unacceptable error surface. A script
at `scripts/generate-rls-initplan-migration.ts` reads live definitions from `pg_policies`,
rewrites only the call sites, and emits **static, readable `CREATE POLICY` DDL** into the
migration file. The generator runs once at authoring time and is **not** part of the
migration — the committed artifact is plain DDL that a reviewer reads line by line.

Generator requirements:

- Reproduce `DROP POLICY` + `CREATE POLICY` per policy, preserving name, table, `cmd`,
  `roles`, `permissive`, `qual` and `with_check` exactly apart from the wrapping.
- Rewrite only identifiers matching `has_role(`, `current_patient_id(`, `auth.uid(`,
  `auth.jwt(`, `auth.role(` that are **not already** preceded by `select `.
- Must be idempotent: running it against the post-migration database emits zero changes.
- Emit in deterministic order (table, then policy name) so the diff is reviewable and
  regenerating produces no spurious churn.

### 4.2 Phase 2 — Permissive policy consolidation (semantically load-bearing)

The advisor reports 47, but that counts each policy × role × action combination. There are
**9 genuine consolidation targets**, every one the same shape: a patient/public read policy
OR'd with a staff read policy.

| Table | Policies |
|---|---|
| `appointment_attachments` | patient self + staff read |
| `hmo_providers` | public read active + staff read all |
| `physicians` | public read active + staff read all |
| `report_groups` | public read active + staff read |
| `result_test_requests` | patient released only + staff read |
| `results` | patient released only + staff select |
| `services` | public read active + staff read |
| `staff_profiles` | self select + staff read |
| `test_requests` | patient own visits + staff select |

Consolidation merges each pair into one policy with the staff check **first**, so the
expensive patient subquery short-circuits for staff sessions.

**Hard constraint:** several of these pairs have *different role lists* — e.g.
`services: public read active` is `{anon, authenticated}` while `services: staff read` is
`{authenticated}`. Policies with differing role lists **must not** be naively merged. Either
keep them separate or merge to the union role list only after proving the added role sees
no additional rows (for `anon`, `has_role()` is false because `auth.uid()` is null — but
this must be *proved by the harness*, not reasoned about).

### 4.3 Phase 3 — Realtime churn

In `realtime-refresher.tsx`:

- Accept the subscription list by stable identity. Either hoist each call site's array to a
  module-level `const`, or key the effect on a serialized form
  (`JSON.stringify(subscriptions)`) rather than array identity. Prefer module-level consts —
  explicit, and it makes the stability requirement visible at the call site.
- Remove the `Math.random()` channel-name suffix; use the stable `channelName`.
- Gate `router.refresh()` on `document.visibilityState === "visible"`, and refresh once on
  `visibilitychange` back to visible so a backgrounded tab catches up without polling.

Apply the stable-identity change at all six call sites.

### 4.4 Phase 4 — Index hygiene (deliberately trimmed)

**Do not add all 126 foreign-key indexes.** On a database whose largest table is 10 MB they
would cost write throughput and buy nothing measurable; the advisor rates them INFO for
exactly this reason. Add a foreign-key index only where a hot query in §2.2 or a cascading
delete actually needs one — expect 5–10, each justified in a SQL comment naming the query
it serves.

Drop unused indexes only where `idx_scan = 0` **and** the index predates 2026-06-16 (90
days). A recently added index with zero scans is more likely feature work that has not
shipped than dead weight.

### 4.5 Non-goals

- `pg_timezone_names` (682 calls × 339 ms = 231 s). Not application code — Supabase Auth
  and Studio. Record it; do not chase it.
- PostgREST schema-cache rebuilds (683 × ~165 ms). Symptom of connection churn, out of
  scope.
- `auth_db_connections_absolute`. A Supabase dashboard setting, not a code change.
- The consent report aggregation. Owned by another session on `0151`.
- Row-cap defects. Owned by `jamila-8e`'s cap audit — see §7.3.

---

## 5. Verification

The single-PR shape is only defensible because of this section. Row visibility is the thing
that must not change, so it is proved rather than argued.

### 5.1 Row-visibility equivalence proof

For every RLS'd table × every principal, record both an exact count and a content
checksum, before and after the migration:

```sql
select count(*)                                    as visible_rows,
       md5(string_agg(id::text, ',' order by id))  as row_fingerprint
from <table>;
```

Principals — **`anon` is mandatory, not optional**:

| Principal | Why |
|---|---|
| `anon` | This app has shipped two live anon-readable exposures before (2026-09-10: 292 patients via `v_hmo_*`, 20 doctors' pay terms via `physicians`). Non-negotiable. |
| patient (via `current_patient_id`) | Portal surface |
| `reception` | Largest staff surface |
| `medtech` | Lab surface |
| `pathologist` | Sign-off surface |
| `xray_technician` | Narrowest staff role — catches over-broad grants |
| `admin` | Should see everything; catches under-broad grants |

**Any difference in either column, for any table × principal pair, fails the build.**

Two requirements that are easy to get wrong:

1. **Count in SQL, never in the client.** Compare `count(*)` from the database, not the
   `.length` of a fetched array. A client fetch carries an implicit 1,000-row cap, which
   would make a truncated *before* and a truncated *after* look identical and pass a
   broken migration. (Credit: `jamila-8e`, whose cap audit found exactly this class of
   silent truncation in the payroll loaders.)
2. **Run it on a local stack with a prod-shaped fixture, never against production.**
   `CREATE POLICY` takes `ACCESS EXCLUSIVE` on its table; running this against production
   would lock 91 tables and stop the clinic. The local stack runs on OrbStack.

### 5.2 Control test

Deliberately break one policy — narrow `visits: staff full` to a single role — and confirm
the harness **fails**. A green harness must mean the harness works, not that it is asleep.
This is the pattern that caught defects two static reviews missed on the go-live batch.

### 5.3 Static assertions

- A test asserting `pg_policies` contains **zero** bare `has_role(` / `current_patient_id(` /
  `auth.uid(` / `auth.jwt(` / `auth.role(` in `qual` or `with_check`. This is the regression
  guard: it fails the day someone adds policy #161 the old way.
- Re-running the generator against the migrated database produces an empty diff.
- `supabase/tests/0150_rls_initplan_smoke.sql`, following the existing smoke convention.

### 5.4 Scorecard

Re-run the `pg_stat_statements` query from §2 against production after deploy. Note
`pg_stat_statements` accumulates since last reset, so compare **means**, not totals, or
reset the view at deploy time and compare a clean window.

| Metric | Before | Target |
|---|---:|---|
| `visits_classification_summary` mean | 2,733 ms | < 150 ms |
| Visits list mean | 1,850 ms | < 200 ms |
| `v_patients_directory` mean | 833 ms | < 150 ms |
| Realtime share of DB time | 85.4% | < 20% |
| Realtime calls per hour | ~1.3M / window | order of magnitude lower |

---

## 6. Rollout

1. Generate and review `0150`. Confirm the number is still free across **every** branch
   immediately before push — `ls supabase/migrations` in this worktree cannot see a number
   claimed by an unmerged sibling. A duplicate number makes `supabase db push` skip the file
   and exit 0 reporting "up to date", applying nothing.
2. Local stack: `db reset`, seed fixture, run equivalence proof + control test.
3. Typecheck, lint, `vitest run`.
4. Review, merge, `db push`. **Verify objects, not the summary line** — query `pg_policies`
   and confirm the wrapped form is live.
5. Re-measure §5.4 and record results in this file.

**Deploy window:** the migration takes `ACCESS EXCLUSIVE` on 91 tables. Each lock is brief
(a policy swap, no table rewrite), but it should land outside clinic hours.

---

## 7. Risks

### 7.1 Wide DDL surface

91 tables of RLS DDL in one migration. Mitigated by: Phase 1 being provably inert, the
equivalence proof covering `anon`, and the control test proving the proof works. The user
approved this scope explicitly with the blast radius stated.

### 7.2 Phase 2 is the only part that can change behaviour — recommend dropping it

Phase 1 changes *when* a function is evaluated. Phase 2 changes *what the policy says*. Only
one of those can leak data.

After Phase 1, a second stacked policy costs one additional InitPlan per query — not per
row. On a 12 MB database that is unmeasurable. **Phase 2's performance benefit rounds to
zero, while carrying all of this PR's security risk.**

Recommendation: ship Phases 1, 3 and 4; move Phase 2 to a follow-up where it can be
reviewed on its own merits. It is structured as a separable phase precisely so it can be
dropped without touching anything else.

### 7.3 Speed can unmask row-cap bugs

A list that currently times out or returns short may, once fast, return enough rows to hit
an implicit 1,000-row cap — turning a visibly broken number into a plausible wrong one. If
`jamila-8e`'s cap audit lands close in time, **merge it first**. Post-deploy, spot-check any
headline tile whose value is derived from a fetched array rather than a SQL aggregate.

### 7.4 Concurrent branches

`jamila-8e` has confined its cap audit to data-loading code and will not touch
`realtime-refresher.tsx`, the `RealtimeRefresher` element, its `subscriptions` array, or any
`useEffect` dependency array in the six shared files. It will report which of the six it
touched. `feat/tier-d-payroll-sorting` adds `src/components/staff/use-list-table.tsx` and
edits `list-pagination.tsx` — same directory, different files, no conflict.

---

## 8. Open questions

1. Ship Phase 2, or defer it per §7.2? **Recommendation: defer.**
2. Confirm the deploy window for the `ACCESS EXCLUSIVE` migration.
