// Hand-run local CONCURRENCY proof for the atomic report release functions
// (supabase/migrations/0198_atomic_report_release.sql, P0081):
// release_visit_results / undo_visit_release (+ their private helpers
// release_actor and release_report_locks).
//
// The bug 0198 fixes: a combined report {A released, B ready} and a release
// (UPDATE ... WHERE status = 'ready_for_release') racing an undo
// (UPDATE ... WHERE status = 'released') touch DIFFERENT rows, so neither ever
// waits for the other, both commit, and the report ends {A ready, B released}:
// split. Both functions now lock the same rows in the same order (result
// membership shared -> patient shared -> visit FOR SHARE -> every member and
// package header FOR NO KEY UPDATE, ORDER BY id) and plan on what the winner
// committed. This runner proves that with separate `pg` connections, each
// acting as `authenticated` with its own JWT `sub` (invoker rights, so the
// medtech section rule, RLS and 0190's holder guard apply exactly as for the
// staff server client), and payment writes as `service_role` with the app's
// exact SQL.
//
// DETERMINISTIC, NOT LUCKY. Every forced scenario holds one side's row locks in
// an open transaction, starts the other side, and does not move on until
// pg_locks shows that backend waiting on a row lock (or, for the "must not
// wait" cases, until it has answered while the first side is still open). If
// the intended interleaving is not reached the scenario FAILS - it never
// silently degrades into a sequential run. Only section F (free races) relies
// on timing, and it asserts the invariants alone.
//
// SCENARIOS (every forced one runs in BOTH plan modes)
//   A   release vs release on one 3-member report: the second WAITS, then
//       answers "nothing released, ids not_ready"; released_by = the winner;
//       exactly one posted journal entry per member.
//   B1  release holds -> undo (admin) WAITS -> release commits -> undo undoes
//       all three (each release journal entry reversed, none left posted).
//   B2  undo holds -> release WAITS -> undo commits -> release releases all
//       three (one posted journal entry each). The report is never split.
//   C1  a member held (in_progress) by M2 and being handed back: the release
//       WAITS (it locks every member), then is refused report_not_finished.
//   C2  the release holds first: refused report_not_finished at once, and the
//       hand-back WAITS on the member the release locked - no deadlock.
//   C3  claim of an all-requested report vs a release of it (both orders):
//       release refused, the claim wins whole.
//   D1  payment void holds -> release WAITS (visit FOR SHARE vs the recalc's
//       FOR UPDATE) -> void commits -> release fails the payment gate (23514).
//   D2  release holds -> void WAITS -> both commit: released, one release
//       journal entry per member, one payment reversal, visit now unpaid.
//   D3  the same pair with correct_payment (an Edit that lowers the amount),
//       edit holds; D4 release holds.
//   E   package siblings: two releases of X and Y (components of header H)
//       serialise on H's lock, so H auto-releases exactly once.
//   F   RRC_ROUNDS (default 25) free rounds of release-vs-undo and
//       release-vs-release, random 0-20 ms stagger: invariants only.
//   B-legacy (documentation, not counted): the pre-0198 app statements, forced
//       to overlap, DO split the report - prints "legacy path splits: yes/no".
//
// NO APP PATH HARD-DELETES A PAYMENT. Every app write voids (voided_at) or
// re-creates through correct_payment; the only DELETE FROM payments live in
// scripts (smoke fixtures' teardown). bridge_payment_delete exists but is
// unreachable from the staff or portal code, so there is no delete scenario.
//
// TWO PLAN MODES. Lock order is the SORT order inside release_report_locks:
// `select 1 from test_requests where id = any(..) and visit_id = .. order by id
// for no key update` plans as LockRows over an id-ordered input whatever the
// scan. Read-only EXPLAIN on prod (2026-09-30):
//   LockRows -> Sort (Sort Key: id) -> Index Scan using idx_test_requests_visit_id
//     (Index Cond: visit_id = ..., Filter: id = ANY(..))
// and the release UPDATE on prod: Update -> Index Scan using
// idx_test_requests_status (status = 'ready_for_release'), Filter: deleted_at
// is null, id = ANY(..), visit_id - it only touches rows already locked.
// "seq" is the local default plan and "indexed" adds `set local enable_seqscan
// = off; set local enable_bitmapscan = off` in every actor's transaction.
// Which scan the planner picks for the lock statement depends on the local
// table size (a small stack seq-scans; a larger one already picks
// idx_test_requests_visit_id, matching prod; with seq/bitmap scans off and no
// visit index it would walk test_requests_pkey, which is id-ordered without a
// Sort). The runner prints both plans first and FAILS a mode whose plan is not
// LockRows over an id-ordered input (a Sort on id, or the pkey index scan).
//
// FIXTURES. Two connections cannot see each other's uncommitted rows, so the
// fixtures are COMMITTED: three staff (auth.users + staff_profiles: medtech
// M1, medtech M2, admin A), one report group with three chemistry services,
// one package service with two component services, one patient, and a fresh
// visit + tests + payment + combined report per scenario. Every row carries a
// per-run tag (`rrc-<hex>` / `RRC-<HEX>`); stale rows from a crashed run are
// swept before seeding, and the `finally` deletes everything (and the journal
// entries the payment/release bridges posted for it) and proves nothing tagged
// is left. It never touches rows it did not mint.
//
// Run (local stack, 0198 applied):
//   npm run report-release:concurrency-proof               # 2 modes, 25 free rounds
//   npm run report-release:concurrency-proof -- --control  # + control rounds
//   RRC_ROUNDS=100 npm run report-release:concurrency-proof
//
// CONTROL ROUNDS (--control) prove the proof can fail: each copies the four
// live functions into a throwaway schema (rrc_ctl_<hex>, never public) with ONE
// guard removed, reruns the named forced scenarios against the copy, and
// passes only if they FAIL in both modes (see MUTANTS): M1 drops the row locks
// (B1/B2), M2 drops the whole-report rule (C1), M3 drops the visit lock (D1),
// M4 drops the package-header lock (E). The control rounds do NOT cover the
// guards that live in triggers on public tables (the payment gate, the consent
// gate, the GL bridge's one-posted-entry unique index, fn_release_header_when_
// components_done): a trigger on a public table fires for every session, so a
// mutant of it cannot be isolated. Those triggers are exercised - not mutated -
// by A, D1 and E.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";

requireLocalOrExplicitProd("report-release:concurrency-proof", {
  writes:
    "throwaway fixtures tagged rrc-<hex> (staff, services, a patient, visits, tests, payments, results and the journal entries their bridges post), committed so connections can race on them, then deleted",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Belt-and-suspenders on top of the guard above: this script COMMITS rows, so
// it must never run against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(
    `[report-release:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script commits fixtures and only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `rrc-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();

const fx = {
  med1: randomUUID(),
  med2: randomUUID(),
  admin1: randomUUID(),
  group: randomUUID(),
  services: [randomUUID(), randomUUID(), randomUUID()],
  pkgService: randomUUID(),
  compServices: [randomUUID(), randomUUID()],
  patient: randomUUID(),
};

const NAMES: Record<string, string> = {
  [fx.med1]: "M1",
  [fx.med2]: "M2",
  [fx.admin1]: "A",
};

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type Mode = "seq" | "indexed";

// Where the functions under test live: public, or a --control mutant schema.
let fnSchema = "public";

interface Actor {
  name: string;
  uid: string | null; // null = service_role (the payment writes' admin client)
  c: Client;
  pid: number;
}

let monitor: Client; // postgres; seeds, reads committed state, watches waits
const open: Actor[] = [];
const everPids = new Set<number>();

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  // A forced wait that never resolves must fail the run, not hang it.
  await c.query("set statement_timeout = '20s'");
  return c;
}

// A fresh connection per actor per scenario: plpgsql caches its statement
// plans per session, so reusing a connection across modes would keep the
// first mode's plan.
async function actor(name: string, uid: string | null): Promise<Actor> {
  const c = await connect();
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  const a = { name, uid, c, pid: rows[0].pid };
  open.push(a);
  everPids.add(a.pid);
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
  indexed: ["set local enable_seqscan = off", "set local enable_bitmapscan = off"],
};

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
  for (const g of MODE_GUCS[mode]) await a.c.query(g);
}

// ---------------------------------------------------------------------------
// The calls, exactly as the app issues them
// ---------------------------------------------------------------------------

type Out<T> = { ok: true; v: T } | { ok: false; code: string; message: string };

interface ReleaseJson {
  released: Array<{ id: string; name: string; report_id: string | null; selected: boolean; released_at: string }>;
  refused: Array<{ id: string; code: string; report_id: string | null; count: number }>;
}
interface UndoJson {
  undone: Array<{ id: string; prior_release_medium: string | null; report_id: string | null }>;
  skipped: Array<{ id: string; code: string }>;
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

// releaseVisitSelection -> rpc("release_visit_results")
function release(a: Actor, visit: string, ids: readonly string[]): Promise<Out<ReleaseJson>> {
  return settle(
    a.c.query(`select ${fnSchema}.release_visit_results($1::uuid, $2::uuid[], 'email') as r`, [visit, ids]),
    (r) => r.rows[0].r as ReleaseJson,
  );
}

// undo release -> rpc("undo_visit_release")
// `expected` = the batch Undo map (id -> released_at of the release it made).
function undo(a: Actor, visit: string, ids: readonly string[], expected?: Record<string, string>): Promise<Out<UndoJson>> {
  return settle(
    a.c.query(`select ${fnSchema}.undo_visit_release($1::uuid, $2::uuid[], null, $3::jsonb) as r`, [
      visit,
      ids,
      expected ? JSON.stringify(expected) : null,
    ]),
    (r) => r.rows[0].r as UndoJson,
  );
}

// unclaimPanelMembers -> rpc("unclaim_panel_members") / claimPanelMembers
function unclaim(a: Actor, ids: readonly string[], holders: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query("select public.unclaim_panel_members($1::uuid[], $2::uuid[]) as n", [ids, holders]),
    (r) => Number(r.rows[0].n),
  );
}
function claim(a: Actor, ids: readonly string[]): Promise<Out<number>> {
  return settle(a.c.query("select public.claim_panel_members($1::uuid[]) as n", [ids]), (r) => Number(r.rows[0].n));
}

// voidPaymentAction's UPDATE (payments/[id]/void/actions.ts), issued through
// the service-role admin client.
function voidPayment(a: Actor, paymentId: string): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.payments
          set voided_at = $2, voided_by = $3, void_reason = $4
        where id = $1 and voided_at is null
        returning id`,
      [paymentId, new Date().toISOString(), fx.admin1, `Recorded twice: ${TAG} concurrency proof`],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// The Edit-payment action's RPC (payments/[id]/edit/actions.ts), service role.
function editPayment(a: Actor, paymentId: string, visit: string, from: number, to: number): Promise<Out<string>> {
  return settle(
    a.c.query(
      `select public.correct_payment(
         p_payment_id := $1::uuid, p_amount_php := $2::numeric, p_method := 'cash',
         p_reference_number := null, p_notes := null, p_reason := $3::text,
         p_actor_id := $4::uuid, p_expected := $5::jsonb) as id`,
      [paymentId, to, `${TAG} concurrency proof`, fx.admin1, JSON.stringify({ amount_php: from, visit_id: visit })],
    ),
    (r) => String(r.rows[0].id),
  );
}

// The PRE-0198 app statements (release-rows.ts before #266's RPC), verbatim.
function legacyRelease(a: Actor, visit: string, ids: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.test_requests
          set status = 'released', released_at = now(), release_medium = 'other'
        where id = any($1::uuid[]) and visit_id = $2 and status = 'ready_for_release' and deleted_at is null
        returning id`,
      [ids, visit],
    ),
    (r) => r.rowCount ?? 0,
  );
}
function legacyUndo(a: Actor, visit: string, ids: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.test_requests
          set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null
        where id = any($1::uuid[]) and visit_id = $2 and status = 'released'
          and is_package_header = false and deleted_at is null
        returning id`,
      [ids, visit],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// Commit on success, roll back on refusal - the moment the call answers, the
// way PostgREST ends each RPC's transaction. Racers must never wait for each
// other's answers before ending their own: the loser is queued behind the
// winner's still-open transaction.
function andEnd<T>(a: Actor, p: Promise<Out<T>>): Promise<Out<T>> {
  // Never rejects: a scenario that throws early closes its connections while
  // these are still pending, and an unhandled rejection there would kill the
  // process before the fixtures are torn down.
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

// Waiting on a ROW: an ungranted transactionid (queued behind the holder's
// transaction) or tuple lock. A relation-level wait - another session's DDL on
// the shared stack - does not count, so it can neither fake a forced
// interleaving nor fail a "must not wait" case.
async function waitingOnLock(pid: number): Promise<boolean> {
  const { rows } = await monitor.query(
    "select 1 from pg_locks where pid = $1 and not granted and locktype in ('transactionid', 'tuple')",
    [pid],
  );
  return rows.length > 0;
}

// Strict: the actor's in-flight statement must be observed blocked on a row
// lock within ~5s, or the interleaving was not achieved.
async function mustWait(a: Actor, why: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await waitingOnLock(a.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Fail(`interleaving not reached: ${a.name} never waited on a lock (${why})`);
}

// The opposite: the call must answer while the other side is still open,
// without ever blocking on a lock.
async function mustNotWait<T>(a: Actor, p: Promise<Out<T>>, why: string): Promise<Out<T>> {
  let done = false;
  const tracked = p.then((o) => {
    done = true;
    return o;
  });
  for (let i = 0; i < 50 && !done; i++) {
    if (!done && (await waitingOnLock(a.pid))) {
      throw new Fail(`${a.name} blocked on a lock but should have answered at once (${why})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!done) throw new Fail(`${a.name} did not answer within 5s (${why})`);
  return tracked;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture builders (committed, as postgres)
// ---------------------------------------------------------------------------

type St = "ready" | "released" | "in_progress" | "requested";

interface Fix {
  visit: string;
  ids: string[]; // members, ascending uuid order
  result: string | null;
  payment: string | null;
}

let visitSeq = 0;
// Every id this run minted that a leftover check can look up by primary key.
const made = { tests: [] as string[], payments: [] as string[], results: [] as string[] };

// A visit of `states.length` chemistry lines (100 each) on ONE combined report
// (when 2+ members), paid by one payment of the full total unless paid=false.
// states[i] is the state of ids[i] (ids sorted ascending, so ids[0] is the
// lowest lock order). "released" rows are released as postgres AFTER payment so
// the GL bridge posts their journal entry exactly as in production.
async function mkFix(spec: { states: St[]; holder?: string; paid?: boolean }): Promise<Fix> {
  const n = spec.states.length;
  const ids = Array.from({ length: n }, () => randomUUID()).sort();
  const visit = randomUUID();
  const result = n >= 2 ? randomUUID() : null;
  const payment = spec.paid === false ? null : randomUUID();
  const seq = ++visitSeq;
  made.tests.push(...ids);
  if (payment) made.payments.push(payment);
  if (result) made.results.push(result);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', $4, 0)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient, 100 * n],
    );
    for (const [i, id] of ids.entries()) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
         values ($1, $2, $3, $4, 'requested', 100, 100)`,
        [id, visit, fx.services[i % 3], fx.med1],
      );
    }
    if (payment) {
      await monitor.query(
        "insert into public.payments (id, visit_id, amount_php, method, received_by) values ($1, $2, $3, 'cash', $4)",
        [payment, visit, 100 * n, fx.admin1],
      );
    }
    if (result) {
      await monitor.query("insert into public.results (id, uploaded_by) values ($1, $2)", [result, fx.med1]);
      for (const id of ids) {
        await monitor.query("insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)", [
          result,
          id,
        ]);
      }
    }
    for (const [i, st] of spec.states.entries()) {
      if (st === "ready" || st === "released") {
        await monitor.query("update public.test_requests set status = 'ready_for_release' where id = $1", [ids[i]]);
      }
      if (st === "released") {
        await monitor.query(
          `update public.test_requests
              set status = 'released', released_at = now(), released_by = $2, release_medium = 'other'
            where id = $1`,
          [ids[i], fx.med2],
        );
      }
      if (st === "in_progress") {
        await monitor.query(
          "update public.test_requests set status = 'in_progress', assigned_to = $2, started_at = now() where id = $1",
          [ids[i], spec.holder ?? fx.med2],
        );
      }
    }
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, ids, result, payment };
}

interface PkgFix {
  visit: string;
  header: string;
  x: string;
  y: string;
  payment: string;
}

// Package visit: header H (a real lab_package service, 100) with components X
// and Y (parent_id = H, 0 each), all ready_for_release, no combined report,
// paid by one payment of 100.
async function mkPackage(): Promise<PkgFix> {
  const visit = randomUUID();
  const header = randomUUID();
  const [x, y] = [randomUUID(), randomUUID()].sort();
  const payment = randomUUID();
  const seq = ++visitSeq;
  made.tests.push(header, x, y);
  made.payments.push(payment);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 100, 0)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient],
    );
    await monitor.query(
      `insert into public.test_requests (id, visit_id, service_id, requested_by, status, is_package_header, base_price_php, final_price_php)
       values ($1, $2, $3, $4, 'requested', true, 100, 100)`,
      [header, visit, fx.pkgService, fx.med1],
    );
    for (const [i, id] of [x, y].entries()) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, parent_id, base_price_php, final_price_php)
         values ($1, $2, $3, $4, 'requested', $5, 0, 0)`,
        [id, visit, fx.compServices[i], fx.med1, header],
      );
    }
    await monitor.query(
      "insert into public.payments (id, visit_id, amount_php, method, received_by) values ($1, $2, 100, 'cash', $3)",
      [payment, visit, fx.admin1],
    );
    await monitor.query("update public.test_requests set status = 'ready_for_release' where visit_id = $1", [visit]);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, header, x, y, payment };
}

// ---------------------------------------------------------------------------
// Committed-state readers and assertions (monitor connection)
// ---------------------------------------------------------------------------

const SHORT: Record<string, string> = {
  ready_for_release: "rdy",
  released: "rel",
  in_progress: "ip",
  requested: "req",
  result_uploaded: "up",
  cancelled: "can",
};

// "st:holder" per member in the order given: `rdy:-`, `rel:M1`, `ip:M2`.
async function stateOf(ids: readonly string[]): Promise<string[]> {
  const { rows } = await monitor.query<{
    id: string;
    status: string;
    assigned_to: string | null;
    released_by: string | null;
  }>("select id, status, assigned_to, released_by from public.test_requests where id = any($1::uuid[])", [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return "missing";
    const who = r.status === "released" ? r.released_by : r.assigned_to;
    return `${SHORT[r.status] ?? r.status}:${who ? (NAMES[who] ?? "??") : "-"}`;
  });
}

async function expectState(label: string, ids: readonly string[], want: string[]): Promise<void> {
  const got = await stateOf(ids);
  if (got.join(",") !== want.join(",")) {
    throw new Fail(`${label}: expected [${want.join(",")}], got [${got.join(",")}]`);
  }
}

// Never split: every member of a combined report shares one status.
async function expectUniform(label: string, ids: readonly string[]): Promise<string> {
  const { rows } = await monitor.query<{ status: string }>(
    "select status from public.test_requests where id = any($1::uuid[])",
    [ids],
  );
  const set = new Set(rows.map((r) => r.status));
  if (set.size !== 1) throw new Fail(`${label}: SPLIT report [${rows.map((r) => SHORT[r.status] ?? r.status).join(",")}]`);
  return rows[0].status;
}

interface JeCount {
  posted: number;
  reversed: number;
}

// Release journal entries per member (source_kind 'test_request'): posted =
// live, reversed = an undone release (the undo bridge posts a mirror entry
// under source_kind 'reversal' and flips the original to 'reversed').
async function jeCounts(ids: readonly string[]): Promise<JeCount[]> {
  const { rows } = await monitor.query<{ source_id: string; status: string; n: number }>(
    `select source_id, status, count(*)::int as n from public.journal_entries
      where source_kind = 'test_request' and source_id = any($1::uuid[]) group by 1, 2`,
    [ids],
  );
  return ids.map((id) => ({
    posted: rows.find((r) => r.source_id === id && r.status === "posted")?.n ?? 0,
    reversed: rows.find((r) => r.source_id === id && r.status === "reversed")?.n ?? 0,
  }));
}

async function expectJes(label: string, ids: readonly string[], want: JeCount[]): Promise<void> {
  const got = await jeCounts(ids);
  const fmt = (xs: JeCount[]) => xs.map((x) => `${x.posted}p/${x.reversed}r`).join(",");
  if (fmt(got) !== fmt(want)) throw new Fail(`${label}: journal entries expected [${fmt(want)}], got [${fmt(got)}]`);
}

async function visitMoney(visit: string): Promise<{ status: string; paid: number }> {
  const { rows } = await monitor.query<{ payment_status: string; paid_php: string }>(
    "select payment_status, paid_php from public.visits where id = $1",
    [visit],
  );
  return { status: rows[0].payment_status, paid: Number(rows[0].paid_php) };
}

function expectOk<T>(label: string, o: Out<T>): T {
  if (!o.ok) throw new Fail(`${label}: expected success, got ${o.code} ${o.message}`);
  return o.v;
}

function expectCode<T>(label: string, o: Out<T>, code: string): void {
  if (o.ok) throw new Fail(`${label}: expected ${code}, but it succeeded`);
  if (o.code !== code) throw new Fail(`${label}: expected ${code}, got ${o.code} ${o.message}`);
}

// A release answer: how many released and which refusal codes (code -> ids).
// `count` (report_not_finished) is checked when given.
function expectRelease(
  label: string,
  o: Out<ReleaseJson>,
  want: { released: number; refused?: Record<string, number>; count?: number },
): void {
  const v = expectOk(label, o);
  if (v.released.length !== want.released) {
    throw new Fail(`${label}: expected ${want.released} released, got ${v.released.length}`);
  }
  const got: Record<string, number> = {};
  for (const r of v.refused) got[r.code] = (got[r.code] ?? 0) + 1;
  const wantRefused = want.refused ?? {};
  if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(wantRefused).sort())) {
    throw new Fail(`${label}: expected refusals ${JSON.stringify(wantRefused)}, got ${JSON.stringify(got)}`);
  }
  if (want.count !== undefined && v.refused.some((r) => r.count !== want.count)) {
    throw new Fail(`${label}: expected refusal count ${want.count}, got ${v.refused.map((r) => r.count).join(",")}`);
  }
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
let only: string[] | null = null; // control rounds run just the mutant's scenarios

async function scenario(name: string, id: string, body: () => Promise<string | void>): Promise<void> {
  if (only && !only.includes(id)) return;
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

// Journal-entry expectations for a 3-member report: released (one live entry
// each) or not released (none).
const three: JeCount[] = [
  { posted: 1, reversed: 0 },
  { posted: 1, reversed: 0 },
  { posted: 1, reversed: 0 },
];
const none3: JeCount[] = [
  { posted: 0, reversed: 0 },
  { posted: 0, reversed: 0 },
  { posted: 0, reversed: 0 },
];

async function forcedScenarios(mode: Mode): Promise<void> {
  const sc = (id: string, title: string, body: () => Promise<string | void>) =>
    scenario(`[${mode}] ${id} ${title}`, id, body);

  // --- A. release vs release --------------------------------------------------
  await sc("A1", "release vs release, first commits -> second WAITS, releases nothing, ids not_ready", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectRelease("M1 release", await release(a, f.visit, f.ids), { released: 3 });
    await begin(b, mode);
    const pb = release(b, f.visit, f.ids);
    await mustWait(b, "M2 queues behind M1's row locks");
    await a.c.query("commit");
    expectRelease("M2 release", await pb, { released: 0, refused: { not_ready: 3 } });
    await b.c.query("rollback");
    await expectState("after", f.ids, ["rel:M1", "rel:M1", "rel:M1"]);
    await expectJes("journal", f.ids, three);
  });

  // --- B. release vs undo on a PARTIAL report (the pre-0198 split) -----------
  await sc("B1", "partial report: release holds -> undo WAITS -> undo undoes all three, every entry reversed", async () => {
    const f = await mkFix({ states: ["released", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const adm = await actor("A", fx.admin1);
    await begin(m, mode);
    expectRelease("M1 release [b, c]", await release(m, f.visit, [f.ids[1], f.ids[2]]), { released: 2 });
    await begin(adm, mode);
    const pu = undo(adm, f.visit, [f.ids[0]]);
    await mustWait(adm, "the undo queues behind the release's row locks");
    await m.c.query("commit");
    const u = expectOk("A undo", await pu);
    if (u.undone.length !== 3) throw new Fail(`A undo: expected 3 undone, got ${u.undone.length}`);
    await adm.c.query("commit");
    await expectState("after", f.ids, ["rdy:-", "rdy:-", "rdy:-"]);
    await expectJes("journal", f.ids, [
      { posted: 0, reversed: 1 },
      { posted: 0, reversed: 1 },
      { posted: 0, reversed: 1 },
    ]);
  });

  await sc("B2", "partial report: undo holds -> release WAITS -> release releases all three, one entry each", async () => {
    const f = await mkFix({ states: ["released", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const adm = await actor("A", fx.admin1);
    await begin(adm, mode);
    const u = expectOk("A undo", await undo(adm, f.visit, [f.ids[0]]));
    if (u.undone.length !== 1) throw new Fail(`A undo: expected 1 undone (only a was released), got ${u.undone.length}`);
    await begin(m, mode);
    const pr = release(m, f.visit, [f.ids[1], f.ids[2]]);
    await mustWait(m, "the release queues behind the undo's row locks");
    await adm.c.query("commit");
    expectRelease("M1 release [b, c]", await pr, { released: 3 });
    await m.c.query("commit");
    await expectState("after", f.ids, ["rel:M1", "rel:M1", "rel:M1"]);
    await expectJes("journal", f.ids, [
      { posted: 1, reversed: 1 },
      { posted: 1, reversed: 0 },
      { posted: 1, reversed: 0 },
    ]);
  });

  // --- B3-B5. the 10-minute batch Undo (p_expected_released_at) ----------------
  const releasedMap = (v: ReleaseJson) => Object.fromEntries(v.released.map((r) => [r.id, r.released_at]));
  const expectAllSkipped = (label: string, o: Out<UndoJson>, ids: readonly string[]) => {
    const v = expectOk(label, o);
    if (v.undone.length !== 0) throw new Fail(`${label}: expected nothing undone, got ${v.undone.length}`);
    const got = v.skipped.map((x) => `${x.id}:${x.code}`).sort().join(",");
    const want = ids.map((id) => `${id}:changed_since`).sort().join(",");
    if (got !== want) throw new Fail(`${label}: expected skipped [${want}], got [${got}]`);
  };

  await sc("B3", "batch Undo waits behind a plain undo -> answers undone=[] , all three skipped changed_since", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const adm = await actor("A", fx.admin1);
    await begin(m, mode);
    const map = releasedMap(expectOk("M1 release", await release(m, f.visit, f.ids)));
    await m.c.query("commit");
    await begin(adm, mode);
    if (expectOk("A undo", await undo(adm, f.visit, [f.ids[0]])).undone.length !== 3) throw new Fail("A undo: expected 3 undone");
    await begin(m, mode);
    const pb = undo(m, f.visit, f.ids, map);
    await mustWait(m, "the batch undo queues behind the plain undo");
    await adm.c.query("commit");
    expectAllSkipped("M1 batch undo", await pb, f.ids);
    await m.c.query("commit");
    await expectState("after", f.ids, ["rdy:-", "rdy:-", "rdy:-"]);
    await expectUniform("uniform", f.ids);
  });

  await sc("B4", "batch Undo waits behind undo + re-release -> restores nothing, report stays wholly released", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const adm = await actor("A", fx.admin1);
    await begin(m, mode);
    const map = releasedMap(expectOk("M1 release", await release(m, f.visit, f.ids)));
    await m.c.query("commit");
    await begin(adm, mode);
    expectOk("A undo", await undo(adm, f.visit, [f.ids[0]]));
    await adm.c.query("commit");
    await begin(adm, mode);
    expectRelease("A re-release", await release(adm, f.visit, f.ids), { released: 3 });
    await begin(m, mode);
    const pb = undo(m, f.visit, f.ids, map);
    await mustWait(m, "the batch undo queues behind the re-release");
    await adm.c.query("commit");
    expectAllSkipped("M1 batch undo", await pb, f.ids);
    await m.c.query("commit");
    await expectState("after", f.ids, ["rel:A", "rel:A", "rel:A"]);
    await expectJes("journal", f.ids, [
      { posted: 1, reversed: 1 },
      { posted: 1, reversed: 1 },
      { posted: 1, reversed: 1 },
    ]);
  });

  // The report-level check is what keeps a partly-changed report whole: the
  // per-line released_at check alone would still undo the members that match.
  await sc("B4b", "batch Undo when ONE member no longer carries its release -> whole report skipped, none undone", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    await begin(m, mode);
    const map = releasedMap(expectOk("M1 release", await release(m, f.visit, f.ids)));
    await m.c.query("commit");
    await monitor.query("update public.test_requests set released_at = released_at + interval '1 second' where id = $1", [f.ids[2]]);
    await begin(m, mode);
    expectAllSkipped("M1 batch undo", await undo(m, f.visit, f.ids, map), f.ids);
    await m.c.query("commit");
    await expectState("after", f.ids, ["rel:M1", "rel:M1", "rel:M1"]);
    await expectJes("journal", f.ids, three);
  });

  await sc("B5", "batch Undo (exact map) holds -> release WAITS -> releases all three again, one entry each", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const m2 = await actor("M2", fx.med2);
    await begin(m, mode);
    const map = releasedMap(expectOk("M1 release", await release(m, f.visit, f.ids)));
    await m.c.query("commit");
    await begin(m, mode);
    const u = expectOk("M1 batch undo", await undo(m, f.visit, f.ids, map));
    if (u.undone.length !== 3 || u.skipped.length !== 0) throw new Fail(`batch undo: expected 3 undone / 0 skipped, got ${u.undone.length} / ${u.skipped.length}`);
    await begin(m2, mode);
    const pr = release(m2, f.visit, f.ids);
    await mustWait(m2, "the release queues behind the batch undo");
    await m.c.query("commit");
    expectRelease("M2 release", await pr, { released: 3 });
    await m2.c.query("commit");
    await expectState("after", f.ids, ["rel:M2", "rel:M2", "rel:M2"]);
    await expectJes("journal", f.ids, [
      { posted: 1, reversed: 1 },
      { posted: 1, reversed: 1 },
      { posted: 1, reversed: 1 },
    ]);
  });

  // --- C. release vs claim / unclaim -----------------------------------------
  await sc("C1", "member handed back in flight -> release WAITS, then report_not_finished (count 1), nothing released", async () => {
    const f = await mkFix({ states: ["ready", "ready", "in_progress"], holder: fx.med2 });
    const un = await actor("M2", fx.med2);
    const m = await actor("M1", fx.med1);
    await begin(un, mode);
    if (expectOk("M2 unclaim c", await unclaim(un, [f.ids[2]], [fx.med2])) !== 1) throw new Fail("M2 unclaim: expected 1 row");
    await begin(m, mode);
    const pr = release(m, f.visit, [f.ids[0], f.ids[1]]);
    await mustWait(m, "the release locks every member, including the one being handed back");
    await un.c.query("commit");
    expectRelease("M1 release [a, b]", await pr, { released: 0, refused: { report_not_finished: 2 }, count: 1 });
    await m.c.query("rollback");
    await expectState("after", f.ids, ["rdy:-", "rdy:-", "req:-"]);
    await expectJes("journal", f.ids, none3);
  });

  await sc("C2", "release holds first -> refused at once; the hand-back WAITS on the locked member, no deadlock", async () => {
    const f = await mkFix({ states: ["ready", "ready", "in_progress"], holder: fx.med2 });
    const m = await actor("M1", fx.med1);
    const un = await actor("M2", fx.med2);
    await begin(m, mode);
    expectRelease(
      "M1 release [a, b]",
      await mustNotWait(m, release(m, f.visit, [f.ids[0], f.ids[1]]), "nothing else holds a member"),
      { released: 0, refused: { report_not_finished: 2 }, count: 1 },
    );
    await begin(un, mode);
    const pu = unclaim(un, [f.ids[2]], [fx.med2]);
    await mustWait(un, "the release locked every member, so the hand-back queues behind it");
    await m.c.query("commit");
    if (expectOk("M2 unclaim c", await pu) !== 1) throw new Fail("M2 unclaim: expected 1 row");
    await un.c.query("commit");
    await expectState("after", f.ids, ["rdy:-", "rdy:-", "req:-"]);
    await expectJes("journal", f.ids, none3);
  });

  await sc("C3", "all-requested report: release holds -> claim WAITS -> release refused (3), claim wins whole", async () => {
    const f = await mkFix({ states: ["requested", "requested", "requested"] });
    const m = await actor("M1", fx.med1);
    const cl = await actor("M2", fx.med2);
    await begin(m, mode);
    expectRelease("M1 release", await release(m, f.visit, f.ids), {
      released: 0,
      refused: { report_not_finished: 3 },
      count: 3,
    });
    await begin(cl, mode);
    const pc = claim(cl, f.ids);
    await mustWait(cl, "the claim queues behind the release's row locks");
    await m.c.query("commit");
    if (expectOk("M2 claim", await pc) !== 3) throw new Fail("M2 claim: expected 3 rows");
    await cl.c.query("commit");
    await expectState("after", f.ids, ["ip:M2", "ip:M2", "ip:M2"]);
    await expectJes("journal", f.ids, none3);
  });

  await sc("C3b", "all-requested report: claim holds -> release WAITS -> release refused (3), claim stays whole", async () => {
    const f = await mkFix({ states: ["requested", "requested", "requested"] });
    const cl = await actor("M2", fx.med2);
    const m = await actor("M1", fx.med1);
    await begin(cl, mode);
    if (expectOk("M2 claim", await claim(cl, f.ids)) !== 3) throw new Fail("M2 claim: expected 3 rows");
    await begin(m, mode);
    const pr = release(m, f.visit, f.ids);
    await mustWait(m, "the release queues behind the claim's row locks");
    await cl.c.query("commit");
    expectRelease("M1 release", await pr, { released: 0, refused: { report_not_finished: 3 }, count: 3 });
    await m.c.query("rollback");
    await expectState("after", f.ids, ["ip:M2", "ip:M2", "ip:M2"]);
    await expectJes("journal", f.ids, none3);
  });

  // --- D. release vs payment void / edit --------------------------------------
  await sc("D1", "void holds -> release WAITS (visit lock) -> void commits -> release fails the payment gate (23514)", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const v = await actor("service_role", null);
    const m = await actor("M1", fx.med1);
    await begin(v, mode);
    if (expectOk("void", await voidPayment(v, f.payment as string)) !== 1) throw new Fail("void: expected 1 row");
    await begin(m, mode);
    const pr = release(m, f.visit, f.ids);
    await mustWait(m, "the release queues behind the void's lock on the visit");
    await v.c.query("commit");
    expectCode("M1 release", await pr, "23514");
    await m.c.query("rollback");
    await expectState("after", f.ids, ["rdy:-", "rdy:-", "rdy:-"]);
    await expectJes("journal", f.ids, none3);
    const money = await visitMoney(f.visit);
    if (money.status !== "unpaid") throw new Fail(`visit should be unpaid after the void, is ${money.status}`);
  });

  await sc("D2", "release holds -> void WAITS -> both commit: released, one entry each, one reversal, visit unpaid", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const v = await actor("service_role", null);
    await begin(m, mode);
    expectRelease("M1 release", await release(m, f.visit, f.ids), { released: 3 });
    await begin(v, mode);
    const pv = voidPayment(v, f.payment as string);
    await mustWait(v, "the void queues behind the release's lock on the visit");
    await m.c.query("commit");
    if (expectOk("void", await pv) !== 1) throw new Fail("void: expected 1 row");
    await v.c.query("commit");
    await expectState("after", f.ids, ["rel:M1", "rel:M1", "rel:M1"]);
    await expectJes("journal", f.ids, three);
    await expectPaymentReversed(f.payment as string);
    const money = await visitMoney(f.visit);
    if (money.status !== "unpaid" || money.paid !== 0) {
      throw new Fail(`visit should be unpaid / 0 paid, is ${money.status} / ${money.paid}`);
    }
  });

  await sc("D3", "Edit (lower amount) holds -> release WAITS -> edit commits -> release fails the payment gate (23514)", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const v = await actor("service_role", null);
    const m = await actor("M1", fx.med1);
    await begin(v, mode);
    expectOk("edit", await editPayment(v, f.payment as string, f.visit, 300, 100));
    await begin(m, mode);
    const pr = release(m, f.visit, f.ids);
    await mustWait(m, "the release queues behind the edit's lock on the visit");
    await v.c.query("commit");
    expectCode("M1 release", await pr, "23514");
    await m.c.query("rollback");
    await expectState("after", f.ids, ["rdy:-", "rdy:-", "rdy:-"]);
    await expectJes("journal", f.ids, none3);
    const money = await visitMoney(f.visit);
    if (money.status !== "partial" || money.paid !== 100) {
      throw new Fail(`visit should be partial / 100 paid after the edit, is ${money.status} / ${money.paid}`);
    }
  });

  await sc("D4", "release holds -> Edit (lower amount) WAITS -> both commit: released, one entry each, visit partial", async () => {
    const f = await mkFix({ states: ["ready", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const v = await actor("service_role", null);
    await begin(m, mode);
    expectRelease("M1 release", await release(m, f.visit, f.ids), { released: 3 });
    await begin(v, mode);
    const pe = editPayment(v, f.payment as string, f.visit, 300, 100);
    await mustWait(v, "the edit queues behind the release's lock on the visit");
    await m.c.query("commit");
    expectOk("edit", await pe);
    await v.c.query("commit");
    await expectState("after", f.ids, ["rel:M1", "rel:M1", "rel:M1"]);
    await expectJes("journal", f.ids, three);
    const money = await visitMoney(f.visit);
    if (money.status !== "partial" || money.paid !== 100) {
      throw new Fail(`visit should be partial / 100 paid after the edit, is ${money.status} / ${money.paid}`);
    }
  });

  // --- E. package siblings ----------------------------------------------------
  await sc("E1", "components X and Y released in parallel -> serialised on header H -> H released exactly once", async () => {
    const p = await mkPackage();
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectRelease("M1 release X", await release(a, p.visit, [p.x]), { released: 1 });
    await begin(b, mode);
    const pb = release(b, p.visit, [p.y]);
    await mustWait(b, "M2 queues behind M1's lock on the package header");
    await a.c.query("commit");
    expectRelease("M2 release Y", await pb, { released: 1 });
    await b.c.query("commit");
    const all = [p.header, p.x, p.y];
    await expectState("after", all, ["rel:M2", "rel:M1", "rel:M2"]);
    await expectJes("journal (header books the package, components are GL-silent)", all, [
      { posted: 1, reversed: 0 },
      { posted: 0, reversed: 0 },
      { posted: 0, reversed: 0 },
    ]);
  });
}

// The payment's original journal entry is reversed by exactly one mirror.
async function expectPaymentReversed(payment: string): Promise<void> {
  const { rows } = await monitor.query<{ status: string; n: number }>(
    `select o.status, (select count(*)::int from public.journal_entries r
                        where r.source_kind = 'reversal' and r.reverses = o.id) as n
       from public.journal_entries o where o.source_kind = 'payment' and o.source_id = $1`,
    [payment],
  );
  if (rows.length !== 1 || rows[0].status !== "reversed" || rows[0].n !== 1) {
    throw new Fail(
      `payment journal: expected one entry, reversed once; got ${rows.map((r) => `${r.status}x${r.n}`).join(",") || "none"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Free races: no forced ordering, both sides fired together, many rounds.
// Proves nothing about WHICH interleaving happened - only that none of them
// broke the invariants.
// ---------------------------------------------------------------------------

async function expectNoOpenTransactions(label: string): Promise<void> {
  const { rows } = await monitor.query<{ n: string }>(
    "select count(*) as n from pg_stat_activity where pid = any($1::int[]) and state like 'idle in transaction%'",
    [[...everPids]],
  );
  if (Number(rows[0].n) !== 0) throw new Fail(`${label}: ${rows[0].n} transaction(s) left open`);
}

async function freeRaces(mode: Mode, rounds: number): Promise<void> {
  const s = (n: string) => `[${mode}] ${n}`;
  const stagger = () => Math.floor(Math.random() * 21);

  await scenario(s(`F1 ${rounds}x release vs undo on a partial report -> never split, journal matches`), "F1", async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < rounds; i++) {
      const f = await mkFix({ states: ["released", "ready", "ready"] });
      const m = await actor("M1", fx.med1);
      const adm = await actor("A", fx.admin1);
      await begin(m, mode);
      await begin(adm, mode);
      const runRel = () => andEnd(m, release(m, f.visit, [f.ids[1], f.ids[2]]));
      const runUndo = () => andEnd(adm, undo(adm, f.visit, [f.ids[0]]));
      const d = stagger();
      const [ro, ru] = await Promise.all(
        i % 2 === 0
          ? [runRel(), sleep(d).then(runUndo)]
          : [sleep(d).then(runRel), runUndo()],
      );
      if (!ro.ok) throw new Fail(`round ${i}: release failed (${ro.code} ${ro.message})`);
      if (!ru.ok) throw new Fail(`round ${i}: undo failed (${ru.code} ${ru.message})`);
      await expectNoOpenTransactions(`round ${i}`);
      const end = await expectUniform(`round ${i}`, f.ids);
      // Live entries only: an undone release also leaves its reversed original.
      const live = (await jeCounts(f.ids)).map((j) => j.posted);
      const wantLive = end === "released" ? 1 : 0;
      if (live.some((n) => n !== wantLive)) {
        throw new Fail(`round ${i}: report is ${SHORT[end] ?? end} but posted release entries are [${live.join(",")}]`);
      }
      tally[end] = (tally[end] ?? 0) + 1;
      await closeActors();
    }
    return Object.entries(tally).map(([k, v]) => `${SHORT[k] ?? k}x${v}`).join(" ");
  });

  await scenario(s(`F2 ${rounds}x release vs release -> exactly one releases, one entry each`), "F2", async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < rounds; i++) {
      const f = await mkFix({ states: ["ready", "ready", "ready"] });
      const a = await actor("M1", fx.med1);
      const b = await actor("M2", fx.med2);
      await begin(a, mode);
      await begin(b, mode);
      const runA = () => andEnd(a, release(a, f.visit, f.ids));
      const runB = () => andEnd(b, release(b, f.visit, f.ids));
      const d = stagger();
      const [ra, rb] = await Promise.all(i % 2 === 0 ? [runA(), sleep(d).then(runB)] : [sleep(d).then(runA), runB()]);
      const outs = [ra, rb].map((o, k) => {
        if (!o.ok) throw new Fail(`round ${i}: M${k + 1} failed (${o.code} ${o.message})`);
        return o.v;
      });
      const won = outs.map((o) => o.released.length).sort();
      if (won.join(",") !== "0,3") throw new Fail(`round ${i}: released counts ${outs.map((o) => o.released.length).join(",")}`);
      const loser = outs.find((o) => o.released.length === 0) as ReleaseJson;
      if (loser.refused.length !== 3 || loser.refused.some((r) => r.code !== "not_ready")) {
        throw new Fail(`round ${i}: loser refusals ${JSON.stringify(loser.refused.map((r) => r.code))}`);
      }
      await expectNoOpenTransactions(`round ${i}`);
      await expectUniform(`round ${i}`, f.ids);
      await expectJes(`round ${i} journal`, f.ids, three);
      const who = (await stateOf(f.ids))[0];
      tally[who] = (tally[who] ?? 0) + 1;
      await closeActors();
    }
    return Object.entries(tally).map(([k, v]) => `${k}x${v}`).join(" ");
  });
}

// ---------------------------------------------------------------------------
// B-legacy (documentation only, not counted): the pre-0198 app statements,
// forced to overlap, split the report.
// ---------------------------------------------------------------------------

async function legacyDemo(): Promise<void> {
  console.log("\nB-legacy: the pre-0198 statements on report {a released, b ready, c ready}");
  try {
    const f = await mkFix({ states: ["released", "ready", "ready"] });
    const m = await actor("M1", fx.med1);
    const adm = await actor("A", fx.admin1);
    await begin(m, "seq");
    await begin(adm, "seq");
    const rel = expectOk("legacy release [b, c]", await legacyRelease(m, f.visit, [f.ids[1], f.ids[2]]));
    // The undo's WHERE status = 'released' matches only a in ITS snapshot
    // (b and c are still ready there), so it never contends for the rows the
    // release holds. It can still queue briefly on the journal-entry number
    // counter the release's bridge holds - but its statement snapshot is
    // already fixed, so it skips b and c after the wait as well.
    const pu = legacyUndo(adm, f.visit, f.ids);
    let waitedOn = "nothing (answered at once)";
    for (let i = 0; i < 10; i++) {
      const { rows } = await monitor.query<{ locktype: string; rel: string | null }>(
        "select locktype, relation::regclass::text as rel from pg_locks where pid = $1 and not granted",
        [adm.pid],
      );
      if (rows.length > 0) {
        waitedOn = `a lock (${rows.map((r) => `${r.locktype}${r.rel ? ` on ${r.rel}` : ""}`).join(", ")}) until the release committed`;
        break;
      }
      await sleep(100);
    }
    await m.c.query("commit");
    const und = expectOk("legacy undo [a, b, c]", await pu);
    await adm.c.query("commit");
    const states = await stateOf(f.ids);
    const split = new Set(states.map((x) => x.split(":")[0])).size > 1;
    console.log(`  release touched ${rel} row(s), undo touched ${und} row(s); the undo waited on ${waitedOn}`);
    console.log(`  final report [${states.join(",")}]`);
    console.log(`  legacy path splits: ${split ? "yes" : "NO"}`);
    if (!split) {
      console.log("  !!! LOUD: the legacy statements did NOT split the report - the bug analysis behind 0198 is wrong !!!");
    }
  } catch (e) {
    console.log(`  legacy demo could not run: ${e instanceof Error ? e.message : String(e)}`);
    console.log("  legacy path splits: unknown");
  } finally {
    await closeActors();
  }
}

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

// Remove every row of the runs whose tag starts with `like` ("rrc-" = every
// stale run, TAG = this run), including the journal entries the payment and
// release bridges posted for them. As one transaction under
// session_replication_role = replica (local only): the immutable-ledger guards,
// the lifecycle guard and the balance check must not veto a teardown.
async function sweepTagged(like: string): Promise<void> {
  if (!/^rrc-[0-9a-f]{0,6}$/.test(like)) throw new Error(`refusing to sweep pattern ${like}`);
  const up = like.toUpperCase();
  await monitor.query("begin");
  try {
    await monitor.query("set local session_replication_role = replica");
    const stmts = [
      `create temp table rrc_visits on commit drop as select id from public.visits where visit_number like 'V-${up}%'`,
      `create temp table rrc_staff on commit drop as select id from auth.users where email like '${like}%@example.test'`,
      `create temp table rrc_tr on commit drop as select id from public.test_requests where visit_id in (select id from rrc_visits)`,
      `create temp table rrc_pay on commit drop as select id from public.payments where visit_id in (select id from rrc_visits)`,
      `create temp table rrc_je on commit drop as
         select id from public.journal_entries
          where created_by in (select id from rrc_staff)
             or (source_kind = 'test_request' and source_id in (select id from rrc_tr))
             or (source_kind = 'payment' and source_id in (select id from rrc_pay))`,
      `insert into rrc_je
         select j.id from public.journal_entries j
          where (j.reverses in (select id from rrc_je)
                 or j.id in (select o.reversed_by from public.journal_entries o
                              where o.id in (select id from rrc_je) and o.reversed_by is not null))
            and j.id not in (select id from rrc_je)`,
      `delete from public.journal_lines where entry_id in (select id from rrc_je)`,
      `delete from public.journal_entries where id in (select id from rrc_je)`,
      `delete from public.audit_log
        where actor_id in (select id from rrc_staff)
           or resource_id in (select id from rrc_tr) or resource_id in (select id from rrc_pay)
           or resource_id in (select id from rrc_visits)`,
      `delete from public.result_test_requests where test_request_id in (select id from rrc_tr)`,
      `delete from public.results where uploaded_by in (select id from rrc_staff)`,
      `delete from public.payments where id in (select id from rrc_pay)`,
      `delete from public.test_requests where id in (select id from rrc_tr)`,
      `delete from public.visits where id in (select id from rrc_visits)`,
      `delete from public.patients where drm_id like 'DRM-${up}%'`,
      `delete from public.services where code like '${up}%'`,
      `delete from public.report_groups where code like '${up}%'`,
      `delete from public.staff_profiles where id in (select id from rrc_staff)`,
      `delete from auth.users where id in (select id from rrc_staff)`,
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
       values ($1, $2, $3, 100, 'lab_package', 'chemistry')`,
      [fx.pkgService, `${TAG_UP}-PK`, `${TAG} package`],
    );
    for (const [i, id] of fx.compServices.entries()) {
      await monitor.query(
        `insert into public.services (id, code, name, price_php, kind, section)
         values ($1, $2, $3, 0, 'lab_test', 'chemistry')`,
        [id, `${TAG_UP}-C${i}`, `${TAG} component ${i}`],
      );
    }
    await monitor.query(
      `insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
       values ($1, $2, 'Rrc', 'Fixture', '1990-01-01', 'female')`,
      [fx.patient, `DRM-${TAG_UP}`],
    );
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

// The lock statement inside release_report_locks, EXPLAINed in each mode.
// The lock order IS the sort order: the plan must be LockRows over an
// id-ordered input (a Sort on id, or - when the pkey index scan yields the
// order for free - an Index Scan using test_requests_pkey).
async function lockPlan(mode: Mode): Promise<string[]> {
  await monitor.query("begin");
  try {
    for (const g of MODE_GUCS[mode]) await monitor.query(g);
    const { rows } = await monitor.query(
      `explain (costs off) select 1 from public.test_requests tr
        where tr.id = any($1::uuid[]) and tr.visit_id = $2
        order by tr.id for no key update`,
      [[randomUUID(), randomUUID(), randomUUID()], randomUUID()],
    );
    return rows.map((r) => String(r["QUERY PLAN"]));
  } finally {
    await monitor.query("rollback");
  }
}

function lockPlanOk(lines: string[]): boolean {
  const body = lines.map((l) => l.trim());
  if (body[0] !== "LockRows") return false;
  const sorted = body.some((l) => l === "->  Sort") && body.some((l) => /^Sort Key: (tr\.)?id$/.test(l));
  const pkeyOrdered =
    !body.some((l) => l === "->  Sort") && body.some((l) => /^->\s+Index Scan using test_requests_pkey\b/.test(l));
  return sorted || pkeyOrdered;
}

async function printPlans(): Promise<void> {
  console.log("  prod plan (read-only EXPLAIN, 2026-09-30): LockRows -> Sort (Sort Key: id) -> Index Scan using idx_test_requests_visit_id");
  for (const mode of ["seq", "indexed"] as Mode[]) {
    const lines = await lockPlan(mode);
    const flat = lines
      .map((l) => l.trim())
      .filter((l) => !/^(Filter|Index Cond|Recheck)/.test(l.replace(/^->\s*/, "")))
      .join(" / ");
    const ok = lockPlanOk(lines);
    console.log(`  plan [${mode}] lock statement: ${flat}`);
    const name = `plan [${mode}] lock statement is LockRows over an id-ordered input`;
    results.push({ name, ok, detail: ok ? "" : lines.join(" / ") });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Control rounds (--control): prove the proof can fail
// ---------------------------------------------------------------------------
//
// Each mutant is a copy of the four live 0198 functions with one guard
// removed, created in a throwaway schema (never in public - the local stack is
// shared, so other sessions keep calling the real functions throughout). The
// named forced scenarios run against the copy, and the round PASSES only when
// every one of them fails in both plan modes.

type FnName = "release_actor" | "release_report_locks" | "release_visit_results" | "undo_visit_release";

interface Mutant {
  key: string;
  what: string;
  fn: FnName;
  from: string;
  to: string;
  mustFail: string[];
}

const MUTANTS: Mutant[] = [
  {
    key: "M1",
    what: "no row locks (release_report_locks drops FOR NO KEY UPDATE)",
    fn: "release_report_locks",
    from: "for no key update;",
    to: ";",
    mustFail: ["B1", "B2"],
  },
  {
    key: "M2",
    what: "no whole-report rule (release never refuses an unfinished report)",
    fn: "release_visit_results",
    from: "when r.n_unfinished > 0   then 'report_not_finished'",
    to: "when false then 'report_not_finished'",
    mustFail: ["C1"],
  },
  {
    key: "M3",
    what: "no visit lock (release_report_locks drops FOR SHARE)",
    fn: "release_report_locks",
    from: "for share;",
    to: ";",
    mustFail: ["D1"],
  },
  {
    key: "M4",
    what: "no header lock (release_report_locks drops the parent_id union)",
    fn: "release_report_locks",
    from: "and tr.parent_id is not null);",
    to: "and false);",
    mustFail: ["E1"],
  },
  {
    key: "M5",
    what: "batch Undo ignores released_at (report check drops the exact-release condition; the per-line check still guards a fully changed report, so B4b is the discriminator)",
    fn: "undo_visit_release",
    from: "and tr.released_at = (p_expected_released_at ->> m::text)::timestamptz)) then",
    to: "and true)) then",
    mustFail: ["B4b"],
  },
];

const FN_SIGS: Record<FnName, string> = {
  release_actor: "uuid",
  release_report_locks: "uuid, uuid[], text",
  release_visit_results: "uuid, uuid[], text, uuid",
  undo_visit_release: "uuid, uuid[], uuid, jsonb",
};

async function controlRounds(): Promise<void> {
  const schema = `rrc_ctl_${TAG.slice(4)}`;
  const names = Object.keys(FN_SIGS) as FnName[];
  const defs = {} as Record<FnName, string>;
  for (const fn of names) {
    const { rows } = await monitor.query<{ d: string }>(
      `select pg_get_functiondef('public.${fn}(${FN_SIGS[fn]})'::regprocedure) as d`,
    );
    let d = rows[0].d;
    // The function itself and every call between the four copies.
    for (const other of names) d = d.split(`public.${other}(`).join(`${schema}.${other}(`);
    defs[fn] = d;
  }

  for (const m of MUTANTS) {
    if (!defs[m.fn].includes(m.from)) throw new Error(`control ${m.key}: "${m.from}" not found in ${m.fn}`);
    await monitor.query(`drop schema if exists ${schema} cascade`);
    await monitor.query(`create schema ${schema}`);
    try {
      for (const fn of names) {
        await monitor.query(fn === m.fn ? defs[fn].replace(m.from, m.to) : defs[fn]);
      }
      await monitor.query(`grant usage on schema ${schema} to authenticated, service_role`);
      await monitor.query(`grant execute on all functions in schema ${schema} to authenticated, service_role`);

      console.log(`\ncontrol ${m.key}: ${m.what}`);
      const caught: Result[] = [];
      sink = caught;
      fnSchema = schema;
      only = m.mustFail;
      for (const mode of ["seq", "indexed"] as Mode[]) await forcedScenarios(mode);
      const failedIds = caught.filter((r) => !r.ok).map((r) => r.name);
      const missed = (["seq", "indexed"] as Mode[]).flatMap((mode) =>
        m.mustFail
          .filter((id) => !failedIds.some((n) => n.startsWith(`[${mode}] ${id} `)))
          .map((id) => `[${mode}] ${id}`),
      );
      const ok = missed.length === 0;
      const detail = ok ? `caught by ${failedIds.length} scenario(s)` : `NOT caught by ${missed.join(", ")}`;
      results.push({ name: `control ${m.key} (${m.what})`, ok, detail });
      console.log(`  ${ok ? "PASS" : "FAIL"}  control ${m.key} - ${detail}`);
    } finally {
      sink = results;
      only = null;
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
  await monitor.query(`drop schema if exists rrc_ctl_${TAG.slice(4)} cascade`);
  await sweepTagged(TAG);
  const left = await countTagged(TAG);
  if (left > 0) {
    results.push({ name: "teardown", ok: false, detail: `${left} fixture rows left behind` });
    console.log(`  FAIL  teardown - ${left} fixture rows left behind`);
  } else {
    console.log("  teardown: every fixture row removed");
  }
}

async function main(): Promise<void> {
  const rounds = Number(process.env.RRC_ROUNDS ?? 25);
  monitor = await connect();

  // One run at a time on the shared stack: the startup sweep below removes
  // EVERY rrc- fixture, which would pull a concurrent run's live rows out from
  // under it. Session-level, so it lasts until the monitor disconnects.
  const { rows: lock } = await monitor.query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtext('report-release:concurrency-proof')) as got",
  );
  if (!lock[0].got) {
    console.error("[report-release:concurrency-proof] another run is in progress on this stack - try again when it finishes.");
    await monitor.end();
    process.exit(3);
  }

  let seeded = false;
  // Ctrl-C: tear down before exiting, so committed fixtures never outlive the
  // run (open transactions roll back when their connections close).
  process.once("SIGINT", () => {
    console.log("\n  interrupted - tearing down");
    teardown()
      .catch((e) => console.error(e))
      .finally(() => process.exit(130));
  });
  try {
    const { rows: fn } = await monitor.query<{ n: string }>(
      "select count(*) as n from pg_proc where proname in ('release_visit_results', 'undo_visit_release', 'release_report_locks', 'release_actor')",
    );
    if (Number(fn[0].n) !== 4) throw new Error("0198 is not applied to the local stack");

    await sweepTagged("rrc-");
    // Control-round schemas a crashed run left behind (always rrc_ctl_<hex>).
    const { rows: stale } = await monitor.query<{ n: string }>(
      "select nspname as n from pg_namespace where nspname ~ '^rrc_ctl_[0-9a-f]{6}$'",
    );
    for (const { n } of stale) await monitor.query(`drop schema ${n} cascade`);
    console.log(`report-release concurrency proof - fixtures tagged ${TAG}`);
    await seed();
    seeded = true;
    await printPlans();

    for (const mode of ["seq", "indexed"] as Mode[]) {
      await forcedScenarios(mode);
      await freeRaces(mode, rounds);
    }
    await legacyDemo();
    if (process.argv.includes("--control")) await controlRounds();
  } finally {
    if (seeded || (await countTagged(TAG)) > 0) await teardown();
    else await closeActors();
    await monitor.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
