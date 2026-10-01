# Plan-order lockers audit — design (2026-10-01)

Follow-up to #294 (0211), which found a real 40P01: claim/unclaim locked lines in
plan (heap) order while release/undo lock them in id order. Three other
`test_requests` writers still lock in plan order. This audit proves or disproves
a deadlock (and any lost-update) for each against release / undo / claim /
unclaim, in the `scripts/report-release-concurrency-proof.ts` style:
deterministic forced interleavings read from `pg_locks` (never sleeps), strict
`mustBlockOn` checks, a `--control` mode that runs pre-fix bodies and must fail.

## Global lock order already established (0184 / 0198 / 0211)

patient advisory (shared) → result membership (shared) → **visit row** → **lines
FOR UPDATE ORDER BY id**. release/undo: visit FOR SHARE then member lines +
package header ORDER BY id. claim/unclaim (0211): lines ORDER BY id, no visit
lock. Row lock → shared patient advisory lock inside `a_lifecycle_guard` is a
known, harmless reversal (only delete/restore take it exclusive and they never
take child row locks).

## Hidden lock found while reading (drives most of this)

`guard_test_request_on_waived_visit` (0183, BEFORE UPDATE on test_requests)
takes `visits … FOR UPDATE` whenever a money column changes
(`clinic_fee_php`, `doctor_pf_php`, prices …) or a line is restored. So any
UPDATE that changes a line's fee locks **line → visit**, the reverse of
release/undo's **visit → line**.

## Functions under audit

| fn | migration | how it locks |
|---|---|---|
| `recompute_clinic_fee_for_unreleased()` | 0184 (body 0136) | one UPDATE over every eligible unposted line, ALL patients, plan order; per row the 0183 guard then takes that line's visit FOR UPDATE |
| `fn_queue_delete_cascade()` (AFTER UPDATE OF deleted_at) | 0125 | header row already locked by the outer UPDATE (app: `queue-deletion.ts` PostgREST update), then components `where parent_id = H` in plan order, then `visits` UPDATE (total_php) |
| `fn_release_headers_on_visit_paid()` (AFTER UPDATE on visits) | 0138 | visit row already locked by the payment/HMO update, then ready headers one by one in plan order |

## Scenarios (fresh committed fixtures per scenario, run as the app runs them)

Fixture helpers: copy/adapt `mkFix` / `mkPackage` / actors / `mustBlockOn` /
`storedBefore` from the report-release runner. A physician with
`physician_compensation.clinic_cut_php = 0` makes lines eligible for recompute
(`clinic_fee_php > 0`, no posted test_request JE, active patient).
Recompute runs as `service_role` (its only grant) exactly as
`admin/accounting/physicians-compensation.ts` calls it.

### R — recompute_clinic_fee_for_unreleased

- **R1 recompute vs release, one line** (paid visit, line A ready, eligible).
  W (third session) holds visit V `FOR SHARE`. Recompute starts: locks A, the
  0183 guard waits for V FOR UPDATE (`mustBlockOn` V). Release(A) starts: gets V
  FOR SHARE (compatible with W) and must then block on A (held by recompute).
  W commits. Correct outcome: both finish (one after the other), no 40P01; and
  R2's invariant holds. Pre-fix expectation: 40P01.
- **R2 lost update on a posted line.** Release(A) commits its release + posted
  JE while recompute (snapshot taken before that commit) is queued on A.
  Invariant: a line that has a posted `test_request` JE must never have its
  `clinic_fee_php` / `doctor_pf_php` changed by recompute (compare against the
  values the release JE booked / the pre-release row). Pre-fix expectation:
  recompute's materialised target set still names A, EPQ re-check passes, fee
  zeroed on a posted line → FAIL. Run both orders (release holds first; recompute
  holds first → release must then see the recomputed fee and post that).
- **R3 recompute vs claim, plan order** (unpaid or paid visit, lines A < B by
  id, both `requested`, eligible; B stored physically BEFORE A, recompute forced
  onto a seq scan). W holds A. Claim(A,B) queues on A. Recompute locks B (+ V),
  then queues on A behind claim. W commits → claim gets A, wants B. Pre-fix
  expectation: 40P01. Same for unclaim (lines in_progress, held by the claimer).
- **R4 recompute vs undo** (optional if a fixture is cheap): only reachable via a
  released line with NO posted JE (legacy-import provenance, 0159's early
  return). If cheap, the R1 shape against undo; otherwise document why it is
  unreachable.
- **R5 two visits** — recompute over lines in visits V1, V2 vs a release on V2
  while recompute holds V1's lines: must not deadlock (proves the fix's visit
  ordering), only meaningful post-fix.

### Q — package header soft-delete cascade (fn_queue_delete_cascade)

Unpaid visit (delete needs unpaid, P0042), header H + components X1 < X2 by id,
X2 stored physically before X1, components `requested`. The delete is the app's
exact statement (`src/lib/actions/visits/queue-deletion.ts` ~L77) issued as an
authenticated admin/reception session (RLS applies).

- **Q1 header delete vs claim of the components.** W holds X1. Claim(X1,X2)
  queues on X1 (holds nothing). Delete(H): H locked, cascade locks X2 (plan
  order) and queues on X1. W commits → claim gets X1, wants X2. Pre-fix: 40P01.
- **Q2** the same against unclaim (components in_progress).
- **Q3 header delete vs release/undo** (HMO visit so release is allowed on an
  unpaid visit): release/undo lock H inside their id-ordered set and take the
  visit FOR SHARE first, while the delete's cascade later UPDATEs the visit
  (line → visit). This is the KNOWN ACCEPTED cycle (memory: "HMO line soft-delete
  vs release of same visit → 40P01, release side retries"). Observe and REPORT
  ONLY (do not count as a failure); state whether an id-ordered component
  pre-lock changes it.
- **Q4 header restore vs claim**: claim/unclaim predicates require
  `deleted_at is null`, so deleted components are never in their lock set —
  one quick scenario proving restore and claim do not wait on each other.
- **Q5 (observe only) bulk line delete vs claim**: `src/lib/actions/queue/bulk-delete-core.ts`
  ~L93 bulk UPDATE `.in('id', ids)` of two plain lines stored in reverse heap
  order, W/claim shape as Q1. Report what happens; do not fix in this PR.

### P — fn_release_headers_on_visit_paid

Visit with two package headers H1, H2 (H2 stored before H1, H1 < H2 by id),
each `ready_for_release` with all components released, visit unpaid (a voided
payment). The flip is the app's payment insert (service role, exact SQL) whose
recalc sets payment_status = paid → trigger releases H1, H2.

- **P1 payment flip vs undo of a component of H1**, both orders: they serialise
  on the visit row (undo FOR SHARE vs recalc FOR UPDATE); no 40P01; final state
  consistent (header released iff all its components released).
- **P2 payment flip vs claim / unclaim** on another (requested) line of the same
  visit: no shared rows, must not wait.
- **P3 payment flip vs recompute** (headers/components eligible for recompute):
  pre-fix this is R1's cycle again via the headers; post-fix must pass.
Expected: P1/P2 pass on the current code → report-only (no fix).

## Fix (only for what the proof shows is real) - SHIPPED IN TWO PRs

Phase 1 results (today's bodies): R1-R5 and P3 deadlock or lose an update; Q1/Q2/Q3/Q5 deadlock;
P1/P2/Q4 are clean (report-only, no fix).

### PR 3a - recompute (migration 0215, branch fix/plan-order-lockers)

1. **recompute_clinic_fee_for_unreleased** - same signature/ACL:
   (a) collect candidate line ids + their visit ids (no lock);
   (b) `perform 1 from visits where id = any(v_visits) order by id for update`
       (FOR UPDATE, the mode the 0183 guard re-takes, so no lock upgrade);
   (c) `perform 1 from test_requests where id = any(v_lines) order by id for update`;
   (d) the UPDATE restricted to `id = any(v_lines)` AND the full eligibility
       predicate re-evaluated in the new statement (READ COMMITTED: fresh
       snapshot after the waits, so a line released + posted meanwhile drops
       out - fixes R2a). Lines that only became eligible after (a) wait for the
       next run (an on-demand scrub). The 0184 active-patient filter is kept.
   Controls: mutants M1 (pre-fix body), M2 (no visit pre-lock), M3 (no line
   pre-lock), M4 (no predicate re-check) are each caught; B0 passes.

### PR 3b - package header delete / restore (later, new branch)

Q3 showed a TRIGGER cannot fix the cascade: release/undo lock x1 then H, while a
header delete holds H (the UPDATE target) before its AFTER trigger reaches any
component, so an id-ordered component pre-lock inside fn_queue_delete_cascade
still cycles (Q3b reproduces it with the pre-lock done by hand). The fix is
therefore an RPC that takes the locks itself in the global order - visit, then
the header and its components ORDER BY id - and then performs the soft delete /
restore, with the app calling it instead of the bare UPDATE. It closes Q1, Q2,
Q3 and (for the lines it covers) Q5. Until then the runner prints those as
KNOWN - fixed by PR 3b.

Nothing for fn_release_headers_on_visit_paid: P1/P2 pass, and P3 is closed by 3a.

Register every proven function in `src/lib/db/concurrency-proof-guard.test.ts`
REGISTRY with `concurrency-proof: <fn>` annotations in the runner (the guard
only auto-detects explicit locks; the fixed bodies will now contain FOR UPDATE
and therefore be detected — they MUST be registered).

## Control (`--control`)

Each fix gets a mutant that restores the pre-fix body (in a mutant schema, or
for trigger functions by swapping the trigger's function inside the scenario's
own setup and restoring it in teardown — follow how
`scripts/waiver-concurrency-proof.ts` controls a trigger function). B0 = run the
scenarios against the pre-fix bodies: R1/R2/R3/Q1/Q2 must FAIL in control and
PASS normally. Print `N/N` per mode like the other runners.

## Rules

Local stack only (assert 127.0.0.1); never `db reset`; never touch rows named
`Bsqfixture`; every fixture uniquely tagged and deleted in teardown (normal end,
failure, SIGINT/SIGTERM); restore any setting the runner flips.
