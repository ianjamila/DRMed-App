// Hand-run local CONCURRENCY proof for the panel Undo functions
// (supabase/migrations/0200_panel_undo_all_or_nothing.sql, P0082):
// reclaim_panel_members (Undo of a bulk Unclaim, `authenticated`) and
// restore_panel_members (Undo of a bulk Delete, `service_role`).
//
// supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql proves every refusal
// one statement after another inside one transaction. This runner proves the
// same functions when two sessions act on the same panel AT THE SAME MOMENT:
// separate `pg` connections, each acting as `authenticated` with its own JWT
// `sub` (invoker rights, so RLS and 0190's holder guard apply exactly as for
// the staff server client) or as `service_role` (the queue restore's admin
// client), issuing each competing write exactly as the app does.
//
// DETERMINISTIC, NOT LUCKY. Every forced scenario holds one side's row locks in
// an open transaction (or behind an outside `for update` gate), starts the
// other side, and does not move on until pg_locks shows that backend waiting on
// a ROW lock (or, for the "must not wait" cases, until it has answered while
// the first side is still open). If the intended interleaving is not reached
// the scenario FAILS - it never silently degrades into a sequential run. Only
// section F (free races) relies on timing, and it asserts the invariants alone.
//
// PROD PLAN SHAPES (read-only EXPLAIN on prod, 2026-09-30, literal arrays)
//   pre-lock select : LockRows -> Index Scan using test_requests_pkey
//                     (id = ANY(...))                      - id order
//   reclaim UPDATE  : Update -> Nested Loop -> Hash Join (t.id = x.id)
//                       [outer: Index Scan using idx_test_requests_status
//                        (status = 'requested'), Filter assigned_to / deleted_at
//                        null; inner: Hash of Function Scan on x]
//                       -> Index Scan using visits_pkey
//   restore UPDATE  : Update -> Merge Join (t.deleted_at = x.deleted_at),
//                       Join Filter x.id = t.id
//                       [Index Scan using test_requests_deleted_idx, Filter
//                        parent_id null and visit_id; Sort x.deleted_at <-
//                        Function Scan on x]
// Both UPDATEs are table-driven on prod (not driven by the caller's array).
//
// TWO PLAN MODES. Every forced scenario runs in both:
//   seq      the local default. The stack holds a handful of rows, so the
//            reclaim UPDATE is Hash Join over a Seq Scan (heap order) and the
//            restore UPDATE a Hash Join probing in array order.
//   indexed  `set local enable_seqscan / enable_bitmapscan = off` in every
//            actor's transaction, and the join method FORCED per role (see
//            gucsFor): the staff reclaim gets nested loops + merge joins off, the
//            service_role panel restore nested loops + hash joins off. Left to
//            the planner a few-row local table flips from run to run (heap bloat
//            and statistics decide), so the shapes are forced and then ASSERTED
//            at startup (a failing result row if either is not reproduced):
//              reclaim UPDATE  Hash Join (t.id = x.id) [Index Scan using
//                              idx_test_requests_status; Hash <- Function Scan
//                              x] under a Hash Join to visits_pkey - the prod
//                              plan's table-driven core; prod nests the visits
//                              lookup as a Nested Loop, which only reads the
//                              visits row and does not touch the lock order
//              restore UPDATE  Merge Join (t.deleted_at = x.deleted_at) over
//                              test_requests_deleted_idx + Sort x.deleted_at
//              reclaim pre-lock  the test_requests_pkey Index Scan
//            VACUUM (ANALYZE) of the two tables runs after seeding, so the
//            statistics match the data the run really has.
// Plans are taken AS THE ROLE THE CALL RUNS UNDER. The staff session's plan
// carries the RLS policy's own InitPlans/SubPlans, and planning as postgres
// (which an earlier version of this runner did) picked a different join order
// than the function really runs - the control-E result below was then not
// reproducible. Both plans are printed at startup, and the pre-lock of each
// function is checked to be LockRows over an id-ordered input.
//
// WHY THE PRE-LOCK MATTERS (and what this proof can and cannot show). Both
// functions first lock their member rows FOR NO KEY UPDATE in id order - the
// order 0198's release_visit_results / undo_visit_release lock a visit's
// test_requests - so the UPDATE afterwards only ever touches rows this
// transaction already holds. Mutant E drops that pre-lock from reclaim and the
// control round reports, per mode, which scenarios then fail (see CONTROL).
//
// SELF-CHECKS at startup: the four probe statements (the two UPDATEs and the two
// pre-lock selects) are hand-copied from 0200 and are compared with the live
// pg_get_functiondef text - a drift refuses the run - and indexed mode ASSERTS
// that it reproduces prod's two plan shapes (a failing result row otherwise).
//
// NOT PROVEN SEPARATELY: a MULTI-member queue Delete (deleteTestRequestsForVisit
// with several ids) racing a reclaim. Its UPDATE visits rows in whatever order
// its plan gives (pkey-ordered on prod, so id order, which is the pre-lock's
// order); only single-member deletes (R4) and the three-way claim race (F1) are
// exercised against a reclaim here.
//
// FIXTURES. Two connections cannot see each other's uncommitted rows, so the
// fixtures are COMMITTED: four staff (auth.users + staff_profiles: admin A1,
// medtechs M1 M2 M3), one report group with three chemistry services (priced,
// so a delete/restore of a member also updates its visit's total - the line ->
// visit lock order of fn_queue_delete_cascade is part of what is proven), one
// patient, three UNPAID visits P, Q, R of three priced tests each, and - per
// scenario that involves a release - a fresh PAID visit W (a ready test X with
// its own linked result, a payment, and a three-member panel). Every row
// carries a per-run tag (`puc-<hex>` / `PUC-<HEX>`); stale rows from a crashed
// run are swept before seeding, and the `finally` deletes everything (and the
// journal entries the payment/release bridges posted) and proves nothing
// tagged is left. It never touches rows it did not mint (the shared local
// stack also holds other sessions' fixtures).
//
// Run (local stack, 0198 + 0200 applied):
//   npm run panel-undo:concurrency-proof               # 2 modes, 25 free rounds
//   npm run panel-undo:concurrency-proof -- --control  # + control rounds
//   PUC_ROUNDS=100 npm run panel-undo:concurrency-proof
//   PUC_ONLY='R9|R10' / PUC_MUTANTS=E,A ... narrow a run while debugging
//
// SCENARIOS (forced ones run in both modes)
//   R1  a single claim of the LAST member commits first, reclaim queued: the
//       reclaim is seen holding the two earlier members while blocked, then
//       P0082; the other two stay requested/unassigned, the claimed one stays
//       under the claimer.
//   R2  the single claim rolls back: reclaim lands whole, each member under
//       ITS OWN holder at ITS OWN started_at.
//   R3  reclaim first, claim_panel_members queued: P0077, panel whole under the
//       reclaimed holders.
//   R4  queue delete of one member first, reclaim queued: P0082, nothing put
//       back.
//   R5  two reclaims of one panel (double Undo click), released together from
//       behind a gate: exactly one lands, the other P0082.
//   R6  reclaim P+Q vs reclaim Q+P (opposite member order), released together:
//       no 40P01; exactly one wins, both panels whole.
//   R7  release_visit_results of [ready test X + the panel members] on the same
//       visit holds its locks first (X released, members refused not_ready);
//       reclaim queued behind the member rows, then lands whole.
//   R8  reclaim holds first; the same release queued behind it, then completes.
//   R9  lock-order race, release first: the release is caught mid-lock (holds
//       the lowest member, waits on a gated middle one), the reclaim queues
//       behind it; both complete, no 40P01. The plan order of the reclaim's
//       UPDATE is first ARRANGED to run opposite to id order (heap order made
//       the reverse of id order; array sent descending), so a reclaim that
//       locked in plan order would deadlock here (mutant E).
//   R10 the same, reclaim first (caught mid-lock), release queued.
//   R11 a release of a DIFFERENT test on the same visit does not block a
//       reclaim (the reclaim takes no visit lock and the release no member
//       row): mustNotWait. R12 the reverse: reclaim open, release must not
//       wait. (These pin that the orderings above do not serialise unrelated
//       work on a visit.)
//   R13 defence in depth: a member moved out of `requested` WITHOUT a holder
//       (status `cancelled`; no app path writes that today) commits first:
//       reclaim P0082. Only the status predicate catches it (mutant B).
//   S1  manual Restore of one member commits first, panel restore queued:
//       P0082, the other two still deleted at their original deleted_at.
//   S2  manual Restore rolls back: panel restore lands whole.
//   S3  two panel restores released together: one lands, the other P0082.
//   S4  restore-then-re-delete of one member (new deleted_at) commits first:
//       P0082 (the exact deleted_at predicate), nothing restored.
//   S5  visit soft-delete commits first: P0082 with the visit message.
//   S6a release_visit_results (of a different test) holds first; restore waits
//       on the VISIT row and lands whole. S6b restore holds first; the release
//       waits on the visit row and completes. Neither order yields 40P01 (both
//       take the visit first).
//   S8  lock-order race, restore first (caught mid-lock on a gated middle
//       member, holding the visit and the lowest member), a release whose
//       selection is the panel members queued: both complete, no 40P01.
//       S9 the same with the release first. (The second caller is stopped at the
//       visit before it holds any member row; mutant F removes exactly that.)
//   S7  manual Restore first (holding the visit, queued on a gated member), panel
//       restore queued: it must wait at the VISIT row, never on a member; no
//       40P01, the manual Restore lands, the panel restore is refused P0082 with
//       nothing restored by it. S7b the same with the panel restore first: the
//       manual Restore waits at the visit, the panel lands whole, the manual
//       Restore then matches nothing. Until 0216 this was a documented FINDING -
//       the bare manual Restore UPDATE locked the line and THEN the visit (0183's
//       waived-visit guard), the reverse of restore_panel_members, and the cycle
//       ended one side 40P01. Since 0216 both go through
//       restore_test_request_lines / restore_panel_members: patient (shared) ->
//       visit FOR UPDATE -> lines ORDER BY id, so the cycle cannot form.
//   F1  PUC_ROUNDS free rounds: reclaim vs a three-way single-claim race on one
//       panel - never split.
//   F2  PUC_ROUNDS free rounds: panel restore vs a manual Restore of a random
//       member - the panel is either fully restored or refused (P0082) with no
//       member restored by the panel call. Since 0216 any 40P01, or any manual
//       Restore error, fails the round.
//
// CONTROL ROUNDS (--control) prove the proof can fail: each copies the two live
// functions into a throwaway schema (puc_ctl_<hex>, never public - the stack is
// shared) with ONE guard removed, reruns the forced scenarios against the copy
// and passes only if the named scenarios FAIL in both modes FOR THE EXPECTED
// REASON (a regex over the failure text: "expected P0082, but it succeeded" for
// the dropped row-count / predicate guards, a member-row wait or a real 40P01
// for the dropped visit lock). A scenario that fails because its interleaving was not reached,
// a wait never happened or a statement timed out is infrastructure: it counts as
// NOT caught and fails the round, as does any such failure elsewhere in it.
//   A drops reclaim's row-count check          -> R1, R4, R13 must fail
//   B drops reclaim's `status = 'requested'`   -> R13 must fail. (The plan named
//     R3/R5; they cannot discriminate: `assigned_to is null` already refuses a
//     member someone claimed, so the status predicate is redundant for every
//     race. R13 is the only state it alone refuses.)
//   C drops restore's row-count check          -> S1, S4 must fail
//   D drops restore's deleted_at predicate     -> S4 must fail
//   F turns restore's visit FOR UPDATE into a plain read -> S1, S5, S7, S7b, S8
//     must fail. (S1/S7/S7b: the second caller is no longer stopped at the visit
//     and waits on a member row instead; S5: a visit soft-delete committing
//     first is no longer serialised behind the visit lock, so the panel restore
//     succeeds against a deleted visit; S8: the release holds the visit FOR
//     SHARE and waits for a member the restore holds while the restore's
//     trigger waits for the visit: a real 40P01.) RESULT (this stack,
//     2026-10-02): caught by all five, in both modes. S6a/S6b do NOT
//     discriminate F: the restore's BEFORE trigger (0183's waived-visit guard)
//     takes the visit FOR UPDATE on every restored line anyway, so a restore
//     queues at the visit with or without its own lock.
//   E drops reclaim's id-ordered pre-lock      -> INFORMATIONAL, reported per mode.
//     RESULT (this stack, 2026-10-01, three --control runs with the forced
//     indexed plans, identical each time): R9 and R10 caught it as a real
//     40P01 deadlock in BOTH modes; R1 also tripped in both, but only through
//     its own "the id-ordered pre-lock is not in effect (held 1/2 earlier
//     members)" observation - a check of the lock, not an outcome - so it is
//     reported as "tripped, not an outcome". R6, R7 and R8 did NOT catch it in
//     either mode: R6 needs two reclaims to visit the members in OPPOSITE order,
//     which one table-driven plan never does (an ARRAY-driven reclaim plan - one
//     earlier unforced run of the indexed mode produced one - makes R6 deadlock
//     under this mutant, which is why the pre-lock exists); R7/R8 are
//     single-conflict queues, which cannot form a cycle. What catches the mutant
//     as an OUTCOME under the prod plan shape is the lock-order race R9/R10 (a
//     release that locks in id order vs a reclaim whose plan was first ARRANGED
//     to visit the members in descending id order).
// The control rounds do NOT cover the guards that live in triggers on public
// tables (the holder guard 0190, the payment gate, the lifecycle lock): a
// trigger on a public table fires for every session, so a mutant of it cannot
// be isolated.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";

requireLocalOrExplicitProd("panel-undo:concurrency-proof", {
  writes:
    "throwaway fixtures tagged puc-<hex> (staff, services, a patient, visits, tests, payments, results and the journal entries their bridges post), committed so two connections can race on them, then deleted",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Belt-and-suspenders on top of the guard above: this script COMMITS rows, so
// it must never run against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(
    `[panel-undo:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script commits fixtures and only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `puc-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();

// Three member ids per panel, sorted so m[0] < m[1] < m[2] in uuid order
// (lowercase hex compares like Postgres's bytewise uuid compare). The lock
// scenarios depend on knowing which member an id-ordered lock reaches last.
function panelIds(): [string, string, string] {
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  return [ids[0], ids[1], ids[2]];
}

const fx = {
  med1: randomUUID(),
  med2: randomUUID(),
  med3: randomUUID(),
  admin1: randomUUID(),
  group: randomUUID(),
  services: [randomUUID(), randomUUID(), randomUUID()],
  single: randomUUID(),
  patient: randomUUID(),
  visits: { P: randomUUID(), Q: randomUUID(), R: randomUUID() },
  P: panelIds(),
  Q: panelIds(),
  R: panelIds(),
};
const ALL_TESTS = [...fx.P, ...fx.Q, ...fx.R];

const NAMES: Record<string, string> = {
  [fx.med1]: "M1",
  [fx.med2]: "M2",
  [fx.med3]: "M3",
  [fx.admin1]: "A1",
};

// Every id this run minted that a leftover check can look up by primary key.
const made = { tests: [...ALL_TESTS], payments: [] as string[], results: [] as string[] };

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type Mode = "seq" | "indexed";
const REAL_MODES: Mode[] = ["seq", "indexed"];

// Where the functions under test live: public, or a --control mutant schema.
// Only reclaim_panel_members / restore_panel_members follow it; the competing
// writers (claim_panel_members, release_visit_results, plain UPDATEs) always
// run against public.
let fnSchema = "public";

interface Actor {
  name: string;
  uid: string | null; // null = service_role (the queue's admin client)
  c: Client;
  pid: number;
}

let monitor: Client; // postgres; seeds, resets, reads committed state, watches waits
const open: Actor[] = [];

// The stack hung once under a runaway run, so the whole run is bounded: every
// connection has a connect timeout and session-level statement / lock timeouts
// (set BEFORE any `begin`, so a forced wait that never resolves fails the run
// instead of hanging it - mustWait observes a wait within ~5s, far below the
// 20s lock_timeout), and the number of simultaneously open connections is
// capped. A connect timeout is NOT retried: the run fails and tears down.
const MAX_CONNECTIONS = 8;
const live = new Set<Client>();
let peakConnections = 0;

async function connect(): Promise<Client> {
  if (live.size >= MAX_CONNECTIONS) {
    throw new Error(`connection cap: ${live.size} clients already open (max ${MAX_CONNECTIONS})`);
  }
  const c = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 8000 });
  // A backend terminated while idle surfaces as an 'error' event; log it
  // instead of letting it crash the process before teardown has run.
  c.on("error", (e) => console.log(`  (connection error: ${e.message})`));
  await c.connect();
  live.add(c);
  peakConnections = Math.max(peakConnections, live.size);
  c.once("end", () => live.delete(c));
  try {
    await c.query("set statement_timeout = '30s'");
    await c.query("set lock_timeout = '20s'");
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
  return c;
}

// A fresh connection per actor per scenario: plpgsql caches its statement
// plans per session, so reusing a connection across modes would keep the
// first mode's plan.
async function actor(name: string, uid: string | null): Promise<Actor> {
  const c = await connect();
  let rows: Array<{ pid: number }>;
  try {
    ({ rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid"));
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
  const a = { name, uid, c, pid: rows[0].pid };
  open.push(a);
  return a;
}

async function closeActors(): Promise<void> {
  for (const a of open.splice(0)) {
    try {
      await a.c.query("rollback");
    } catch {
      /* not in a transaction, or already failed */
    }
    await a.c.end().catch(() => undefined);
  }
}

const MODE_GUCS: Record<Mode, string[]> = {
  seq: [],
  // Reproduces prod's two plans locally (see the header).
  indexed: ["set local enable_seqscan = off", "set local enable_bitmapscan = off"],
};

// Left to the planner, a few-row local table gives a different plan from one
// run to the next (heap bloat and statistics decide): the reclaim UPDATE
// flipped between prod's table-driven Hash Join and an ARRAY-driven Nested Loop
// of pkey lookups. Indexed mode therefore FORCES the prod join method for each
// call, per role:
//   authenticated (the staff reclaim): nested loops and merge joins off, so the
//     array is always the hashed side of a Hash Join (t.id = x.id) whose table
//     side is an index scan - table-driven like prod. (Prod also nests a
//     visits_pkey lookup above it; locally that join is a Hash Join too. It
//     only reads the visits row, so it does not touch the lock order.)
//   service_role (the queue's admin client: the panel restore): nested loops and
//     hash joins off, so the plan is a Merge Join - prod's, on deleted_at over
//     test_requests_deleted_idx with only the array sorted.
function gucsFor(mode: Mode, role: "authenticated" | "service_role"): string[] {
  if (mode !== "indexed") return MODE_GUCS[mode];
  return role === "service_role"
    ? [...MODE_GUCS[mode], "set local enable_nestloop = off", "set local enable_hashjoin = off"]
    : [...MODE_GUCS[mode], "set local enable_nestloop = off", "set local enable_mergejoin = off"];
}

// BEGIN as a staff member (JWT sub, role authenticated), or as service_role.
async function begin(a: Actor, mode: Mode): Promise<void> {
  await a.c.query("begin");
  if (a.uid) {
    await a.c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: a.uid, role: "authenticated" }),
    ]);
    await a.c.query("set local role authenticated");
  } else {
    await a.c.query("set local role service_role");
  }
  for (const g of gucsFor(mode, a.uid ? "authenticated" : "service_role")) await a.c.query(g);
}

// ---------------------------------------------------------------------------
// The writes, exactly as the app issues them
// ---------------------------------------------------------------------------

type Out<T> = { ok: true; v: T } | { ok: false; code: string; message: string };
type N = Out<number>;

interface ReleaseJson {
  released: Array<{ id: string; name: string; report_id: string | null; selected: boolean; released_at: string }>;
  refused: Array<{ id: string; code: string; report_id: string | null; count: number }>;
}

async function settle<T>(p: Promise<QueryResult>, pick: (r: QueryResult) => T): Promise<Out<T>> {
  try {
    const r = await p;
    return { ok: true, v: pick(r) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "?", message: err.message ?? String(e) };
  }
}

// reclaimPanelMembers (lib/actions/queue/panel-writes.ts) -> rpc("reclaim_panel_members")
// concurrency-proof: reclaim_panel_members
function reclaim(
  a: Actor,
  ids: readonly string[],
  holders: readonly string[],
  startedAt: ReadonlyArray<string | null>,
): Promise<N> {
  return settle(
    a.c.query(`select ${fnSchema}.reclaim_panel_members($1::uuid[], $2::uuid[], $3::timestamptz[]) as n`, [
      ids,
      holders,
      startedAt,
    ]),
    (r) => Number(r.rows[0].n),
  );
}

// restore_panel_members (same file), through the service-role admin client.
// concurrency-proof: restore_panel_members
function restore(a: Actor, visit: string, ids: readonly string[], deletedAt: readonly string[]): Promise<N> {
  return settle(
    a.c.query(`select ${fnSchema}.restore_panel_members($1::uuid, $2::uuid[], $3::timestamptz[]) as n`, [
      visit,
      ids,
      deletedAt,
    ]),
    (r) => Number(r.rows[0].n),
  );
}

// claimPanelMembers -> rpc("claim_panel_members")
function claimPanel(a: Actor, ids: readonly string[]): Promise<N> {
  return settle(a.c.query("select public.claim_panel_members($1::uuid[]) as n", [ids]), (r) => Number(r.rows[0].n));
}

// claimTestAction's single-row UPDATE (queue/actions.ts).
function claimOne(a: Actor, id: string): Promise<N> {
  return settle(
    a.c.query(
      `update public.test_requests
          set status = 'in_progress', assigned_to = $2, started_at = now()
        where id = $1 and status = 'requested' and deleted_at is null
        returning id`,
      [id, a.uid],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// What deleteTestRequestsManyCore issues per visit (via
// deleteTestRequestsForVisit, lib/actions/queue/bulk-delete-core.ts), through
// the service-role admin client: since 0216 the rpc("delete_test_request_lines"),
// which takes the global lock order (patient lifecycle lock shared -> visit FOR
// UPDATE -> lines ORDER BY id) before the same UPDATE the app used to issue bare.
// The row count is the length of the returned id array.
function queueDelete(a: Actor, ids: readonly string[], visitId: string): Promise<N> {
  return settle(
    a.c.query("select public.delete_test_request_lines($1::uuid, $2::uuid[], $3::uuid, $4, now()) as ids", [
      visitId,
      ids,
      fx.admin1,
      `${TAG} concurrency proof`,
    ]),
    (r) => ((r.rows[0].ids as string[] | null) ?? []).length,
  );
}

// The manual Restore (restoreTestRequestsForVisit's non-bulk branch,
// lib/actions/visits/queue-restore-core.ts), through the admin client: since 0216
// rpc("restore_test_request_lines", { p_visit_id, p_test_request_ids }) with NO
// p_deleted_at (so its predicate is the old bare UPDATE's "deleted_at is not null"),
// which takes the global lock order (patient lifecycle lock shared -> visit FOR
// UPDATE -> the lines and a header's components ORDER BY id) before the UPDATE.
// The row count is the length of the returned id array (0 = nothing was deleted).
function manualRestore(a: Actor, ids: readonly string[], visitId: string): Promise<N> {
  return settle(
    a.c.query("select public.restore_test_request_lines($1::uuid, $2::uuid[]) as ids", [visitId, ids]),
    (r) => ((r.rows[0].ids as string[] | null) ?? []).length,
  );
}

// A member leaving `requested` with no holder. No app path writes this today
// (see R13); the status check of 0001 allows it.
function cancelMember(a: Actor, id: string): Promise<N> {
  return settle(
    a.c.query("update public.test_requests set status = 'cancelled' where id = $1 and status = 'requested' returning id", [id]),
    (r) => r.rowCount ?? 0,
  );
}

// The visit soft-delete (queue Delete of a whole visit), admin client.
function deleteVisit(a: Actor, visit: string): Promise<N> {
  return settle(
    a.c.query(
      `update public.visits set deleted_at = now(), deleted_by = $2, delete_reason = 't'
        where id = $1 and deleted_at is null returning id`,
      [visit, fx.admin1],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// releaseVisitSelection -> rpc("release_visit_results") (always the real one)
function release(a: Actor, visit: string, ids: readonly string[]): Promise<Out<ReleaseJson>> {
  return settle(
    a.c.query("select public.release_visit_results($1::uuid, $2::uuid[], 'email') as r", [visit, ids]),
    (r) => r.rows[0].r as ReleaseJson,
  );
}

// Commit on success, roll back on refusal - the moment the call answers, the
// way PostgREST ends each RPC's transaction. Racers must never wait for each
// other's answers before ending their own: the loser is queued behind the
// winner's still-open transaction.
function andEnd<T>(a: Actor, p: Promise<Out<T>>): Promise<Out<T>> {
  // Never rejects: a scenario that throws early closes its connections while
  // these are still pending, and an unhandled rejection there would kill the
  // process before the fixtures are torn down. A failed COMMIT still surfaces
  // - as a failed outcome the scenario's assertions reject.
  return p.then(async (o) => {
    try {
      await a.c.query(o.ok ? "commit" : "rollback");
      return o;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code ?? "end-failed", message: err.message ?? String(e) } as Out<T>;
    }
  });
}

// ---------------------------------------------------------------------------
// Interleaving control
// ---------------------------------------------------------------------------

class Fail extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waiting on a ROW: an ungranted transactionid (queued behind the holder's
// transaction) or tuple lock. A relation-level wait - another session's DDL
// on the shared stack - does not count, so it can neither fake a forced
// interleaving nor fail a "must not wait" case.
async function waitingOnLock(pid: number): Promise<boolean> {
  const { rows } = await monitor.query(
    "select 1 from pg_locks where pid = $1 and not granted and locktype in ('transactionid', 'tuple')",
    [pid],
  );
  return rows.length > 0;
}

// Which relations the backend holds row-level tuple locks on (the first waiter
// on a row takes the tuple lock, then waits for the holder's transaction), so
// a wait can be pinned to the table it is on: the visit, or the test rows.
async function waitRelations(pid: number): Promise<string[]> {
  const { rows } = await monitor.query<{ rel: string }>(
    "select distinct relation::regclass::text as rel from pg_locks where pid = $1 and locktype = 'tuple'",
    [pid],
  );
  return rows.map((r) => r.rel.replace(/^public\./, ""));
}

// Strict: the actor's in-flight statement must be observed blocked on a row
// lock within ~5s, or the interleaving was not achieved. With `rel`, the wait
// must be on a row of that table (test_requests / visits).
async function mustWait(a: Actor, why: string, rel?: string): Promise<string[]> {
  let seen: string[] = [];
  for (let i = 0; i < 50; i++) {
    if (await waitingOnLock(a.pid)) {
      seen = await waitRelations(a.pid);
      if (!rel || seen.includes(rel)) return seen;
    }
    await sleep(100);
  }
  throw new Fail(
    rel && seen.length
      ? `unexpected wait: ${a.name} waited on a row of [${seen.join(",")}], not ${rel} (${why})`
      : `interleaving not reached: ${a.name} never waited on a row lock (${why})`,
  );
}

// The opposite: the call must answer while the other side is still open,
// without ever blocking on a row lock.
async function mustNotWait<T>(a: Actor, p: Promise<Out<T>>, why: string): Promise<Out<T>> {
  let done = false;
  const tracked = p.then((o) => {
    done = true;
    return o;
  });
  for (let i = 0; i < 50 && !done; i++) {
    if (!done && (await waitingOnLock(a.pid))) {
      throw new Fail(`${a.name} blocked on a row lock but should have answered at once (${why})`);
    }
    await sleep(100);
  }
  if (!done) throw new Fail(`${a.name} did not answer within 5s (${why})`);
  return tracked;
}

// Which of `ids` are row-locked by someone else right now (FOR UPDATE SKIP
// LOCKED from a throwaway transaction, rolled back at once).
async function lockedBySomeoneElse(ids: readonly string[]): Promise<string[]> {
  const c = await connect();
  try {
    await c.query("begin");
    const { rows } = await c.query<{ id: string }>(
      "select id from public.test_requests where id = any($1::uuid[]) for update skip locked",
      [ids],
    );
    await c.query("rollback");
    const free = new Set(rows.map((r) => r.id));
    return ids.filter((id) => !free.has(id));
  } finally {
    await c.end();
  }
}

// An outside transaction (as postgres) holding FOR UPDATE on rows, so several
// actors can be lined up behind it and released at the same instant.
async function holdRows(ids: readonly string[]): Promise<Client> {
  const c = await connect();
  try {
    await c.query("begin");
    await c.query("select id from public.test_requests where id = any($1::uuid[]) for update", [ids]);
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

// The statements inside the two functions, as plain SQL for EXPLAIN / probing.
const RECLAIM_UPDATE = `update public.test_requests t
     set status = 'in_progress', assigned_to = x.holder, started_at = coalesce(x.started_at, now())
    from unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) as x(id, holder, started_at)
   where t.id = x.id and t.status = 'requested' and t.assigned_to is null and t.deleted_at is null
     and exists (select 1 from public.visits v where v.id = t.visit_id and v.deleted_at is null)`;
const RESTORE_UPDATE = `update public.test_requests t
     set deleted_at = null, deleted_by = null, delete_reason = null
    from unnest($2::uuid[], $3::timestamptz[]) as x(id, deleted_at)
   where t.id = x.id and t.visit_id = $1 and t.deleted_at = x.deleted_at and t.parent_id is null`;
const RECLAIM_PRELOCK =
  "select 1 from public.test_requests t where t.id = any ($1::uuid[]) order by t.id for no key update";
// 0216: the members AND any header's components (the cascade restores them), the
// visit predicate first - hand-copied from restore_panel_members, which locks them
// ascending after the patient lock and the visit FOR UPDATE.
const RESTORE_PRELOCK =
  "select 1 from public.test_requests t where t.visit_id = $2 and (t.id = any ($1::uuid[]) or t.parent_id = any ($1::uuid[])) order by t.id for no key update";

const nulls = (n: number): null[] => Array.from({ length: n }, () => null);
const x3 = <T>(v: T): T[] => [v, v, v];
const rev = <T>(xs: readonly T[]) => [...xs].reverse();

// Plans are taken as the role the real call runs under: a plan built as
// postgres omits the RLS qualifiers the staff session's plan carries, and
// those can change the join order (the first version of this probe measured
// the wrong plan and mispredicted the order the function visits rows in).
async function probeRole(role: "authenticated" | "service_role"): Promise<void> {
  if (role === "authenticated") {
    await monitor.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: fx.admin1, role: "authenticated" }),
    ]);
  }
  await monitor.query(`set local role ${role}`);
}

async function explain(
  mode: Mode,
  sql: string,
  params: unknown[],
  role: "authenticated" | "service_role",
): Promise<string[]> {
  await monitor.query("begin");
  try {
    await probeRole(role);
    for (const g of gucsFor(mode, role)) await monitor.query(g);
    const { rows } = await monitor.query(`explain (costs off) ${sql}`, params);
    return rows.map((r) => String(r["QUERY PLAN"]));
  } finally {
    await monitor.query("rollback");
  }
}

const reclaimPlan = (mode: Mode) => explain(mode, RECLAIM_UPDATE, [fx.P, x3(fx.med1), nulls(3)], "authenticated");
const restorePlan = (mode: Mode) => explain(mode, RESTORE_UPDATE, [fx.visits.P, fx.P, x3(new Date())], "service_role");
const reclaimPrelock = (mode: Mode) => explain(mode, RECLAIM_PRELOCK, [fx.P], "authenticated");
const restorePrelock = (mode: Mode) => explain(mode, RESTORE_PRELOCK, [fx.P, fx.visits.P], "service_role");

// The pre-lock's order IS the sort order: LockRows over an id-ordered input (a
// Sort on id, or the pkey index scan that yields id order for free).
function lockPlanOk(lines: string[]): boolean {
  const body = lines.map((l) => l.trim());
  if (body[0] !== "LockRows") return false;
  const sorted = body.some((l) => l === "->  Sort") && body.some((l) => /^Sort Key: (t\.)?id$/.test(l));
  const pkeyOrdered =
    !body.some((l) => l === "->  Sort") && body.some((l) => /^->\s+Index Scan using test_requests_pkey\b/.test(l));
  return sorted || pkeyOrdered;
}

// "array" when the UPDATE visits rows in the caller's array order (the
// function scan is the outer side), "table" when a table scan drives.
function drivenBy(lines: string[]): "array" | "table" {
  const fnAt = lines.findIndex((l) => l.includes("Function Scan on x"));
  const tAt = lines.findIndex((l) => / on test_requests t\b/.test(l) && /Scan/.test(l));
  return fnAt !== -1 && tAt !== -1 && fnAt < tAt ? "array" : "table";
}

// One-line plan, without filters and without the RLS policy's own InitPlan /
// SubPlan noise (the staff plan carries it; it is not part of the join shape).
const flat = (lines: string[]) =>
  lines
    .map((l) => l.trim())
    .filter(
      (l) =>
        !/^(Filter|Join Filter|Index Cond|Recheck|InitPlan|SubPlan|Output)/.test(l.replace(/^->\s*/, "")) &&
        l !== "->  Result" &&
        !/ on visits v_\d/.test(l) &&
        !/Index Scan using idx_visits_patient_id/.test(l),
    )
    .join(" / ");

// Does this mode's plan have prod's shape? (Printed, not asserted: the local
// planner's choice moves with table statistics.)
// The table side is a full Index Scan on a few-row table with no usable index
// condition, so WHICH index the local planner walks (the status one prod's plan
// shows, or the visit_id one, 2026-10-02 on this stack) is a cost tie decided by
// the heap's column correlation. Both give the same shape - a table-driven Hash
// Join (t.id = x.id) over an index scan - and a lock order of (index key, TID),
// which arrangeInverted controls either way, so either is accepted.
const prodReclaimShape = (lines: string[]) =>
  /Hash Join/.test(flat(lines)) &&
  lines.some((l) => /Hash Cond: \(t\.id = x\.id\)/.test(l)) &&
  /Index Scan using idx_test_requests_(status|visit_id)\b/.test(flat(lines)) &&
  drivenBy(lines) === "table";
const prodRestoreShape = (lines: string[]) =>
  /Merge Join/.test(flat(lines)) && /Index Scan using test_requests_deleted_idx/.test(flat(lines)) && /Sort/.test(flat(lines));

// The row order the reclaim UPDATE ACTUALLY visits, observed by running the
// statement in a transaction that is rolled back (RETURNING emits rows in
// update order, which is lock order). `arr` is the array the caller passes.
async function reclaimPlanOrder(mode: Mode, arr: readonly string[]): Promise<string[]> {
  await monitor.query("begin");
  try {
    await probeRole("authenticated");
    for (const g of gucsFor(mode, "authenticated")) await monitor.query(g);
    const { rows } = await monitor.query<{ id: string }>(`${RECLAIM_UPDATE} returning t.id`, [
      arr,
      arr.map(() => fx.med1),
      arr.map(() => null),
    ]);
    return rows.map((r) => r.id);
  } finally {
    await monitor.query("rollback");
  }
}

// Make the reclaim UPDATE visit `members` in DESCENDING id order (the reverse
// of the pre-lock's ascending order) in this mode, so a reclaim that locked in
// plan order would cross a release that locks in id order. The caller sends the
// array descending (which is all an array-driven plan needs); a table-driven
// plan follows heap / index order, which is made to run opposite to id order by
// rewriting the rows one at a time, highest id first (each rewrite is non-HOT -
// status is indexed - so the index entry moves with the new tuple).
// Throws when it cannot be arranged: the scenario would be vacuous.
async function arrangeInverted(mode: Mode, members: readonly string[]): Promise<string> {
  const want = rev(members);
  // Tuple position of each member: a table-driven plan visits a visit's rows in
  // (index, then heap TID) order, so want[i-1] must sit BEFORE want[i].
  const pos = async (): Promise<number[]> => {
    const { rows } = await monitor.query<{ id: string; c: string }>(
      "select id, ctid::text as c from public.test_requests where id = any($1::uuid[])",
      [want],
    );
    const byId = new Map(rows.map((r) => [r.id, r.c]));
    return want.map((id) => {
      const m = /^\((\d+),(\d+)\)$/.exec(byId.get(id) ?? "");
      return m ? Number(m[1]) * 100_000 + Number(m[2]) : -1;
    });
  };
  const touch = async (id: string) => {
    // Two status flips: status is indexed, so neither update is HOT and the
    // new tuple (and its index entry) moves to the page's next free slot.
    await setState([id], fx.med1);
    await setState([id], null);
  };
  // A rewrite can land in a slot an earlier prune freed (a LOWER position), so
  // move only the member that is out of order and look again.
  for (let i = 0; i < 40; i++) {
    const got = await reclaimPlanOrder(mode, want);
    if (got.join() === want.join()) {
      return `UPDATE visits members ${i === 0 ? "already" : "after " + i + " rewrite round(s)"} in descending id order`;
    }
    const p = await pos();
    let moved = false;
    for (let k = 1; k < want.length; k++) {
      if (p[k - 1] > p[k]) {
        await touch(want[k]);
        moved = true;
        break;
      }
    }
    if (!moved) for (const id of want) await touch(id);
  }
  const finalOrder = (await reclaimPlanOrder(mode, want)).map((id) => `w${members.indexOf(id)}`).join(",");
  const finalPos = (await pos()).join(",");
  throw new Fail(
    `interleaving not reached: could not make the reclaim UPDATE visit the members in descending id order in mode ${mode} - the lock-order race would be vacuous (last order [${finalOrder}], positions w2,w1,w0 = [${finalPos}], plan: ${flat(await reclaimPlan(mode))})`,
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Reset members to a known committed state (as postgres). holder null =
// requested + unassigned + live; otherwise in_progress under that holder.
async function setState(ids: readonly string[], holder: string | null): Promise<void> {
  await monitor.query(
    `update public.test_requests
        set status = $2, assigned_to = $3, started_at = $4,
            deleted_at = null, deleted_by = null, delete_reason = null
      where id = any($1::uuid[])`,
    [ids, holder ? "in_progress" : "requested", holder, holder ? new Date() : null],
  );
}

async function resetAll(): Promise<void> {
  await monitor.query(
    "update public.visits set deleted_at = null, deleted_by = null, delete_reason = null where id = any($1::uuid[]) and deleted_at is not null",
    [Object.values(fx.visits)],
  );
  await setState(ALL_TESTS, null);
}

// Bulk-delete the members the way the queue does (ONE statement, one stamp) and
// return the exact deleted_at each carries, as text: a JS Date would drop the
// microseconds the function compares for equality.
async function setDeleted(ids: readonly string[]): Promise<string[]> {
  await monitor.query(
    `update public.test_requests set deleted_at = now(), deleted_by = $2, delete_reason = $3
      where id = any($1::uuid[])`,
    [ids, fx.admin1, `${TAG} concurrency proof`],
  );
  return (await stampsOf(ids)).map((s) => {
    if (!s) throw new Fail("fixture: a member was not deleted");
    return s;
  });
}

// deleted_at per member as exact text (null = live), in the order given.
async function stampsOf(ids: readonly string[]): Promise<Array<string | null>> {
  const { rows } = await monitor.query<{ id: string; d: string | null }>(
    "select id, deleted_at::text as d from public.test_requests where id = any($1::uuid[])",
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r.d]));
  return ids.map((id) => byId.get(id) ?? null);
}

// "st:holder" per member, in the order given: `req:-`, `ip:M1`, `del/req:-`.
async function stateOf(ids: readonly string[]): Promise<string[]> {
  const { rows } = await monitor.query<{
    id: string;
    status: string;
    assigned_to: string | null;
    deleted_at: Date | null;
    started_at: Date | null;
  }>(
    "select id, status, assigned_to, deleted_at, started_at from public.test_requests where id = any($1::uuid[])",
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return "missing";
    const st = r.status === "requested" ? "req" : r.status === "in_progress" ? "ip" : r.status;
    const who = r.assigned_to ? (NAMES[r.assigned_to] ?? "??") : "-";
    // A requested row must never carry a holder or a start time - that is the
    // orphan a lost race would leave behind.
    const orphan = r.status === "requested" && (r.assigned_to || r.started_at) ? "!orphan" : "";
    return `${r.deleted_at ? "del/" : ""}${st}:${who}${orphan}`;
  });
}

async function expectState(label: string, ids: readonly string[], want: string[]): Promise<void> {
  const got = await stateOf(ids);
  if (got.join(",") !== want.join(",")) {
    throw new Fail(`${label}: expected [${want.join(",")}], got [${got.join(",")}]`);
  }
}

async function expectStamps(label: string, ids: readonly string[], want: Array<string | null>): Promise<void> {
  const got = await stampsOf(ids);
  if (got.join("|") !== want.join("|")) {
    throw new Fail(`${label}: expected deleted_at [${want.join(" | ")}], got [${got.join(" | ")}]`);
  }
}

// started_at of each member as epoch ms (null = none).
async function startedOf(ids: readonly string[]): Promise<Array<number | null>> {
  const { rows } = await monitor.query<{ id: string; s: Date | null }>(
    "select id, started_at as s from public.test_requests where id = any($1::uuid[])",
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r.s ? r.s.getTime() : null]));
  return ids.map((id) => byId.get(id) ?? null);
}

async function expectStarted(label: string, ids: readonly string[], want: ReadonlyArray<string | null>): Promise<void> {
  const got = await startedOf(ids);
  for (const [i, w] of want.entries()) {
    const g = got[i];
    if (g === null) throw new Fail(`${label}: member ${i} has no started_at`);
    if (w === null) {
      if (Math.abs(g - Date.now()) > 120_000) throw new Fail(`${label}: member ${i} started_at is not ~now`);
    } else if (g !== new Date(w).getTime()) {
      throw new Fail(`${label}: member ${i} started_at ${new Date(g).toISOString()} != ${w}`);
    }
  }
}

async function releasedStatus(id: string): Promise<string> {
  const { rows } = await monitor.query<{ status: string }>("select status from public.test_requests where id = $1", [id]);
  return rows[0]?.status ?? "missing";
}

function expectOk(label: string, o: N, n: number): void {
  if (!o.ok) throw new Fail(`${label}: expected success (${n}), got ${o.code} ${o.message}`);
  if (o.v !== n) throw new Fail(`${label}: expected ${n} rows, got ${o.v}`);
}

// With `msg`, the refusal must also carry that message: P0082 is raised for
// several reasons, and the reason is part of what each scenario proves.
function expectCode(label: string, o: Out<unknown>, code: string, msg?: RegExp): void {
  if (o.ok) throw new Fail(`${label}: expected ${code}, but it succeeded`);
  if (o.code !== code) throw new Fail(`${label}: expected ${code}, got ${o.code} ${o.message}`);
  if (msg && !msg.test(o.message)) throw new Fail(`${label}: ${code} carried the wrong message: ${o.message}`);
}

// The row-count refusals of the two functions (0200).
const RECLAIM_REFUSED = /claimed or changed part/;
const RESTORE_REFUSED = /already restored or changed/;

// fn_queue_delete_cascade keeps visits.total_php in step with the live priced
// lines (100 each in the P / Q / R fixtures): a delete / restore that landed
// half-way, or one a refused call rolled back unevenly, shows up here.
async function expectTotal(label: string, visit: string): Promise<void> {
  const { rows } = await monitor.query<{ t: string; n: string }>(
    `select v.total_php::text as t,
            (select count(*) from public.test_requests l where l.visit_id = v.id and l.deleted_at is null)::text as n
       from public.visits v where v.id = $1`,
    [visit],
  );
  const t = Number(rows[0].t);
  const n = Number(rows[0].n);
  if (t !== 100 * n) throw new Fail(`${label}: visits.total_php is ${t}, expected 100 x ${n} live lines`);
}

// A release that released exactly `released` and refused `refused` (id -> code).
function expectReleased(label: string, o: Out<ReleaseJson>, released: string[], refused: Record<string, string>): void {
  if (!o.ok) throw new Fail(`${label}: release failed ${o.code} ${o.message}`);
  const got = o.v.released.map((r) => r.id).sort();
  if (got.join() !== [...released].sort().join()) {
    throw new Fail(`${label}: released [${got.length}] not the expected [${released.length}]`);
  }
  for (const [id, code] of Object.entries(refused)) {
    const r = o.v.refused.find((x) => x.id === id);
    if (!r || r.code !== code) throw new Fail(`${label}: expected ${id.slice(0, 8)} refused as ${code}, got ${r?.code ?? "not refused"}`);
  }
}

const tally = (outs: Array<Out<unknown>>) => outs.map((o) => (o.ok ? "ok" : o.code)).join("/");

// ---------------------------------------------------------------------------
// Fixture builders (committed, as postgres)
// ---------------------------------------------------------------------------

let visitSeq = 0;

interface W {
  visit: string;
  x: string; // a ready_for_release test with its own linked result
  members: [string, string, string]; // the panel, ascending uuid order
  stamps: string[] | null; // exact deleted_at of each member when the panel was deleted
}

// A PAID visit for the release scenarios: test X (priced, linked to its own
// result, ready_for_release, settled by one payment) and a three-member panel
// (priced 0, so deleting/restoring a member leaves the visit's total alone).
// `deletedPanel` bulk-deletes the panel BEFORE the payment (only an unpaid
// visit's lines can be deleted), as the queue Delete would have.
async function mkW(deletedPanel: boolean): Promise<W> {
  const members = panelIds();
  const x = randomUUID();
  const visit = randomUUID();
  const result = randomUUID();
  const payment = randomUUID();
  const seq = ++visitSeq;
  made.tests.push(x, ...members);
  made.payments.push(payment);
  made.results.push(result);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 100, 0)`,
      [visit, `V-${TAG_UP}-W${seq}`, fx.patient],
    );
    for (const [i, id] of members.entries()) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
         values ($1, $2, $3, $4, 'requested', 0, 0)`,
        [id, visit, fx.services[i], fx.med1],
      );
    }
    await monitor.query(
      `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
       values ($1, $2, $3, $4, 'requested', 100, 100)`,
      [x, visit, fx.single, fx.med1],
    );
    if (deletedPanel) {
      await monitor.query(
        "update public.test_requests set deleted_at = now(), deleted_by = $2, delete_reason = $3 where id = any($1::uuid[])",
        [members, fx.admin1, `${TAG} concurrency proof`],
      );
    }
    await monitor.query(
      "insert into public.payments (id, visit_id, amount_php, method, received_by) values ($1, $2, 100, 'cash', $3)",
      [payment, visit, fx.admin1],
    );
    await monitor.query("insert into public.results (id, uploaded_by) values ($1, $2)", [result, fx.med1]);
    await monitor.query("insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)", [result, x]);
    await monitor.query("update public.test_requests set status = 'ready_for_release' where id = $1", [x]);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  const stamps = deletedPanel ? (await stampsOf(members)).map((s) => s as string) : null;
  return { visit, x, members, stamps };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
let sink: Result[] = results;

// PUC_ONLY=<regex> runs just the scenarios whose name matches (debugging aid).
const ONLY = process.env.PUC_ONLY ? new RegExp(process.env.PUC_ONLY) : null;

async function scenario(name: string, body: () => Promise<string | void>): Promise<void> {
  if (ONLY && !ONLY.test(name)) return;
  await resetAll();
  try {
    const note = await body();
    sink.push({ name, ok: true, detail: note ?? "" });
    console.log(`  PASS  ${name}${note ? ` - ${note}` : ""}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    sink.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name} - ${detail}`);
  } finally {
    await closeActors();
  }
}

// R6 / R9 / R10 are only meaningful while the reclaim pre-lock is id-ordered.
async function assertPreLockOrdered(mode: Mode): Promise<void> {
  const lines = await reclaimPrelock(mode);
  if (!lockPlanOk(lines)) {
    throw new Fail(`plan shape changed: the reclaim pre-lock is no longer LockRows over an id-ordered input (${flat(lines)}) - see the header`);
  }
}

// One release + one reclaim race on a gated middle member, started in the given
// order (R9: release first; R10: reclaim first). See the header.
async function lockOrderRace(mode: Mode, first: "release" | "reclaim"): Promise<string> {
  await assertPreLockOrdered(mode);
  // The arrangement works on heap placement, which autovacuum and the planner's
  // statistics can disturb on a busy shared stack: retry on a fresh visit (fresh
  // rows, fresh placement) before giving up. Never proceeds un-arranged.
  let w = await mkW(false);
  let arranged = "";
  for (let attempt = 1; ; attempt++) {
    try {
      arranged = await arrangeInverted(mode, w.members);
      break;
    } catch (e) {
      if (!(e instanceof Fail) || attempt >= 3) throw e;
      w = await mkW(false);
    }
  }
  const [w0, w1, w2] = w.members;
  const rel = await actor("M1", fx.med1);
  const rec = await actor("A1", fx.admin1);
  const gate = await holdRows([w1]);
  let pRel: Promise<Out<ReleaseJson>>;
  let pRec: Promise<N>;
  let reclaimHoldsHighest: boolean | null = null;
  try {
    await begin(rel, mode);
    await begin(rec, mode);
    const startRelease = () => andEnd(rel, release(rel, w.visit, w.members));
    // The reclaim sends the members DESCENDING (see arrangeInverted); the
    // function's own pre-lock sorts them, so for the real function it makes no
    // difference.
    const startReclaim = () => andEnd(rec, reclaim(rec, rev(w.members), x3(fx.med1), nulls(3)));
    if (first === "release") {
      pRel = startRelease();
      await mustWait(rel, "the release holds the lowest member and waits on the gated middle one");
      // Lock-order evidence: the release is mid-lock with w0 held, w2 untouched.
      const held = await lockedBySomeoneElse([w0, w2]);
      if (!held.includes(w0) || held.includes(w2)) {
        throw new Fail(`interleaving not reached: expected the release to hold w0 and not w2, locked = [${held.map((h) => (h === w0 ? "w0" : "w2")).join(",")}]`);
      }
      pRec = startReclaim();
      await mustWait(rec, "the reclaim queues behind the release");
      // Diagnostic (not asserted): does the queued reclaim already hold the
      // HIGHEST member? True only for a reclaim that locks in plan order.
      reclaimHoldsHighest = (await lockedBySomeoneElse([w2])).includes(w2);
    } else {
      pRec = startReclaim();
      await mustWait(rec, "the reclaim is caught mid-lock on the gated middle member");
      pRel = startRelease();
      await mustWait(rel, "the release queues behind the reclaim");
    }
    await gate.query("rollback");
  } finally {
    await gate.end();
  }
  const [ro, rr] = await Promise.all([pRel, pRec]);
  const dead = [ro, rr].filter((o) => !o.ok && o.code === "40P01");
  if (dead.length) throw new Fail(`deadlock (40P01): release=${ro.ok ? "ok" : ro.code} reclaim=${rr.ok ? "ok" : rr.code}`);
  expectOk("reclaim", rr, 3);
  // The release saw the members either still requested (reclaim second) or
  // already handed back in_progress: never ready, so it refuses all three.
  expectReleased("release", ro, [], { [w0]: "not_ready", [w1]: "not_ready", [w2]: "not_ready" });
  await expectState("after", w.members, x3("ip:M1"));
  return reclaimHoldsHighest === null ? arranged : `${arranged}; queued reclaim ${reclaimHoldsHighest ? "ALREADY HOLDS" : "holds nothing of"} the highest member`;
}

// One panel restore + one release whose selection is the (deleted) panel members
// race on a gated middle member, started in the given order (S8: restore first,
// caught mid-lock; S9: release first). The restore locks the VISIT first, the
// release takes the visit FOR SHARE first, so whichever comes second is stopped
// at the visit before it holds a single member row - no cycle. Without the
// restore's own visit lock (mutant F) the restore holds a member row while its
// BEFORE trigger (0183's waived-visit guard) asks for the visit FOR UPDATE, and
// the release holds the visit FOR SHARE while it asks for that member: 40P01.
async function restoreReleaseRace(mode: Mode, first: "restore" | "release"): Promise<string> {
  const w = await mkW(true);
  const [w0, w1, w2] = w.members;
  const pan = await actor("service_role (panel)", null);
  const rel = await actor("M1", fx.med1);
  const gate = await holdRows([w1]);
  let pPan: Promise<N>;
  let pRel: Promise<Out<ReleaseJson>>;
  let waited: string[] = [];
  try {
    await begin(pan, mode);
    await begin(rel, mode);
    const startRestore = () => andEnd(pan, restore(pan, w.visit, w.members, w.stamps as string[]));
    const startRelease = () => andEnd(rel, release(rel, w.visit, w.members));
    if (first === "restore") {
      pPan = startRestore();
      await mustWait(pan, "the restore holds the visit and the lowest member and waits on the gated middle one", "test_requests");
      pRel = startRelease();
      waited = await mustWait(rel, "the release queues behind the restore");
    } else {
      pRel = startRelease();
      await mustWait(rel, "the release holds the visit (shared) and the lowest member and waits on the gated middle one", "test_requests");
      pPan = startRestore();
      waited = await mustWait(pan, "the restore queues behind the release");
    }
    await gate.query("rollback");
  } finally {
    await gate.end();
  }
  const [rp, rr] = await Promise.all([pPan, pRel]);
  const dead = [rp, rr].filter((o) => !o.ok && o.code === "40P01");
  if (dead.length) throw new Fail(`deadlock (40P01): restore=${rp.ok ? "ok" : rp.code} release=${rr.ok ? "ok" : rr.code}`);
  expectOk("panel restore", rp, 3);
  // Deleted or already restored, never ready: the release refuses all three.
  expectReleased("release", rr, [], { [w0]: "not_ready", [w1]: "not_ready", [w2]: "not_ready" });
  await expectStamps("after", w.members, [null, null, null]);
  return `the second caller waited on [${waited.join(",")}]`;
}

async function forcedScenarios(mode: Mode): Promise<void> {
  const { P, Q } = fx;
  const [p0, p1, p2] = P;
  const s = (id: string, text: string) => `[${mode}] ${id} ${text}`;
  // The started_at each member had when its claim was handed back.
  const STARTED: Array<string | null> = [
    new Date(Date.now() - 9 * 60_000).toISOString(),
    new Date(Date.now() - 8 * 60_000).toISOString(),
    null,
  ];

  // --- R. reclaim -------------------------------------------------------------
  await scenario(s("R1", "single claim of the last member commits first, reclaim queued -> P0082, other two still requested"), async () => {
    const c = await actor("M2", fx.med2);
    const r = await actor("M1", fx.med1);
    await begin(c, mode);
    expectOk("M2 single claim of p2", await claimOne(c, p2), 1);
    await begin(r, mode);
    const pr = reclaim(r, P, x3(fx.med1), STARTED);
    await mustWait(r, "M1's reclaim reaches the member M2 is claiming", "test_requests");
    // The pre-lock is id-ordered in both modes, so the reclaim is provably
    // holding the two earlier members (and has written nothing) while blocked.
    const held = await lockedBySomeoneElse([p0, p1]);
    if (held.length !== 2) {
      throw new Fail(`the reclaim's id-ordered pre-lock is not in effect: M1 held ${held.length}/2 earlier members while blocked`);
    }
    await c.c.query("commit");
    expectCode("M1 reclaim", await pr, "P0082", RECLAIM_REFUSED);
    await r.c.query("rollback");
    await expectState("after", P, ["req:-", "req:-", "ip:M2"]);
    return `M1 held ${held.length}/2 earlier members while blocked; all released`;
  });

  await scenario(s("R2", "single claim rolls back, reclaim lands whole: each member under its own holder at its own started_at"), async () => {
    const a = await actor("A1", fx.admin1);
    const c = await actor("M2", fx.med2);
    await begin(c, mode);
    expectOk("M2 single claim of p1", await claimOne(c, p1), 1);
    await begin(a, mode);
    const pa = reclaim(a, P, [fx.med1, fx.med2, fx.med1], STARTED);
    await mustWait(a, "A1's reclaim reaches the member M2 is claiming", "test_requests");
    await c.c.query("rollback");
    expectOk("A1 reclaim", await pa, 3);
    await a.c.query("commit");
    await expectState("after", P, ["ip:M1", "ip:M2", "ip:M1"]);
    await expectStarted("started_at", P, STARTED);
  });

  await scenario(s("R3", "reclaim first, claim_panel_members queued -> P0077, panel whole under the reclaimed holders"), async () => {
    const r = await actor("M1", fx.med1);
    const c = await actor("M2", fx.med2);
    await begin(r, mode);
    expectOk("M1 reclaim", await reclaim(r, P, x3(fx.med1), STARTED), 3);
    await begin(c, mode);
    const pc = claimPanel(c, P);
    await mustWait(c, "M2's panel claim queues behind the reclaim", "test_requests");
    await r.c.query("commit");
    expectCode("M2 claim", await pc, "P0077");
    await c.c.query("rollback");
    await expectState("after", P, x3("ip:M1"));
    await expectStarted("started_at", P, STARTED);
  });

  await scenario(s("R4", "queue delete of one member first, reclaim queued -> P0082, nothing put back"), async () => {
    const del = await actor("service_role", null);
    const r = await actor("M1", fx.med1);
    await begin(del, mode);
    expectOk("delete p1", await queueDelete(del, [p1], fx.visits.P), 1);
    await begin(r, mode);
    const pr = reclaim(r, P, x3(fx.med1), STARTED);
    await mustWait(r, "M1's reclaim reaches the member being deleted", "test_requests");
    await del.c.query("commit");
    expectCode("M1 reclaim", await pr, "P0082", RECLAIM_REFUSED);
    await r.c.query("rollback");
    await expectState("after", P, ["req:-", "del/req:-", "req:-"]);
  });

  await scenario(s("R5", "two reclaims of one panel (double Undo click), released together -> one lands, the other P0082"), async () => {
    const a = await actor("M1 tab 1", fx.med1);
    const b = await actor("M1 tab 2", fx.med1);
    const gate = await holdRows(P);
    let ra: N;
    let rb: N;
    try {
      await begin(a, mode);
      await begin(b, mode);
      const pa = andEnd(a, reclaim(a, P, x3(fx.med1), STARTED));
      const pb = andEnd(b, reclaim(b, P, x3(fx.med1), STARTED));
      await mustWait(a, "tab 1 lined up behind the gate", "test_requests");
      await mustWait(b, "tab 2 lined up behind the gate", "test_requests");
      await gate.query("rollback");
      [ra, rb] = await Promise.all([pa, pb]);
    } finally {
      await gate.end();
    }
    const oks = [ra, rb].filter((o) => o.ok);
    const errs = [ra, rb].filter((o): o is Extract<N, { ok: false }> => !o.ok);
    if (oks.length !== 1 || errs.length !== 1 || errs[0].code !== "P0082") {
      throw new Fail(`expected one success + one P0082, got tab1=${tally([ra])} tab2=${tally([rb])}`);
    }
    if (!RECLAIM_REFUSED.test(errs[0].message)) throw new Fail(`loser's P0082 carried the wrong message: ${errs[0].message}`);
    await expectState("after", P, x3("ip:M1"));
  });

  await scenario(s("R6", "reclaim P+Q vs reclaim Q+P (opposite member order), released together -> no 40P01, one wins, both panels whole"), async () => {
    await assertPreLockOrdered(mode);
    const driven = drivenBy(await reclaimPlan(mode));
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    const gate = await holdRows([...P, ...Q]);
    let ra: N;
    let rb: N;
    try {
      await begin(a, mode);
      await begin(b, mode);
      const pa = andEnd(a, reclaim(a, [...P, ...Q], x3(fx.med1).concat(x3(fx.med1)), nulls(6)));
      const pb = andEnd(b, reclaim(b, [...rev(Q), ...rev(P)], x3(fx.med2).concat(x3(fx.med2)), nulls(6)));
      await mustWait(a, "M1 lined up behind the gate", "test_requests");
      await mustWait(b, "M2 lined up behind the gate", "test_requests");
      await gate.query("rollback");
      [ra, rb] = await Promise.all([pa, pb]);
    } finally {
      await gate.end();
    }
    const oks = [ra, rb].filter((o) => o.ok);
    const errs = [ra, rb].filter((o): o is Extract<N, { ok: false }> => !o.ok);
    if (oks.length !== 1 || errs.length !== 1 || errs[0].code !== "P0082") {
      throw new Fail(`expected one success (6) + one P0082, got M1=${tally([ra])} M2=${tally([rb])}`);
    }
    if (!RECLAIM_REFUSED.test(errs[0].message)) throw new Fail(`loser's P0082 carried the wrong message: ${errs[0].message}`);
    const winner = ra.ok ? "M1" : "M2";
    await expectState("P", P, x3(`ip:${winner}`));
    await expectState("Q", Q, x3(`ip:${winner}`));
    return `${winner} won; reclaim UPDATE is ${driven}-driven in this mode`;
  });

  await scenario(s("R7", "release of [ready test X + panel members] holds its locks first, reclaim queued behind the member rows -> lands whole"), async () => {
    const w = await mkW(false);
    const rel = await actor("M1", fx.med1);
    const rec = await actor("A1", fx.admin1);
    await begin(rel, mode);
    expectReleased(
      "release",
      await release(rel, w.visit, [w.x, ...w.members]),
      [w.x],
      Object.fromEntries(w.members.map((m) => [m, "not_ready"])),
    );
    await begin(rec, mode);
    const pr = reclaim(rec, w.members, x3(fx.med2), nulls(3));
    await mustWait(rec, "the reclaim queues behind the release's member row locks", "test_requests");
    await rel.c.query("commit");
    expectOk("reclaim", await pr, 3);
    await rec.c.query("commit");
    await expectState("members", w.members, x3("ip:M2"));
    if ((await releasedStatus(w.x)) !== "released") throw new Fail("X was not released");
  });

  await scenario(s("R8", "reclaim holds first, release queued behind it -> completes; no 40P01"), async () => {
    const w = await mkW(false);
    const rec = await actor("A1", fx.admin1);
    const rel = await actor("M2", fx.med2);
    await begin(rec, mode);
    expectOk("reclaim", await reclaim(rec, w.members, x3(fx.med1), nulls(3)), 3);
    await begin(rel, mode);
    const pl = release(rel, w.visit, [w.x, ...w.members]);
    await mustWait(rel, "the release queues behind the reclaim's member row locks", "test_requests");
    await rec.c.query("commit");
    expectReleased(
      "release",
      await pl,
      [w.x],
      Object.fromEntries(w.members.map((m) => [m, "not_ready"])),
    );
    await rel.c.query("commit");
    await expectState("members", w.members, x3("ip:M1"));
    if ((await releasedStatus(w.x)) !== "released") throw new Fail("X was not released");
  });

  await scenario(s("R9", "lock-order race, release first (caught mid-lock), reclaim queued -> both complete, no 40P01"), () =>
    lockOrderRace(mode, "release"),
  );
  await scenario(s("R10", "lock-order race, reclaim first (caught mid-lock), release queued -> both complete, no 40P01"), () =>
    lockOrderRace(mode, "reclaim"),
  );

  await scenario(s("R11", "release of a DIFFERENT test on the visit holds open: the reclaim does not wait"), async () => {
    const w = await mkW(false);
    const rel = await actor("M1", fx.med1);
    const rec = await actor("A1", fx.admin1);
    await begin(rel, mode);
    expectReleased("release", await release(rel, w.visit, [w.x]), [w.x], {});
    await begin(rec, mode);
    expectOk("reclaim", await mustNotWait(rec, reclaim(rec, w.members, x3(fx.med2), nulls(3)), "the release holds no member row"), 3);
    await rec.c.query("commit");
    await rel.c.query("commit");
    await expectState("members", w.members, x3("ip:M2"));
    if ((await releasedStatus(w.x)) !== "released") throw new Fail("X was not released");
  });

  await scenario(s("R12", "reclaim holds open: a release of a different test on the visit does not wait"), async () => {
    const w = await mkW(false);
    const rec = await actor("A1", fx.admin1);
    const rel = await actor("M1", fx.med1);
    await begin(rec, mode);
    expectOk("reclaim", await reclaim(rec, w.members, x3(fx.med2), nulls(3)), 3);
    await begin(rel, mode);
    expectReleased("release", await mustNotWait(rel, release(rel, w.visit, [w.x]), "the reclaim holds no row of X"), [w.x], {});
    await rel.c.query("commit");
    await rec.c.query("commit");
    await expectState("members", w.members, x3("ip:M2"));
    if ((await releasedStatus(w.x)) !== "released") throw new Fail("X was not released");
  });

  await scenario(s("R13", "a member moved out of requested with no holder commits first, reclaim queued -> P0082"), async () => {
    const mv = await actor("service_role", null);
    const r = await actor("M1", fx.med1);
    await begin(mv, mode);
    expectOk("cancel p1", await cancelMember(mv, p1), 1);
    await begin(r, mode);
    const pr = reclaim(r, P, x3(fx.med1), STARTED);
    await mustWait(r, "M1's reclaim reaches the member being moved", "test_requests");
    await mv.c.query("commit");
    expectCode("M1 reclaim", await pr, "P0082", RECLAIM_REFUSED);
    await r.c.query("rollback");
    await expectState("after", P, ["req:-", "cancelled:-", "req:-"]);
  });

  // --- S. restore --------------------------------------------------------------
  await scenario(s("S1", "manual Restore of one member commits first, panel restore queued -> P0082, other two still deleted at their original deleted_at"), async () => {
    const stamps = await setDeleted(P);
    const man = await actor("service_role (manual)", null);
    const pan = await actor("service_role (panel)", null);
    await begin(man, mode);
    expectOk("manual restore of p1", await manualRestore(man, [p1], fx.visits.P), 1);
    await begin(pan, mode);
    const pp = restore(pan, fx.visits.P, P, stamps);
    await mustWait(pan, "the panel restore queues behind the manual Restore", "visits");
    await man.c.query("commit");
    expectCode("panel restore", await pp, "P0082", RESTORE_REFUSED);
    await pan.c.query("rollback");
    await expectStamps("after", P, [stamps[0], null, stamps[2]]);
    await expectTotal("after", fx.visits.P);
  });

  await scenario(s("S2", "manual Restore rolls back -> panel restore lands whole"), async () => {
    const stamps = await setDeleted(P);
    const man = await actor("service_role (manual)", null);
    const pan = await actor("service_role (panel)", null);
    await begin(man, mode);
    expectOk("manual restore of p1", await manualRestore(man, [p1], fx.visits.P), 1);
    await begin(pan, mode);
    const pp = restore(pan, fx.visits.P, P, stamps);
    await mustWait(pan, "the panel restore queues behind the manual Restore", "visits");
    await man.c.query("rollback");
    expectOk("panel restore", await pp, 3);
    await pan.c.query("commit");
    await expectStamps("after", P, [null, null, null]);
    await expectTotal("after", fx.visits.P);
  });

  await scenario(s("S3", "two panel restores, released together -> one lands, the other P0082"), async () => {
    const stamps = await setDeleted(P);
    const a = await actor("service_role (tab 1)", null);
    const b = await actor("service_role (tab 2)", null);
    const gate = await holdRows(P);
    let ra: N;
    let rb: N;
    try {
      await begin(a, mode);
      await begin(b, mode);
      const pa = andEnd(a, restore(a, fx.visits.P, P, stamps));
      const pb = andEnd(b, restore(b, fx.visits.P, P, stamps));
      // Which tab wins the visit lock is a race between two statements fired
      // together: one must be waiting on a line (gate), the other on the visit.
      await mustWait(a, "tab 1 lined up behind the visit lock or the gate");
      await mustWait(b, "tab 2 lined up behind the visit lock or the gate");
      const ar = await waitRelations(a.pid);
      const br = await waitRelations(b.pid);
      const split = (ar.includes("visits") && br.includes("test_requests")) || (br.includes("visits") && ar.includes("test_requests"));
      if (!split) {
        throw new Fail(`unexpected wait: expected one tab on the visit and one on a line, got tab 1 [${ar.join(",")}] tab 2 [${br.join(",")}]`);
      }
      await gate.query("rollback");
      [ra, rb] = await Promise.all([pa, pb]);
    } finally {
      await gate.end();
    }
    const oks = [ra, rb].filter((o) => o.ok);
    const errs = [ra, rb].filter((o): o is Extract<N, { ok: false }> => !o.ok);
    if (oks.length !== 1 || errs.length !== 1 || errs[0].code !== "P0082") {
      throw new Fail(`expected one success + one P0082, got tab1=${tally([ra])} tab2=${tally([rb])}`);
    }
    if (!RESTORE_REFUSED.test(errs[0].message)) throw new Fail(`loser's P0082 carried the wrong message: ${errs[0].message}`);
    await expectStamps("after", P, [null, null, null]);
    await expectTotal("after", fx.visits.P);
  });

  await scenario(s("S4", "restore-then-re-delete of one member commits first (new deleted_at) -> panel restore P0082, nothing restored"), async () => {
    const stamps = await setDeleted(P);
    const other = await actor("service_role (restore+delete)", null);
    const pan = await actor("service_role (panel)", null);
    await begin(other, mode);
    expectOk("manual restore of p1", await manualRestore(other, [p1], fx.visits.P), 1);
    expectOk("re-delete of p1", await queueDelete(other, [p1], fx.visits.P), 1);
    await begin(pan, mode);
    const pp = restore(pan, fx.visits.P, P, stamps);
    await mustWait(pan, "the panel restore queues behind the restore-and-re-delete", "visits");
    await other.c.query("commit");
    expectCode("panel restore", await pp, "P0082", RESTORE_REFUSED);
    await pan.c.query("rollback");
    const got = await stampsOf(P);
    if (got[0] !== stamps[0] || got[2] !== stamps[2]) throw new Fail(`p0/p2 lost their original deleted_at: [${got.join(" | ")}]`);
    if (!got[1] || got[1] === stamps[1]) throw new Fail("p1 should be deleted at a NEW deleted_at");
    await expectTotal("after", fx.visits.P);
  });

  await scenario(s("S5", "visit soft-delete commits first, panel restore queued -> P0082 with the visit message"), async () => {
    const stamps = await setDeleted(P);
    const del = await actor("service_role (visit delete)", null);
    const pan = await actor("service_role (panel)", null);
    await begin(del, mode);
    expectOk("delete visit", await deleteVisit(del, fx.visits.P), 1);
    await begin(pan, mode);
    const pp = restore(pan, fx.visits.P, P, stamps);
    await mustWait(pan, "the panel restore queues behind the visit delete", "visits");
    await del.c.query("commit");
    const o = await pp;
    expectCode("panel restore", o, "P0082");
    if (!o.ok && !/visit itself is deleted/i.test(o.message)) throw new Fail(`wrong P0082 message: ${o.message}`);
    await pan.c.query("rollback");
    await expectStamps("after", P, stamps);
    await expectTotal("after", fx.visits.P);
  });

  await scenario(s("S6a", "release holds first: panel restore waits on the visit lock, then lands whole; no 40P01"), async () => {
    const w = await mkW(true);
    const rel = await actor("M1", fx.med1);
    const pan = await actor("service_role (panel)", null);
    await begin(rel, mode);
    expectReleased("release", await release(rel, w.visit, [w.x]), [w.x], {});
    await begin(pan, mode);
    const pp = restore(pan, w.visit, w.members, w.stamps as string[]);
    await mustWait(pan, "the restore queues behind the release's visit lock", "visits");
    await rel.c.query("commit");
    expectOk("panel restore", await pp, 3);
    await pan.c.query("commit");
    await expectStamps("members", w.members, [null, null, null]);
    if ((await releasedStatus(w.x)) !== "released") throw new Fail("X was not released");
  });

  await scenario(s("S6b", "restore holds first: release waits on the visit lock, then completes; no 40P01"), async () => {
    const w = await mkW(true);
    const pan = await actor("service_role (panel)", null);
    const rel = await actor("M1", fx.med1);
    await begin(pan, mode);
    expectOk("panel restore", await restore(pan, w.visit, w.members, w.stamps as string[]), 3);
    await begin(rel, mode);
    const pl = release(rel, w.visit, [w.x]);
    await mustWait(rel, "the release queues behind the restore's visit lock", "visits");
    await pan.c.query("commit");
    expectReleased("release", await pl, [w.x], {});
    await rel.c.query("commit");
    await expectStamps("members", w.members, [null, null, null]);
    if ((await releasedStatus(w.x)) !== "released") throw new Fail("X was not released");
  });

  await scenario(s("S8", "lock-order race, restore first (caught mid-lock), release of the members queued -> both complete, no 40P01"), () =>
    restoreReleaseRace(mode, "restore"),
  );
  await scenario(s("S9", "lock-order race, release first (caught mid-lock), restore queued -> both complete, no 40P01"), () =>
    restoreReleaseRace(mode, "release"),
  );

  // S7 / S7b: manual Restore vs panel restore on a gated member. Until 0216 this was a
  // documented FINDING (the manual Restore took the line and then the visit, the panel
  // restore the visit and then the lines: a cycle, exactly one 40P01). Both now take
  // patient (shared) -> visit FOR UPDATE -> lines, so the SECOND caller must be stopped
  // at the VISIT row before it holds any line, and no cycle can form. Asserted, not
  // reported: no 40P01, both complete or the panel restore is refused P0082 with
  // nothing restored by it, and the final state is consistent.
  await scenario(s("S7", "manual Restore first (holds the visit, waits on a gated member), panel restore queued at the VISIT -> no 40P01; manual lands, panel P0082, nothing restored by it"), async () => {
    const stamps = await setDeleted(P);
    const man = await actor("service_role (manual)", null);
    const pan = await actor("service_role (panel)", null);
    const gate = await holdRows([p1]);
    let rm: N;
    let rp: N;
    let waited: string[];
    try {
      await begin(man, mode);
      await begin(pan, mode);
      const pm = andEnd(man, manualRestore(man, [p1], fx.visits.P));
      await mustWait(man, "the manual Restore holds the visit and queues on the gated member", "test_requests");
      const pp = andEnd(pan, restore(pan, fx.visits.P, P, stamps));
      waited = await mustWait(pan, "the panel restore queues at the VISIT behind the manual Restore, before it holds any member", "visits");
      if (waited.includes("test_requests")) {
        throw new Fail(`unexpected wait: the panel restore holds a row-lock wait on a member [${waited.join(",")}] while queued at the visit`);
      }
      await gate.query("rollback");
      [rm, rp] = await Promise.all([pm, pp]);
    } finally {
      await gate.end();
    }
    const dead = [rm, rp].filter((o) => !o.ok && o.code === "40P01");
    if (dead.length) throw new Fail(`deadlock (40P01): manual=${tally([rm])} panel=${tally([rp])}`);
    expectOk("manual restore", rm, 1);
    expectCode("panel restore", rp, "P0082", RESTORE_REFUSED);
    await expectStamps("after", P, [stamps[0], null, stamps[2]]);
    await expectTotal("after", fx.visits.P);
    return "the panel restore waited on the visit; manual landed, panel P0082 with nothing restored by it";
  });

  await scenario(s("S7b", "panel restore first (holds the visit + p0, waits on a gated member), manual Restore queued at the VISIT -> no 40P01; both complete, panel whole, manual restores nothing"), async () => {
    const stamps = await setDeleted(P);
    const man = await actor("service_role (manual)", null);
    const pan = await actor("service_role (panel)", null);
    const gate = await holdRows([p1]);
    let rm: N;
    let rp: N;
    let waited: string[];
    try {
      await begin(man, mode);
      await begin(pan, mode);
      const pp = andEnd(pan, restore(pan, fx.visits.P, P, stamps));
      await mustWait(pan, "the panel restore holds the visit and p0 and queues on the gated member", "test_requests");
      const pm = andEnd(man, manualRestore(man, [p1], fx.visits.P));
      waited = await mustWait(man, "the manual Restore queues at the VISIT behind the panel restore, before it holds any line", "visits");
      await gate.query("rollback");
      [rm, rp] = await Promise.all([pm, pp]);
    } finally {
      await gate.end();
    }
    const dead = [rm, rp].filter((o) => !o.ok && o.code === "40P01");
    if (dead.length) throw new Fail(`deadlock (40P01): manual=${tally([rm])} panel=${tally([rp])}`);
    expectOk("panel restore", rp, 3);
    // The manual Restore's predicate is "deleted_at is not null": by the time it
    // gets the visit the panel has restored p1, so it matches nothing (not an error).
    expectOk("manual restore", rm, 0);
    await expectStamps("after", P, [null, null, null]);
    await expectTotal("after", fx.visits.P);
    return `the manual Restore waited on [${waited.join(",")}]; panel landed whole, manual restored nothing`;
  });
}

// Free races: no forced ordering, both sides fired together, many rounds.
// Proves nothing about WHICH interleaving happened - only that none of them
// broke the invariant.
async function freeRaces(mode: Mode, rounds: number): Promise<void> {
  const { P } = fx;
  const s = (id: string, text: string) => `[${mode}] ${id} ${text}`;
  const jitter = () => sleep(Math.floor(Math.random() * 15));

  await scenario(s("F1", `${rounds}x reclaim vs a three-way single-claim race on one panel -> never split`), async () => {
    let reclaimWon = 0;
    let reclaimRefused = 0;
    for (let i = 0; i < rounds; i++) {
      await resetAll();
      const rc = await actor("A1", fx.admin1);
      const racers = [await actor("M2", fx.med2), await actor("M3", fx.med3), await actor("M2", fx.med2)];
      for (const a of [rc, ...racers]) await begin(a, mode);
      const [ro, ...cs] = await Promise.all([
        (async () => {
          await jitter();
          return andEnd(rc, reclaim(rc, P, x3(fx.med1), nulls(3)));
        })(),
        ...racers.map(async (r, k) => {
          await jitter();
          return andEnd(r, claimOne(r, P[k]));
        }),
      ]);
      for (const c of cs) {
        if (!c.ok) throw new Fail(`round ${i}: a single claim failed ${c.code} ${c.message}`);
      }
      const got = await stateOf(P);
      if (ro.ok) {
        reclaimWon++;
        if (ro.v !== 3) throw new Fail(`round ${i}: reclaim returned ${ro.v}`);
        if (cs.some((c) => c.ok && c.v !== 0)) throw new Fail(`round ${i}: reclaim landed but a racer also claimed (${tally([ro, ...cs])})`);
        if (got.join() !== x3("ip:M1").join()) throw new Fail(`round ${i}: reclaim landed but state is [${got.join(",")}]`);
      } else {
        reclaimRefused++;
        if (ro.code !== "P0082") throw new Fail(`round ${i}: reclaim ${ro.code} ${ro.message}`);
        const want = P.map((_, k) => {
          const c = cs[k];
          return c.ok && c.v === 1 ? `ip:${NAMES[racers[k].uid as string]}` : "req:-";
        });
        if (!cs.some((c) => c.ok && c.v === 1)) throw new Fail(`round ${i}: reclaim refused with no racer having claimed`);
        if (got.join() !== want.join()) throw new Fail(`round ${i}: reclaim refused but state [${got.join(",")}] != [${want.join(",")}]`);
      }
      await closeActors();
    }
    return `reclaim won ${reclaimWon}, refused ${reclaimRefused}`;
  });

  await scenario(s("F2", `${rounds}x panel restore vs a manual Restore of a random member -> whole, or refused with nothing restored by it`), async () => {
    const t: Record<string, number> = {};
    for (let i = 0; i < rounds; i++) {
      await resetAll();
      const stamps = await setDeleted(P);
      const k = Math.floor(Math.random() * 3);
      const pan = await actor("service_role (panel)", null);
      const man = await actor("service_role (manual)", null);
      await begin(pan, mode);
      await begin(man, mode);
      const [rp, rm] = await Promise.all([
        (async () => {
          await jitter();
          return andEnd(pan, restore(pan, fx.visits.P, P, stamps));
        })(),
        (async () => {
          await jitter();
          return andEnd(man, manualRestore(man, [P[k]], fx.visits.P));
        })(),
      ]);
      // 0216: both take patient -> visit -> lines, so a 40P01 (or any error but the
      // panel's P0082 refusal) is a FAILURE here, not a tallied outcome.
      if (!rm.ok) throw new Fail(`round ${i}: manual restore ${rm.code} ${rm.message}`);
      const mRows = rm.v;
      if (!rp.ok && rp.code !== "P0082") throw new Fail(`round ${i}: panel restore ${rp.code} ${rp.message}`);
      const got = await stampsOf(P);
      if (rp.ok) {
        if (rp.v !== 3) throw new Fail(`round ${i}: panel restore returned ${rp.v}`);
        if (got.some((g) => g !== null)) throw new Fail(`round ${i}: panel restore landed but [${got.join(" | ")}]`);
      } else {
        if (rp.code === "P0082" && mRows !== 1) throw new Fail(`round ${i}: panel restore refused (P0082) although nothing changed under it`);
        // Nothing restored BY the panel call: only the manual Restore's member
        // may be live.
        for (const [j, g] of got.entries()) {
          const want = j === k && mRows === 1 ? null : stamps[j];
          if (g !== want) throw new Fail(`round ${i}: after a refused panel restore member ${j} is ${g ?? "live"} (expected ${want ?? "live"})`);
        }
      }
      await expectTotal(`round ${i}`, fx.visits.P);
      const key = rp.ok ? "panel landed" : "panel P0082";
      t[key] = (t[key] ?? 0) + 1;
      await closeActors();
    }
    return Object.entries(t).map(([a, b]) => `${a} x${b}`).join(", ");
  });
}

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

// Remove every row of the runs whose tag starts with `like` ("puc-" = every
// stale run, TAG = this run), including the journal entries the payment and
// release bridges posted for them. As one transaction under
// session_replication_role = replica (local only): the immutable-ledger guards,
// the lifecycle guard and the balance check must not veto a teardown.
async function sweepTagged(like: string): Promise<void> {
  if (!/^puc-[0-9a-f]{0,6}$/.test(like)) throw new Error(`refusing to sweep pattern ${like}`);
  const up = like.toUpperCase();
  await monitor.query("begin");
  try {
    await monitor.query("set local session_replication_role = replica");
    const stmts = [
      `create temp table puc_visits on commit drop as select id from public.visits where visit_number like 'V-${up}%'`,
      `create temp table puc_staff on commit drop as select id from auth.users where email like '${like}%@example.test'`,
      `create temp table puc_tr on commit drop as select id from public.test_requests where visit_id in (select id from puc_visits)`,
      `create temp table puc_pay on commit drop as select id from public.payments where visit_id in (select id from puc_visits)`,
      `create temp table puc_je on commit drop as
         select id from public.journal_entries
          where created_by in (select id from puc_staff)
             or (source_kind = 'test_request' and source_id in (select id from puc_tr))
             or (source_kind = 'payment' and source_id in (select id from puc_pay))`,
      `insert into puc_je
         select j.id from public.journal_entries j
          where (j.reverses in (select id from puc_je)
                 or j.id in (select o.reversed_by from public.journal_entries o
                              where o.id in (select id from puc_je) and o.reversed_by is not null))
            and j.id not in (select id from puc_je)`,
      `delete from public.journal_lines where entry_id in (select id from puc_je)`,
      `delete from public.journal_entries where id in (select id from puc_je)`,
      `delete from public.audit_log
        where actor_id in (select id from puc_staff)
           or resource_id in (select id from puc_tr) or resource_id in (select id from puc_pay)
           or resource_id in (select id from puc_visits)`,
      `delete from public.result_test_requests where test_request_id in (select id from puc_tr)`,
      `delete from public.results where uploaded_by in (select id from puc_staff)`,
      `delete from public.payments where id in (select id from puc_pay)`,
      `delete from public.test_requests where id in (select id from puc_tr)`,
      `delete from public.visits where id in (select id from puc_visits)`,
      `delete from public.patients where drm_id like 'DRM-${up}%'`,
      `delete from public.services where code like '${up}%'`,
      `delete from public.report_groups where code like '${up}%'`,
      `delete from public.staff_profiles where id in (select id from puc_staff)`,
      `delete from auth.users where id in (select id from puc_staff)`,
    ];
    for (const sql of stmts) await monitor.query(sql);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

// Anything this run minted that is still there. A leftover is a FAIL.
async function countTagged(like: string): Promise<number> {
  const up = like.toUpperCase();
  const { rows } = await monitor.query<{ n: string }>(
    `select (select count(*) from auth.users where email like $1)
          + (select count(*) from public.staff_profiles where full_name like $2)
          + (select count(*) from public.services where code like $3)
          + (select count(*) from public.report_groups where code like $3)
          + (select count(*) from public.patients where drm_id like $4)
          + (select count(*) from public.visits where visit_number like $5)
          + (select count(*) from public.test_requests where id = any($6::uuid[]))
          + (select count(*) from public.payments where id = any($7::uuid[]))
          + (select count(*) from public.results where id = any($8::uuid[]))
          + (select count(*) from public.journal_entries
              where source_id = any($6::uuid[]) or source_id = any($7::uuid[])) as n`,
    [`${like}%@example.test`, `${like}%`, `${up}%`, `DRM-${up}%`, `V-${up}%`, made.tests, made.payments, made.results],
  );
  return Number(rows[0].n);
}

async function seed(): Promise<void> {
  const users: Array<[string, string, string]> = [
    [fx.med1, "medtech", "m1"],
    [fx.med2, "medtech", "m2"],
    [fx.med3, "medtech", "m3"],
    [fx.admin1, "admin", "a1"],
  ];
  await monitor.query("begin");
  try {
    for (const [id, role, k] of users) {
      await monitor.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
        [id, `${TAG}-${k}@example.test`],
      );
      await monitor.query(
        "insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, $3, true)",
        [id, `${TAG} ${k.toUpperCase()}`, role],
      );
    }
    await monitor.query("insert into public.report_groups (id, code, name) values ($1, $2, $3)", [
      fx.group,
      TAG_UP,
      `${TAG} Chemistry`,
    ]);
    for (const [i, id] of fx.services.entries()) {
      await monitor.query(
        `insert into public.services (id, code, name, price_php, kind, section, report_group_id)
         values ($1, $2, $3, 100, 'lab_test', 'chemistry', $4)`,
        [id, `${TAG_UP}-${i}`, `${TAG} test ${i}`, fx.group],
      );
    }
    await monitor.query(
      `insert into public.services (id, code, name, price_php, kind, section)
       values ($1, $2, $3, 100, 'lab_test', 'chemistry')`,
      [fx.single, `${TAG_UP}-S`, `${TAG} single`],
    );
    await monitor.query(
      `insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
       values ($1, $2, 'Puc', 'Fixture', '1990-01-01', 'female')`,
      [fx.patient, `DRM-${TAG_UP}`],
    );
    for (const key of ["P", "Q", "R"] as const) {
      // Unpaid, total = three priced lines: a delete / restore of a member also
      // updates this row (fn_queue_delete_cascade), as it does on prod.
      await monitor.query(
        `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
         values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 300, 0)`,
        [fx.visits[key], `V-${TAG_UP}-${key}`, fx.patient],
      );
      for (const [i, id] of fx[key].entries()) {
        await monitor.query(
          `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
           values ($1, $2, $3, $4, 'requested', 100, 100)`,
          [id, fx.visits[key], fx.services[i], fx.med1],
        );
      }
    }
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

// The probe statements above are hand-copied from 0200's function bodies (the
// restore's pre-lock from 0216's re-creation of restore_panel_members). If a
// later migration changes the live text, the plans and the arrangement would be
// measured on a statement the function no longer runs: compare them with
// pg_get_functiondef (whitespace-normalised, parameters mapped back to the
// function's own names) and refuse to run on a mismatch.
function normSql(sql: string): string {
  return sql
    .replace(/::(?:uuid\[\]|timestamptz\[\]|uuid)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

async function assertProbesMatchLiveSql(): Promise<void> {
  const defs: Record<string, string> = {};
  for (const [fn, sig] of [
    ["reclaim_panel_members", "uuid[], uuid[], timestamptz[]"],
    ["restore_panel_members", "uuid, uuid[], timestamptz[]"],
  ]) {
    const { rows } = await monitor.query<{ d: string }>(`select pg_get_functiondef('public.${fn}(${sig})'::regprocedure) as d`);
    defs[fn] = normSql(rows[0].d);
  }
  const checks: Array<[string, string, string, Record<string, string>]> = [
    ["RECLAIM_UPDATE", RECLAIM_UPDATE, "reclaim_panel_members", { $1: "p_test_request_ids", $2: "p_holders", $3: "p_started_at" }],
    ["RECLAIM_PRELOCK", RECLAIM_PRELOCK.replace(/^select /, "perform "), "reclaim_panel_members", { $1: "p_test_request_ids" }],
    ["RESTORE_UPDATE", RESTORE_UPDATE, "restore_panel_members", { $1: "p_visit_id", $2: "p_test_request_ids", $3: "p_deleted_at" }],
    ["RESTORE_PRELOCK", RESTORE_PRELOCK.replace(/^select /, "perform "), "restore_panel_members", { $1: "p_test_request_ids", $2: "p_visit_id" }],
  ];
  for (const [name, sql, fn, map] of checks) {
    let probe = normSql(sql);
    for (const [k, v] of Object.entries(map)) probe = probe.split(k.toLowerCase()).join(v);
    if (!defs[fn].includes(probe)) {
      throw new Error(
        `probe statement ${name} is no longer part of the live public.${fn} (pg_get_functiondef) - the plans and lock-order arrangement would be measured on SQL the function does not run. Update the probe, then re-check the header.`,
      );
    }
  }
  console.log("  probe statements match the live function text (4/4)");
}

// Print the plan each mode gives the statements inside the functions, and fail
// a mode whose pre-lock is not LockRows over an id-ordered input.
async function printPlans(): Promise<void> {
  console.log("  prod plans (read-only EXPLAIN, 2026-09-30):");
  console.log("    pre-lock : LockRows / Index Scan using test_requests_pkey (id = ANY)");
  console.log("    reclaim  : Update / Nested Loop / Hash Join (t.id = x.id) [outer Index Scan idx_test_requests_status, inner Hash <- Function Scan x] / Index Scan visits_pkey");
  console.log("    restore  : Update / Merge Join (t.deleted_at = x.deleted_at) / Index Scan test_requests_deleted_idx + Sort x.deleted_at <- Function Scan x");
  for (const mode of REAL_MODES) {
    const tag = mode;
    const rp = await reclaimPlan(mode);
    const rs = await restorePlan(mode);
    const pl = await reclaimPrelock(mode);
    const pr = await restorePrelock(mode);
    console.log(`  plan [${tag}] reclaim pre-lock:  ${flat(pl)}`);
    console.log(`  plan [${tag}] reclaim UPDATE:    ${flat(rp)}   (${drivenBy(rp)}-driven)`);
    console.log(`  plan [${tag}] restore pre-lock:  ${flat(pr)}`);
    console.log(`  plan [${tag}] restore UPDATE:    ${flat(rs)}   (${drivenBy(rs)}-driven)`);
    const shapeRc = prodReclaimShape(rp);
    const shapeRs = prodRestoreShape(rs);
    console.log(`  plan [${tag}] prod shape reproduced: reclaim ${shapeRc ? "yes" : "no"}, restore ${shapeRs ? "yes" : "no"}`);
    if (mode === "indexed") {
      // Indexed mode exists to stand in for prod's plans: if the local planner
      // stops producing them, say so instead of quietly proving less.
      const ok = shapeRc && shapeRs;
      const name = "plan [indexed] reproduces prod's reclaim and restore plan shapes";
      results.push({
        name,
        ok,
        detail: ok ? "" : `reclaim ${shapeRc ? "yes" : "NO"}, restore ${shapeRs ? "yes" : "NO"} - re-check the header's prod plans and this mode's GUCs`,
      });
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : " - re-check the header's prod plans and this mode's GUCs"}`);
    }
    for (const [what, lines] of [
      ["reclaim", pl],
      ["restore", pr],
    ] as const) {
      const ok = lockPlanOk(lines);
      const name = `plan [${mode}] ${what} pre-lock is LockRows over an id-ordered input`;
      results.push({ name, ok, detail: ok ? "" : lines.join(" / ") });
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Control rounds (--control): prove the proof can fail
// ---------------------------------------------------------------------------
//
// Each mutant is a copy of the two live 0200 functions with one guard removed,
// created in a throwaway schema (never in public - the local stack is shared,
// so other sessions keep calling the real functions throughout). The forced
// scenarios run against the copy, and the round PASSES only when every
// scenario named in `mustFail` fails in every mode it runs in. Mutant E has no
// `mustFail`: it is informational (see the header).

type FnName = "reclaim_panel_members" | "restore_panel_members";

// A mutant is CAUGHT by a scenario only when that scenario fails for the
// expected reason (a regex over its Fail text). Anything else - a scenario that
// failed because the interleaving was not reached, a wait that never happened,
// a timeout - is infrastructure, not detection, and fails the round.
interface Catch {
  id: string;
  reason: RegExp;
}

interface Mutant {
  key: string;
  what: string;
  fn: FnName;
  from: string;
  to: string;
  mustFail: Catch[]; // empty = informational
  modes: Mode[];
}

const INFRA =
  /interleaving not reached|never waited|did not answer|connection cap|could not make|blocked on a row lock but should|plan shape changed|canceling statement|lock timeout|terminating connection|connection error|Connection terminated|ECONN|fixture:/i;
// The mutant's guard let a refused call through.
const SUCCEEDED = /expected P0082, but it succeeded/;
const DEADLOCK = /deadlock \(40P01\)/;
// A queued restore / Restore was seen waiting on a member row instead of the visit row
// (the visit lock it should have stopped at is gone).
const WAIT_NOT_ON_VISIT = /unexpected wait: service_role \((?:panel|manual)\) waited on a row of \[test_requests\], not visits/;

const MUTANTS: Mutant[] = [
  {
    key: "A",
    what: "reclaim keeps whatever matched (no row-count check)",
    fn: "reclaim_panel_members",
    from: "if v_reclaimed <> v_wanted then",
    to: "if false then",
    mustFail: [
      { id: "R1", reason: SUCCEEDED },
      { id: "R4", reason: SUCCEEDED },
      { id: "R13", reason: SUCCEEDED },
    ],
    modes: REAL_MODES,
  },
  {
    key: "B",
    what: "reclaim ignores status (only unassigned + live)",
    fn: "reclaim_panel_members",
    from: "and t.status = 'requested'",
    to: "",
    mustFail: [{ id: "R13", reason: SUCCEEDED }],
    modes: REAL_MODES,
  },
  {
    key: "C",
    what: "restore keeps whatever matched (no row-count check)",
    fn: "restore_panel_members",
    from: "if v_restored <> v_wanted then",
    to: "if false then",
    mustFail: [
      { id: "S1", reason: SUCCEEDED },
      { id: "S4", reason: SUCCEEDED },
    ],
    modes: REAL_MODES,
  },
  {
    key: "D",
    what: "restore ignores the deleted_at stamp",
    fn: "restore_panel_members",
    from: "and t.deleted_at = x.deleted_at",
    to: "",
    mustFail: [{ id: "S4", reason: SUCCEEDED }],
    modes: REAL_MODES,
  },
  {
    key: "F",
    what: "restore without its visit lock (the visit is only read, not FOR UPDATE)",
    fn: "restore_panel_members",
    from: "from public.visits v where v.id = p_visit_id for update;",
    to: "from public.visits v where v.id = p_visit_id;",
    mustFail: [
      { id: "S1", reason: WAIT_NOT_ON_VISIT },
      { id: "S5", reason: SUCCEEDED },
      { id: "S7", reason: WAIT_NOT_ON_VISIT },
      { id: "S7b", reason: WAIT_NOT_ON_VISIT },
      { id: "S8", reason: DEADLOCK },
    ],
    modes: REAL_MODES,
  },
  {
    key: "E",
    what: "reclaim without the id-ordered pre-lock (informational)",
    fn: "reclaim_panel_members",
    from: `  perform 1 from public.test_requests t
   where t.id = any (p_test_request_ids)
   order by t.id
     for no key update;`,
    to: "",
    mustFail: [],
    modes: REAL_MODES,
  },
];

async function controlRounds(): Promise<void> {
  const schema = `puc_ctl_${TAG.slice(4)}`;
  const defs: Record<string, string> = {};
  for (const [fn, sig] of [
    ["reclaim_panel_members", "uuid[], uuid[], timestamptz[]"],
    ["restore_panel_members", "uuid, uuid[], timestamptz[]"],
  ]) {
    const { rows } = await monitor.query<{ d: string }>(
      `select pg_get_functiondef('public.${fn}(${sig})'::regprocedure) as d`,
    );
    defs[fn] = rows[0].d.replace(`FUNCTION public.${fn}(`, `FUNCTION ${schema}.${fn}(`);
  }

  // PUC_MUTANTS=E,A runs just those mutants (debugging aid, like PUC_ONLY).
  const only = process.env.PUC_MUTANTS ? process.env.PUC_MUTANTS.split(",") : null;
  for (const m of MUTANTS) {
    if (only && !only.includes(m.key)) continue;
    if (!defs[m.fn].includes(m.from)) throw new Error(`control ${m.key}: "${m.from}" not found in ${m.fn}`);
    await monitor.query(`drop schema if exists ${schema} cascade`);
    await monitor.query(`create schema ${schema}`);
    try {
      for (const [fn, def] of Object.entries(defs)) {
        await monitor.query(fn === m.fn ? def.replace(m.from, m.to) : def);
      }
      await monitor.query(`grant usage on schema ${schema} to authenticated, service_role`);
      await monitor.query(`grant execute on all functions in schema ${schema} to authenticated, service_role`);

      console.log(`\ncontrol ${m.key}: ${m.what}`);
      const caught: Result[] = [];
      sink = caught;
      fnSchema = schema;
      for (const mode of m.modes) await forcedScenarios(mode);
      const failedRes = caught.filter((r) => !r.ok);
      const idOf = (n: string) => n.split(" ")[1];
      const failedIn = (mode: Mode) =>
        failedRes.filter((r) => r.name.startsWith(`[${mode}] `)).map((r) => ({ id: idOf(r.name), detail: r.detail }));
      // Any scenario that failed for an infrastructure reason makes the round
      // untrustworthy, named or not.
      const infra = failedRes.filter((r) => INFRA.test(r.detail)).map((r) => `${r.name.split(" ").slice(0, 2).join(" ")}: ${r.detail.slice(0, 120)}`);

      if (m.mustFail.length === 0) {
        // Informational: report per mode what caught it AS AN OUTCOME (a real
        // deadlock) and what merely tripped, and never fake a failure.
        const lines = m.modes.map((mode) => {
          const f = failedIn(mode);
          const outcome = f.filter((x) => DEADLOCK.test(x.detail) && !INFRA.test(x.detail)).map((x) => x.id);
          const other = f.filter((x) => !outcome.includes(x.id)).map((x) => x.id);
          return `${mode}: ${outcome.length ? `caught as a deadlock by ${outcome.join(", ")}` : "NOT caught as an outcome"}${other.length ? ` (also tripped, not an outcome: ${other.join(", ")})` : ""}`;
        });
        const any = m.modes.some((mode) => failedIn(mode).some((x) => DEADLOCK.test(x.detail) && !INFRA.test(x.detail)));
        const ok = infra.length === 0;
        const detail = `${lines.join("; ")}${any ? "" : " - the pre-lock is belt-and-braces under every plan tried"}${ok ? "" : ` - INFRASTRUCTURE FAILURES: ${infra.join(" | ")}`}`;
        results.push({ name: `control ${m.key} (${m.what})`, ok, detail });
        console.log(`  ${ok ? "INFO" : "FAIL"}  control ${m.key} - ${detail}`);
        continue;
      }
      const missed = m.modes.flatMap((mode) =>
        m.mustFail.flatMap((c) => {
          const hit = caught.find((r) => r.name.startsWith(`[${mode}] ${c.id} `));
          if (!hit || hit.ok) return [`[${mode}] ${c.id} did not fail`];
          if (INFRA.test(hit.detail)) return [`[${mode}] ${c.id} failed for an infrastructure reason (${hit.detail.slice(0, 100)})`];
          if (!c.reason.test(hit.detail)) return [`[${mode}] ${c.id} failed for the wrong reason (${hit.detail.slice(0, 100)})`];
          return [];
        }),
      );
      const ok = missed.length === 0 && infra.length === 0;
      const detail = ok
        ? `caught by ${m.mustFail.map((c) => `${c.id} [${c.reason.source}]`).join(", ")} in ${m.modes.join(" + ")} (${failedRes.length} scenario failure(s) in all)`
        : [...missed, ...infra.map((i) => `infrastructure failure ${i}`)].join("; ");
      results.push({ name: `control ${m.key} (${m.what})`, ok, detail });
      console.log(`  ${ok ? "PASS" : "FAIL"}  control ${m.key} - ${detail}`);
    } finally {
      sink = results;
      fnSchema = "public";
      await monitor.query(`drop schema if exists ${schema} cascade`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Remove this run's fixtures (and its control schema) and prove none are left.
async function teardown(): Promise<void> {
  await closeActors();
  await monitor.query(`drop schema if exists puc_ctl_${TAG.slice(4)} cascade`);
  await sweepTagged(TAG);
  const left = await countTagged(TAG);
  if (left > 0) {
    results.push({ name: "teardown", ok: false, detail: `${left} fixture rows left behind` });
    console.log(`  FAIL  teardown - ${left} fixture rows left behind`);
  } else {
    console.log("  teardown: every fixture row removed (0 tagged rows left)");
  }
}

async function main(): Promise<void> {
  const rawRounds = process.env.PUC_ROUNDS ?? "25";
  if (!/^[1-9]\d*$/.test(rawRounds)) {
    console.error(`[panel-undo:concurrency-proof] PUC_ROUNDS must be an integer >= 1 (got "${rawRounds}").`);
    process.exit(2);
  }
  const rounds = Number(rawRounds);
  monitor = await connect();

  // One run at a time on the shared stack: the startup sweep below removes
  // EVERY puc- fixture, which would pull a concurrent run's live rows out from
  // under it. Session-level, so it lasts until the monitor disconnects.
  const { rows: lock } = await monitor.query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtext('panel-undo:concurrency-proof')) as got",
  );
  if (!lock[0].got) {
    console.error("[panel-undo:concurrency-proof] another run is in progress on this stack - try again when it finishes.");
    await monitor.end();
    process.exit(3);
  }

  let seeded = false;
  // Ctrl-C: tear down before exiting, so committed fixtures never outlive the
  // run (open transactions roll back when their connections close).
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.log(`\n  ${sig} - tearing down`);
      teardown()
        .catch((e) => console.error(e))
        .finally(() => process.exit(130));
    });
  }
  try {
    const { rows: fn } = await monitor.query<{ n: string }>(
      "select count(*) as n from pg_proc where proname in ('reclaim_panel_members', 'restore_panel_members', 'release_visit_results', 'claim_panel_members')",
    );
    if (Number(fn[0].n) !== 4) throw new Error("0191 / 0198 / 0200 are not all applied to the local stack");
    await assertProbesMatchLiveSql();

    await sweepTagged("puc-");
    // Control-round schemas a crashed run left behind (always puc_ctl_<hex>).
    const { rows: stale } = await monitor.query<{ n: string }>(
      "select nspname as n from pg_namespace where nspname ~ '^puc_ctl_[0-9a-f]{6}$'",
    );
    for (const { n } of stale) await monitor.query(`drop schema ${n} cascade`);
    console.log(`panel-undo concurrency proof - fixtures tagged ${TAG}`);
    await seed();
    seeded = true;
    // The plans below depend on table statistics AND on the heap's size, and on
    // this stack (a few rows, churned by every run) autovacuum lags the sweep +
    // seed above by arbitrary amounts: a bloated heap from the previous run
    // flipped the reclaim UPDATE between prod's table-driven shape and an
    // array-driven Nested Loop. VACUUM (ANALYZE) first, so the plan the run
    // measures is the plan for the data it actually has. It writes no rows and
    // blocks no DML.
    await monitor.query("vacuum (analyze) public.test_requests, public.visits");
    await printPlans();

    for (const mode of REAL_MODES) {
      await forcedScenarios(mode);
      await freeRaces(mode, rounds);
    }
    if (process.argv.includes("--control")) await controlRounds();
  } finally {
    if (seeded || (await countTagged(TAG)) > 0) await teardown();
    else await closeActors();
    await monitor.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (peak open connections ${peakConnections}/${MAX_CONNECTIONS})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
