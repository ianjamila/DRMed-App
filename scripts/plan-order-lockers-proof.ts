// Hand-run local CONCURRENCY proof for the three `test_requests` writers that
// still lock rows in PLAN (heap) order, or reach for the visit row AFTER a line,
// while release / undo (0198) and claim / unclaim (0211) lock visit -> lines in
// id order. Design: docs/superpowers/specs/2026-10-01-plan-order-lockers-audit.md.
//
//   recompute_clinic_fee_for_unreleased()  (0184, body 0136)  scenarios R1-R5
//   fn_queue_delete_cascade()              (0125)             scenarios Q1-Q5
//   fn_release_headers_on_visit_paid()     (0138)             scenarios P1-P3
//
// The assertions describe the CORRECT behaviour (no 40P01, no fee change on a
// line that has a posted journal entry, both sides finish), so on a body that is
// still broken the real bugs show up as FAILED scenarios with a one-line reason.
//
// DETERMINISTIC, NOT LUCKY. Same method as report-release-concurrency-proof.ts:
// every forced scenario holds one side's locks in an open transaction, starts the
// other side, and does not move on until pg_locks shows that backend waiting on
// the exact row (by ctid, behind the holder's xid). If the intended interleaving
// is not reached the scenario FAILS - it never degrades into a sequential run.
// Scenarios that can end two ways (the writer locked in plan order vs id order)
// OBSERVE which row the writer already holds while queued and demand the matching
// outcome - the same shape as report-release's L2x.
//
// KNOWN (printed, never counted; fixed by PR 3b): Q1, Q2, Q3/Q3b (header delete vs release - the known
// accepted cycle) and Q5 (bulk plain-line delete vs claim - not fixed in this PR).
//
// THE APP STATEMENTS, mirrored:
//   recompute   service role   admin.rpc("recompute_clinic_fee_for_unreleased")
//   line delete service role   queue/bulk-delete-core.ts deleteTestRequestsForVisit:
//                              UPDATE test_requests SET deleted_at, deleted_by,
//                              delete_reason WHERE id IN (..) AND visit_id AND
//                              deleted_at IS NULL (the admin client, NOT an
//                              authenticated session - the spec said authenticated)
//   line restore service role  visits/queue-restore-core.ts
//   payment     authenticated  payments/new/actions.ts (the staff session client)
//   release/undo/claim/unclaim authenticated, one JWT `sub` per connection
//
// recompute scans EVERY eligible line of the stack. The proof keeps its fixtures
// the only eligible lines (it asserts that before the one scenario that COMMITS a
// recompute, R2b) and ROLLS BACK every other recompute, reading what it did from
// inside its own transaction.
//
// FIXTURES. Committed, tagged `plo-<hex>` / `PLO-<HEX>`; stale rows from a crashed
// run are swept first, the `finally` (and SIGINT / SIGTERM) deletes everything and
// proves nothing tagged is left. Never touches a row it did not mint (Bsqfixture
// rows are never read or written). No setting is flipped (the release-notice flag
// is left alone; any notice a release enqueues for a fixture visit is swept).
//
// Run (local stack):
//   npm run plan-order-lockers:proof
//   npm run plan-order-lockers:proof -- --control   # mutant bodies arrive with the fixes
//   PLO_ONLY=R1,Q1 npm run plan-order-lockers:proof # just those scenarios
//
// The function under test is resolved through `fn.*` so a later control round can
// point a scenario at a mutant copy (recompute) or swap a trigger function in a
// scenario's own setup (cascade, header release) without touching the scenarios.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";

requireLocalOrExplicitProd("plan-order-lockers:proof", {
  writes:
    "throwaway fixtures tagged plo-<hex> (staff, services, a physician, an HMO provider, a patient, visits, lines, payments and the journal entries their bridges post), committed so connections can race on them, then deleted",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// This script COMMITS rows: it only ever runs against the local stack.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(
    `[plan-order-lockers:proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script commits fixtures and only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Where the functions under test live (hooks for --control mutants)
// ---------------------------------------------------------------------------

const fn = {
  recomputeSchema: process.env.PLO_RECOMPUTE_SCHEMA ?? "public",
  releaseSchema: "public",
  claimSchema: "public",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `plo-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();
let aborting = false; // set by SIGINT / SIGTERM: the handler owns cleanup and the exit
const APP_NAME = `plan-order-lockers:${TAG}`; // every connection of this run carries it (abort cleanup finds them by it)

const fx = {
  med1: randomUUID(),
  med2: randomUUID(),
  admin1: randomUUID(),
  group: randomUUID(),
  services: [randomUUID(), randomUUID(), randomUUID()],
  pkgService: randomUUID(),
  compServices: [randomUUID(), randomUUID()],
  patient: randomUUID(),
  physician: randomUUID(),
  hmo: randomUUID(),
};

const FEE = { clinic: 40, pf: 60 }; // a fixture line: price 100 = clinic 40 + doctor PF 60

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface Actor {
  name: string;
  uid: string | null; // null = service_role
  c: Client;
  pid: number;
}

let monitor: Client; // postgres; seeds, reads committed state, watches waits
let probe: Client; // never inside a long transaction
const open: Actor[] = [];

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL, application_name: APP_NAME });
  c.on("error", () => undefined); // a terminated backend (abort cleanup) must not crash the process mid-cleanup
  await c.connect();
  await c.query("set statement_timeout = '25s'"); // a stuck wait fails the run, never hangs it
  return c;
}

async function actor(name: string, uid: string | null): Promise<Actor> {
  const c = await connect();
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
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

// A plan that walks test_requests in PHYSICAL (heap) order: seq scan on, every
// index path off. What any seq scan / status-index scan gives anywhere.
const PHYSICAL_PLAN = [
  "set local enable_seqscan = on",
  "set local enable_indexscan = off",
  "set local enable_indexonlyscan = off",
  "set local enable_bitmapscan = off",
];

// BEGIN as a staff member (JWT sub, role authenticated), or as service_role.
async function begin(a: Actor, extra: readonly string[] = []): Promise<void> {
  await a.c.query("begin");
  if (a.uid) {
    await a.c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: a.uid, role: "authenticated" }),
    ]);
    await a.c.query("set local role authenticated");
  } else {
    await a.c.query("set local role service_role");
  }
  for (const g of extra) await a.c.query(g);
}

// BEGIN as the table owner: "some other writer holds a row" (a result upload, a note edit).
async function beginRaw(a: Actor): Promise<void> {
  await a.c.query("begin");
}

// ---------------------------------------------------------------------------
// The calls, exactly as the app issues them
// ---------------------------------------------------------------------------

type Out<T> = { ok: true; v: T } | { ok: false; code: string; message: string };

interface ReleaseJson {
  released: Array<{ id: string }>;
  refused: Array<{ id: string; code: string }>;
}
interface UndoJson {
  undone: Array<{ id: string }>;
  skipped: Array<{ id: string; code: string }>;
}

async function settle<T>(p: Promise<QueryResult>, pick: (r: QueryResult) => T): Promise<Out<T>> {
  try {
    return { ok: true, v: pick(await p) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "?", message: err.message ?? String(e) };
  }
}

// concurrency-proof: recompute_clinic_fee_for_unreleased
// physicians-compensation.ts: admin.rpc("recompute_clinic_fee_for_unreleased") - service role.
function recompute(a: Actor): Promise<Out<{ rows_affected: number }>> {
  return settle(
    a.c.query(`select ${fn.recomputeSchema}.recompute_clinic_fee_for_unreleased() as r`),
    (r) => r.rows[0].r as { rows_affected: number },
  );
}

// releaseVisitSelection -> rpc("release_visit_results")
function release(a: Actor, visit: string, ids: readonly string[]): Promise<Out<ReleaseJson>> {
  return settle(
    a.c.query(`select ${fn.releaseSchema}.release_visit_results($1::uuid, $2::uuid[], 'email') as r`, [visit, ids]),
    (r) => r.rows[0].r as ReleaseJson,
  );
}

// undo release -> rpc("undo_visit_release"); 0205 requires the reason (5th arg).
function undo(a: Actor, visit: string, ids: readonly string[]): Promise<Out<UndoJson>> {
  return settle(
    a.c.query(`select ${fn.releaseSchema}.undo_visit_release($1::uuid, $2::uuid[], null, null, 'plo proof') as r`, [
      visit,
      ids,
    ]),
    (r) => r.rows[0].r as UndoJson,
  );
}

// claimPanelMembers -> rpc("claim_panel_members"); unclaimPanelMembers -> rpc("unclaim_panel_members")
function claim(a: Actor, ids: readonly string[]): Promise<Out<number>> {
  return settle(a.c.query(`select ${fn.claimSchema}.claim_panel_members($1::uuid[]) as n`, [ids]), (r) =>
    Number(r.rows[0].n),
  );
}
function unclaim(a: Actor, ids: readonly string[], holders: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query(`select ${fn.claimSchema}.unclaim_panel_members($1::uuid[], $2::uuid[]) as n`, [ids, holders]),
    (r) => Number(r.rows[0].n),
  );
}

// bulk-delete-core.ts deleteTestRequestsForVisit (admin client): the soft delete of the given lines.
// A package header's components follow through fn_queue_delete_cascade.
// concurrency-proof: fn_queue_delete_cascade
function deleteLines(a: Actor, visit: string, ids: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.test_requests
          set deleted_at = $1, deleted_by = $2, delete_reason = $3
        where id = any($4::uuid[]) and visit_id = $5 and deleted_at is null
        returning id`,
      [new Date().toISOString(), fx.admin1, `${TAG} concurrency proof`, ids, visit],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// queue-restore-core.ts (admin client, the non-expected-timestamp branch).
function restoreLines(a: Actor, visit: string, ids: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.test_requests
          set deleted_at = null, deleted_by = null, delete_reason = null
        where id = any($1::uuid[]) and visit_id = $2 and deleted_at is not null
        returning id`,
      [ids, visit],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// payments/new/actions.ts: the staff session client inserts the payment; the
// recalc trigger flips the visit and fn_release_headers_on_visit_paid runs.
// concurrency-proof: fn_release_headers_on_visit_paid
function insertPayment(a: Actor, visit: string, amount: number): Promise<Out<string>> {
  return settle(
    a.c.query(
      `insert into public.payments (visit_id, amount_php, method, reference_number, notes, received_by)
       values ($1, $2, 'cash', null, null, $3) returning id`,
      [visit, amount, fx.admin1],
    ),
    (r) => String(r.rows[0].id),
  );
}

// Commit on success, roll back on refusal, the moment the call answers - the way
// PostgREST ends each RPC. Racers never wait for each other's answers first.
function andEnd<T>(a: Actor, p: Promise<Out<T>>): Promise<Out<T>> {
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

// Same, but ALWAYS roll back (a recompute that must not change the shared stack).
// `inspect` reads what the call did from inside its own transaction first.
function andRollback<T, I = null>(
  a: Actor,
  p: Promise<Out<T>>,
  inspect?: () => Promise<I>,
): Promise<{ out: Out<T>; seen: I | null }> {
  return p.then(async (out) => {
    let seen: I | null = null;
    try {
      if (inspect && out.ok) seen = await inspect();
    } catch {
      /* the inspection must not hide the outcome */
    }
    await a.c.query("rollback").catch(() => undefined);
    return { out, seen };
  });
}

// ---------------------------------------------------------------------------
// Interleaving control (pg_locks)
// ---------------------------------------------------------------------------

class Fail extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tbl = "test_requests" | "visits";

async function waitingOnLock(pid: number): Promise<boolean> {
  const { rows } = await monitor.query(
    "select 1 from pg_locks where pid = $1 and not granted and locktype in ('transactionid', 'tuple')",
    [pid],
  );
  return rows.length > 0;
}

async function mustNotWait<T>(a: Actor, p: Promise<Out<T>>, why: string): Promise<Out<T>> {
  let done = false;
  const tracked = p.then((o) => {
    done = true;
    return o;
  });
  for (let i = 0; i < 50 && !done; i++) {
    if (await waitingOnLock(a.pid)) throw new Fail(`${a.name} blocked on a lock but should have answered at once (${why})`);
    await sleep(100);
  }
  if (!done) throw new Fail(`${a.name} did not answer within 5s (${why})`);
  return tracked;
}

async function ctidIn(table: Tbl, id: string): Promise<string> {
  const { rows } = await monitor.query<{ c: string }>(`select ctid::text as c from public.${table} where id = $1`, [id]);
  if (rows.length !== 1) throw new Fail(`ctidIn: ${table} ${id} not found`);
  return rows[0].c;
}

function ctidParts(c: string): [number, number] {
  const m = /^\((\d+),(\d+)\)$/.exec(c);
  if (!m) throw new Fail(`bad ctid ${c}`);
  return [Number(m[1]), Number(m[2])];
}

async function storedBefore(first: string, second: string): Promise<boolean> {
  const [a, b] = [ctidParts(await ctidIn("test_requests", first)), ctidParts(await ctidIn("test_requests", second))];
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

async function xidOf(a: Actor): Promise<string> {
  const { rows } = await monitor.query<{ x: string | null }>(
    "select backend_xid::text as x from pg_stat_activity where pid = $1",
    [a.pid],
  );
  if (!rows[0]?.x) throw new Fail(`${a.name} has no transaction id (it has locked nothing)`);
  return rows[0].x;
}

// Is this row locked by anyone? (a non-blocking conflicting probe from a separate connection)
async function rowLocked(table: Tbl, id: string): Promise<boolean> {
  await probe.query("begin");
  try {
    const mode = table === "visits" ? "for update" : "for no key update";
    const { rowCount } = await probe.query(`select 1 from public.${table} where id = $1 ${mode} skip locked`, [id]);
    return rowCount === 0;
  } finally {
    await probe.query("rollback");
  }
}

interface BlockInfo {
  tuple: string | null;
  tupleGranted: boolean;
  waitXid: string | null;
}
async function blockInfo(pid: number): Promise<BlockInfo> {
  const { rows } = await monitor.query<{ locktype: string; granted: boolean; page: number | null; tuple: number | null; xid: string | null }>(
    `select locktype, granted, page, tuple, transactionid::text as xid from pg_locks
      where pid = $1 and (locktype = 'tuple' or (locktype = 'transactionid' and not granted))`,
    [pid],
  );
  const t = rows.find((r) => r.locktype === "tuple");
  const x = rows.find((r) => r.locktype === "transactionid");
  return { tuple: t ? `(${t.page},${t.tuple})` : null, tupleGranted: t?.granted ?? false, waitXid: x?.xid ?? null };
}
const fmtBlock = (b: BlockInfo) =>
  `tuple ${b.tuple ?? "none"}${b.tuple ? (b.tupleGranted ? " granted" : " queued") : ""}, waits behind xid ${b.waitXid ?? "none"}`;

interface Row {
  table: Tbl;
  id: string;
  label: string;
}

// The backend must be seen waiting on EXACTLY one of these rows (by ctid) - behind
// `behind`'s transaction when given - within ~5s. Returns the label it waits on.
async function mustBlockOn(
  a: Actor,
  rows: Row | Row[],
  behind: Actor | null,
  why: string,
): Promise<{ on: string; text: string }> {
  const want = Array.isArray(rows) ? rows : [rows];
  const ctids = await Promise.all(want.map((r) => ctidIn(r.table, r.id)));
  const wantXid = behind ? await xidOf(behind) : null;
  let last: BlockInfo = { tuple: null, tupleGranted: false, waitXid: null };
  for (let i = 0; i < 50; i++) {
    last = await blockInfo(a.pid);
    const hit = ctids.findIndex((c) => c === last.tuple);
    if (hit >= 0 && (!wantXid || last.waitXid === wantXid)) {
      const label = want[hit].label;
      return {
        on: label,
        text: `${a.name} waits on ${label} ${ctids[hit]}${wantXid ? ` behind ${behind?.name} (xid ${wantXid})` : " (queued)"}`,
      };
    }
    await sleep(100);
  }
  throw new Fail(
    `interleaving not reached: ${a.name} never waited on ${want.map((r, i) => `${r.label} ${ctids[i]}`).join(" or ")}` +
      `${wantXid ? ` behind ${behind?.name} (xid ${wantXid})` : ""} (${why}); last seen: ${fmtBlock(last)}`,
  );
}

// Right after the holder lets go, read who waits on what (the cycle forms in
// milliseconds; the deadlock detector resolves it after deadlock_timeout = 1s).
async function describeWaits(actors: Actor[], rows: Row[]): Promise<string> {
  const xids = new Map<string, string>();
  for (const a of actors) {
    const { rows: r } = await monitor.query<{ x: string | null }>(
      "select backend_xid::text as x from pg_stat_activity where pid = $1",
      [a.pid],
    );
    if (r[0]?.x) xids.set(r[0].x, a.name);
  }
  const ctids = new Map<string, string>();
  for (const r of rows) ctids.set(await ctidIn(r.table, r.id).catch(() => "?"), r.label);
  const parts: string[] = [];
  for (const a of actors) {
    const b = await blockInfo(a.pid);
    if (!b.tuple && !b.waitXid) continue;
    const on = b.tuple ? (ctids.get(b.tuple) ?? `tuple ${b.tuple}`) : "?";
    const behind = b.waitXid ? ` behind ${xids.get(b.waitXid) ?? `xid ${b.waitXid}`}` : " (queued)";
    parts.push(`${a.name} waits on ${on}${behind}`);
  }
  return parts.length ? parts.join("; ") : "no waiters seen";
}

// ---------------------------------------------------------------------------
// Fixture builders (committed, as postgres)
// ---------------------------------------------------------------------------

type St = "ready" | "released" | "in_progress" | "requested";

interface Fix {
  visit: string;
  ids: string[]; // ascending uuid order
  payment: string | null;
}

let visitSeq = 0;
const made = { tests: [] as string[], payments: [] as string[], visits: [] as string[] };

// A visit of `states.length` plain lab lines (100 each; with `fee`: clinic 40 +
// doctor PF 60 and the zero-clinic-cut physician attending, i.e. ELIGIBLE for
// recompute), paid by one payment unless paid=false. `physical: "desc"` stores the
// lines in DESCENDING id order, so heap order is the reverse of lock-by-id order.
async function mkVisit(spec: {
  states: St[];
  paid?: boolean;
  hmo?: boolean;
  physical?: "desc";
  fee?: boolean;
  holder?: string;
}): Promise<Fix> {
  const n = spec.states.length;
  const ids = Array.from({ length: n }, () => randomUUID()).sort();
  const visit = randomUUID();
  const order = ids.map((_, i) => i);
  if (spec.physical === "desc") order.reverse();
  const payment = spec.paid === false ? null : randomUUID();
  const seq = ++visitSeq;
  made.tests.push(...ids);
  made.visits.push(visit);
  if (payment) made.payments.push(payment);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, attending_physician_id, hmo_provider_id)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', $4, 0, $5, $6)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient, 100 * n, spec.fee ? fx.physician : null, spec.hmo ? fx.hmo : null],
    );
    for (const i of order) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php, clinic_fee_php, doctor_pf_php, attending_physician_id)
         values ($1, $2, $3, $4, 'requested', 100, 100, $5, $6, $7)`,
        [
          ids[i],
          visit,
          fx.services[i % 3],
          fx.med1,
          spec.fee ? FEE.clinic : null,
          spec.fee ? FEE.pf : null,
          spec.fee ? fx.physician : null,
        ],
      );
    }
    if (payment) {
      await monitor.query(
        "insert into public.payments (id, visit_id, amount_php, method, received_by) values ($1, $2, $3, 'cash', $4)",
        [payment, visit, 100 * n, fx.admin1],
      );
    }
    for (const i of order) {
      const st = spec.states[i];
      if (st === "ready" || st === "released") {
        await monitor.query("update public.test_requests set status = 'ready_for_release' where id = $1", [ids[i]]);
      }
      if (st === "released") {
        await monitor.query(
          `update public.test_requests set status = 'released', released_at = now(), released_by = $2, release_medium = 'other' where id = $1`,
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
  return { visit, ids, payment };
}

interface PkgFix {
  visit: string;
  header: string;
  x1: string; // lower id
  x2: string; // higher id, STORED BEFORE x1
}

// An UNPAID package visit: header H (100) with components x1 < x2 (0 each). x1 < H
// < x2 by id; the rows are inserted H, x2, x1 so the components sit in the
// reverse of id order on the heap. comps = each component's state. `deleted`
// soft-deletes the header (and so its components) as postgres.
async function mkPkg(spec: { comps: [St, St]; hmo?: boolean; deleted?: boolean; holder?: string }): Promise<PkgFix> {
  const [x1, header, x2] = [randomUUID(), randomUUID(), randomUUID()].sort();
  const visit = randomUUID();
  const seq = ++visitSeq;
  made.tests.push(header, x1, x2);
  made.visits.push(visit);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, hmo_provider_id)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 100, 0, $4)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient, spec.hmo ? fx.hmo : null],
    );
    await monitor.query(
      `insert into public.test_requests (id, visit_id, service_id, requested_by, status, is_package_header, base_price_php, final_price_php)
       values ($1, $2, $3, $4, 'requested', true, 100, 100)`,
      [header, visit, fx.pkgService, fx.med1],
    );
    for (const [id, idx] of [[x2, 1], [x1, 0]] as const) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, parent_id, base_price_php, final_price_php)
         values ($1, $2, $3, $4, 'requested', $5, 0, 0)`,
        [id, visit, fx.compServices[idx], fx.med1, header],
      );
    }
    for (const [id, st] of [[x2, spec.comps[1]], [x1, spec.comps[0]]] as const) {
      if (st === "ready") {
        await monitor.query("update public.test_requests set status = 'ready_for_release' where id = $1", [id]);
      }
      if (st === "in_progress") {
        await monitor.query(
          "update public.test_requests set status = 'in_progress', assigned_to = $2, started_at = now() where id = $1",
          [id, spec.holder ?? fx.med2],
        );
      }
    }
    if (spec.deleted) {
      await monitor.query(
        "update public.test_requests set deleted_at = now(), deleted_by = $2, delete_reason = 'plo fixture' where id = $1",
        [header, fx.admin1],
      );
    }
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, header, x1, x2 };
}

interface TwoHdr {
  visit: string;
  h1: string; // lower id
  h2: string; // STORED BEFORE h1
  c1: string; // component of h1
  c2: string; // component of h2
  req: string; // plain line, requested
  ip: string; // plain line, in_progress (M2)
  total: number;
}

// A visit with two package headers whose components are all RELEASED, the headers
// back at ready_for_release (the state fn_release_headers_on_visit_paid exists
// for) and the visit UNPAID again (the payment voided). Built the way production
// reaches it, as postgres, through the real triggers: pay, release the
// components (the headers follow), undo the headers (their entries reverse), void
// the payment. Both headers carry a clinic fee and the zero-cut physician so
// recompute sees them as eligible (their release entry is reversed, not posted).
async function mkTwoHeaders(): Promise<TwoHdr> {
  const [h1, h2] = [randomUUID(), randomUUID()].sort();
  const [c1, c2, req, ip] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const visit = randomUUID();
  const payment = randomUUID();
  const seq = ++visitSeq;
  const total = 400;
  made.tests.push(h1, h2, c1, c2, req, ip);
  made.visits.push(visit);
  made.payments.push(payment);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, attending_physician_id)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', $4, 0, $5)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient, total, fx.physician],
    );
    // heap order: h2, c2, h1, c1, req, ip
    for (const h of [h2, h1]) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, is_package_header, base_price_php, final_price_php, clinic_fee_php, doctor_pf_php, attending_physician_id)
         values ($1, $2, $3, $4, 'requested', true, 100, 100, $5, $6, $7)`,
        [h, visit, fx.pkgService, fx.med1, FEE.clinic, FEE.pf, fx.physician],
      );
      const [c, idx] = h === h2 ? [c2, 1] : [c1, 0];
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, parent_id, base_price_php, final_price_php)
         values ($1, $2, $3, $4, 'requested', $5, 0, 0)`,
        [c, visit, fx.compServices[idx], fx.med1, h],
      );
    }
    for (const id of [req, ip]) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
         values ($1, $2, $3, $4, 'requested', 100, 100)`,
        [id, visit, fx.services[0], fx.med1],
      );
    }
    await monitor.query(
      "insert into public.payments (id, visit_id, amount_php, method, received_by) values ($1, $2, $3, 'cash', $4)",
      [payment, visit, total, fx.admin1],
    );
    await monitor.query("update public.test_requests set status = 'ready_for_release' where id = any($1::uuid[])", [[h1, h2, c1, c2]]);
    await monitor.query(
      "update public.test_requests set status = 'in_progress', assigned_to = $2, started_at = now() where id = $1",
      [ip, fx.med2],
    );
    await monitor.query(
      "update public.test_requests set status = 'released', released_at = now(), released_by = $2, release_medium = 'other' where id = any($1::uuid[])",
      [[c1, c2], fx.med2],
    );
    await monitor.query(
      "update public.test_requests set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null where id = any($1::uuid[])",
      [[h1, h2]],
    );
    await monitor.query(
      "update public.payments set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1",
      [payment, fx.admin1, `Recorded twice: ${TAG} fixture`],
    );
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, h1, h2, c1, c2, req, ip, total };
}

// ---------------------------------------------------------------------------
// Committed-state readers and assertions (monitor connection)
// ---------------------------------------------------------------------------

interface LineRow {
  status: string;
  assigned_to: string | null;
  deleted_at: string | null;
  clinic_fee_php: string | null;
  doctor_pf_php: string | null;
}
async function lineOf(id: string): Promise<LineRow> {
  const { rows } = await monitor.query<LineRow>(
    "select status, assigned_to, deleted_at, clinic_fee_php, doctor_pf_php from public.test_requests where id = $1",
    [id],
  );
  if (rows.length !== 1) throw new Fail(`line ${id} not found`);
  return rows[0];
}

async function postedJes(id: string): Promise<number> {
  const { rows } = await monitor.query<{ n: number }>(
    "select count(*)::int as n from public.journal_entries where source_kind = 'test_request' and source_id = $1 and status = 'posted'",
    [id],
  );
  return rows[0].n;
}

// Eligible recompute lines that are NOT this run's: a COMMITTED recompute would
// rewrite someone else's rows.
async function foreignEligible(): Promise<number> {
  const { rows } = await monitor.query<{ n: number }>(
    `select count(*)::int as n
       from public.test_requests tr
       join public.visits v on v.id = tr.visit_id
       join public.patients pt on pt.id = v.patient_id
       left join public.physicians p on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
       left join public.physician_compensation pc on pc.physician_id = p.id
      where coalesce(pc.clinic_cut_php, case when pc.compensation_arrangement in ('rent_paying','shareholder') then 0 else 100 end) = 0
        and tr.clinic_fee_php > 0
        and pt.deleted_at is null and pt.merged_into_id is null
        and not (tr.id = any($1::uuid[]))
        and not exists (select 1 from public.journal_entries je
                         where je.source_kind = 'test_request' and je.source_id = tr.id and je.status = 'posted')`,
    [made.tests],
  );
  return rows[0].n;
}

const fmtOut = (o: Out<unknown>) => (o.ok ? "ok" : `${o.code} ${o.message.split("\n")[0]}`);

function expectOk<T>(label: string, o: Out<T>): T {
  if (!o.ok) throw new Fail(`${label}: expected success, got ${o.code} ${o.message}`);
  return o.v;
}

// The question every race asks: after the holder lets go, did the two finish?
// 40P01 on either side is the finding; the victim is named.
async function raceResult<A, B>(
  names: [string, string],
  pa: Promise<Out<A>>,
  pb: Promise<Out<B>>,
): Promise<[Out<A>, Out<B>]> {
  const timeout = sleep(18000).then(() => "timeout" as const);
  const both = await Promise.race([Promise.all([pa, pb]), timeout]);
  if (both === "timeout") throw new Fail(`neither ${names[0]} nor ${names[1]} finished within 18s of the holder letting go`);
  return both as [Out<A>, Out<B>];
}

function deadlockVictim(names: [string, string], ra: Out<unknown>, rb: Out<unknown>): string | null {
  const dl = [ra, rb].map((x) => !x.ok && x.code === "40P01");
  if (!dl[0] && !dl[1]) return null;
  return dl[0] && dl[1] ? `${names[0]} and ${names[1]}` : dl[0] ? names[0] : names[1];
}

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

interface Result {
  id: string;
  name: string;
  ok: boolean;
  observed: boolean;
  detail: string;
}
const results: Result[] = [];
let only: string[] | null = process.env.PLO_ONLY ? process.env.PLO_ONLY.split(",") : null;
let sink: Result[] = results; // control rounds collect into their own list
let quiet = false; // control rounds print one line per mutant, not per scenario

async function scenario(
  id: string,
  title: string,
  body: () => Promise<string | void>,
  opts: { observe?: boolean; known?: string } = {},
): Promise<void> {
  if (aborting || (only && !only.includes(id))) return;
  const observed = opts.observe === true || opts.known !== undefined;
  // KNOWN = a proven race that a later PR fixes: printed, never counted.
  const tag = opts.known !== undefined ? `KNOWN - fixed by ${opts.known}` : "OBSERVED";
  try {
    const note = (await body()) ?? "";
    sink.push({ id, name: title, ok: true, observed, detail: note });
    if (!quiet) console.log(`  ${observed ? tag : "PASS    "} ${id} ${title}${note ? ` - ${note}` : ""}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    sink.push({ id, name: title, ok: false, observed, detail });
    if (!quiet) console.log(`  ${observed ? `${tag} (still reproduces)` : "FAIL    "} ${id} ${title} - ${detail}`);
  } finally {
    await closeActors();
  }
}

// ---------------------------------------------------------------------------
// R - recompute_clinic_fee_for_unreleased
// ---------------------------------------------------------------------------

async function recomputeScenarios(): Promise<void> {
  // R1: recompute vs release on ONE line. A third writer W holds the visit row
  // FOR SHARE. recompute locks A (its UPDATE) and then the 0183 guard wants the
  // visit FOR UPDATE: it queues on W. Release(A) takes the visit FOR SHARE (shared
  // with W) and wants A. When W lets go: recompute holds A and wants V FOR UPDATE
  // (release holds V FOR SHARE), release holds V and wants A -> a cycle.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R1", "recompute vs release on one line (visit held FOR SHARE by a third writer): must not deadlock", async () => {
    const f = await mkVisit({ states: ["ready"], paid: true, fee: true });
    const A: Row = { table: "test_requests", id: f.ids[0], label: "A" };
    const V: Row = { table: "visits", id: f.visit, label: "V" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.visits where id = $1 for share", [f.visit]);
    const rec = await actor("recompute", null);
    await begin(rec, PHYSICAL_PLAN);
    const prec = andRollback(rec, recompute(rec));
    const w1 = await mustBlockOn(rec, V, g, "recompute's fee guard (0183) wants the visit FOR UPDATE while W holds it FOR SHARE");
    const heldA = await rowLocked("test_requests", f.ids[0]);
    const m = await actor("release", fx.med1);
    await begin(m);
    const pm = andEnd(m, release(m, f.visit, [f.ids[0]]));
    let w2 = "release answered at once (recompute holds no line while queued on V)";
    if (heldA) {
      w2 = (await mustBlockOn(m, A, rec, "release gets V FOR SHARE (compatible with W) and then needs A, held by recompute")).text;
    } else {
      const early = await mustNotWait(m, pm, "recompute holds no line while queued on the visit");
      if (!early.ok) throw new Fail(`release failed: ${fmtOut(early)}`);
    }
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([rec, m], [A, V]);
    })();
    const [rr, rm] = await raceResult(["recompute", "release"], prec.then((x) => x.out), pm);
    const victim = deadlockVictim(["recompute", "release"], rr, rm);
    if (victim) {
      throw new Fail(
        `40P01 deadlock (victim: ${victim}): recompute held A (line lock) and queued on V FOR UPDATE, release held V FOR SHARE and wanted A. ` +
          `${w1.text}; ${w2}; after W commits: ${cycle}`,
      );
    }
    if (!rr.ok) throw new Fail(`recompute failed: ${fmtOut(rr)}`);
    if (!rm.ok) throw new Fail(`release failed: ${fmtOut(rm)}`);
    return `no deadlock - ${w1.text}; ${w2}`;
  });

  // R2a: release holds first, a recompute whose snapshot predates the release's
  // commit is queued on the line. When the release commits (line released, entry
  // POSTED) the recompute must not rewrite a line that now has a posted entry.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R2a", "release commits first while recompute is queued on the line: a posted line's fees must not change", async () => {
    const f = await mkVisit({ states: ["ready"], paid: true, fee: true });
    const A: Row = { table: "test_requests", id: f.ids[0], label: "A" };
    const V: Row = { table: "visits", id: f.visit, label: "V" };
    const m = await actor("release", fx.med1);
    await begin(m);
    const r1 = expectOk("release", await release(m, f.visit, [f.ids[0]]));
    if (r1.released.length !== 1) throw new Fail(`release: expected 1 released, got ${r1.released.length}`);
    const rec = await actor("recompute", null);
    await begin(rec, PHYSICAL_PLAN);
    const prec = andRollback(rec, recompute(rec), async () => {
      const { rows } = await rec.c.query<{ clinic: string; pf: string }>(
        "select clinic_fee_php as clinic, doctor_pf_php as pf from public.test_requests where id = $1",
        [f.ids[0]],
      );
      return rows[0];
    });
    const w = await mustBlockOn(rec, [A, V], m, "recompute (snapshot taken before the release commits) queues behind the release");
    await m.c.query("commit");
    const { out, seen } = await prec;
    if (!out.ok) throw new Fail(`recompute failed: ${fmtOut(out)}`);
    const posted = await postedJes(f.ids[0]);
    if (posted !== 1) throw new Fail(`fixture: expected 1 posted entry after the release, found ${posted}`);
    if (!seen) throw new Fail("could not read the line from inside the recompute transaction");
    if (Number(seen.clinic) !== FEE.clinic || Number(seen.pf) !== FEE.pf) {
      throw new Fail(
        `lost update: recompute (rows_affected ${out.v.rows_affected}) rewrote a line the release had just POSTED - ` +
          `clinic_fee ${FEE.clinic} -> ${seen.clinic}, doctor_pf ${FEE.pf} -> ${seen.pf} while a posted journal entry exists. ${w.text}`,
      );
    }
    return `line untouched (clinic ${seen.clinic}, pf ${seen.pf}); ${w.text}`;
  });

  // R2b: recompute holds first (visit FOR UPDATE + the line), release queues on the
  // visit, recompute commits: the release must see the recomputed fee and post that.
  // COMMITS a recompute - only runs when every eligible line on the stack is ours.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R2b", "recompute commits first while release is queued: release posts the recomputed fee", async () => {
    const foreign = await foreignEligible();
    if (foreign > 0) {
      throw new Fail(`refusing to COMMIT a recompute: ${foreign} eligible line(s) on this stack are not this run's`);
    }
    const f = await mkVisit({ states: ["ready"], paid: true, fee: true });
    const V: Row = { table: "visits", id: f.visit, label: "V" };
    const rec = await actor("recompute", null);
    await begin(rec, PHYSICAL_PLAN);
    const rr = expectOk("recompute", await recompute(rec));
    if (rr.rows_affected < 1) throw new Fail(`recompute changed nothing (rows_affected ${rr.rows_affected}): the fixture is not eligible`);
    const m = await actor("release", fx.med1);
    await begin(m);
    const pm = andEnd(m, release(m, f.visit, [f.ids[0]]));
    const w = await mustBlockOn(m, V, rec, "release wants the visit FOR SHARE, held FOR UPDATE by recompute's guard");
    await rec.c.query("commit");
    const r = expectOk("release", await pm);
    if (r.released.length !== 1) throw new Fail(`release: expected 1 released, got ${r.released.length}`);
    const row = await lineOf(f.ids[0]);
    if (Number(row.clinic_fee_php) !== 0 || Number(row.doctor_pf_php) !== 100) {
      throw new Fail(`after both: expected the recomputed fees 0 / 100, got ${row.clinic_fee_php} / ${row.doctor_pf_php}`);
    }
    const posted = await postedJes(f.ids[0]);
    if (posted !== 1) throw new Fail(`expected 1 posted entry for the released line, found ${posted}`);
    return `${w.text}; release posted after the recompute committed (fees 0 / 100)`;
  });

  // R3: recompute vs claim / unclaim, the PLAN-order race. Lines A < B (by id),
  // stored B before A. W holds A. Claim (id-ordered pre-lock, 0211) queues on A
  // holding nothing. recompute (physical plan) reaches B first, locks it (+V), then
  // queues on A behind the claim. When W commits: claim gets A and wants B.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  for (const wr of ["claim", "unclaim"] as const) {
    await scenario(`R3-${wr}`, `recompute (plan order) vs ${wr}, heap order reversed: third writer holds A -> must not deadlock`, async () => {
      const ip = wr === "unclaim";
      const f = await mkVisit({ states: ip ? ["in_progress", "in_progress"] : ["requested", "requested"], paid: false, fee: true, physical: "desc" });
      const [lo, hi] = f.ids;
      if (!(await storedBefore(hi, lo))) throw new Fail("fixture: the higher id is not stored before the lower one");
      const A: Row = { table: "test_requests", id: lo, label: "A" };
      const B: Row = { table: "test_requests", id: hi, label: "B" };
      const V: Row = { table: "visits", id: f.visit, label: "V" };
      const g = await actor("W", null);
      await beginRaw(g);
      await g.c.query("select 1 from public.test_requests where id = $1 for update", [lo]);
      const w = await actor("M2", fx.med2);
      await begin(w);
      const pw = andEnd(w, wr === "claim" ? claim(w, [hi, lo]) : unclaim(w, [hi, lo], [fx.med2, fx.med2]));
      const w1 = await mustBlockOn(w, A, g, `the ${wr} locks A (lowest id) first and queues behind W holding nothing`);
      const rec = await actor("recompute", null);
      await begin(rec, PHYSICAL_PLAN);
      const prec = andRollback(rec, recompute(rec));
      const w2 = await mustBlockOn(rec, A, null, `recompute queues on A behind the ${wr}`);
      const heldB = await rowLocked("test_requests", hi);
      const heldV = await rowLocked("visits", f.visit);
      await g.c.query("commit");
      const cycle = await (async () => {
        await sleep(300);
        return describeWaits([w, rec], [A, B, V]);
      })();
      const [rw, rr] = await raceResult([wr, "recompute"], pw, prec.then((x) => x.out));
      const victim = deadlockVictim([wr, "recompute"], rw, rr);
      const order = heldB ? `plan order: held B${heldV ? " + V" : ""} before queueing on A` : "id order: held nothing while queued on A";
      if (victim) {
        throw new Fail(
          `40P01 deadlock (victim: ${victim}): recompute (${order}) vs ${wr}. ${w1.text}; ${w2.text}; after W commits: ${cycle}`,
        );
      }
      if (!rw.ok) throw new Fail(`${wr} failed: ${fmtOut(rw)}`);
      if (!rr.ok) throw new Fail(`recompute failed: ${fmtOut(rr)}`);
      if (rw.v !== 2) throw new Fail(`${wr}: expected 2 rows, got ${rw.v}`);
      return `no deadlock - recompute ${order}; ${w1.text}; ${w2.text}`;
    });
  }

  // R4: recompute vs UNDO. Only reachable for a released line with NO posted
  // entry (legacy-import provenance, 0159's early return). The R1 shape.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R4", "recompute vs undo of a released line that has no posted entry (R1 shape): must not deadlock", async () => {
    const f = await mkVisit({ states: ["released"], paid: true, fee: true });
    // Forge the legacy shape: drop the release entry (no bridge posted it). Only this run's rows.
    await monitor.query("begin");
    try {
      await monitor.query("set local session_replication_role = replica");
      const { rows: je } = await monitor.query<{ id: string }>(
        "select id from public.journal_entries where source_kind = 'test_request' and source_id = $1",
        [f.ids[0]],
      );
      if (je.length < 1) throw new Fail("fixture: the released line has no entry to drop");
      await monitor.query("delete from public.journal_lines where entry_id = any($1::uuid[])", [je.map((j) => j.id)]);
      await monitor.query("delete from public.journal_entries where id = any($1::uuid[])", [je.map((j) => j.id)]);
      await monitor.query("commit");
    } catch (e) {
      await monitor.query("rollback").catch(() => undefined);
      throw e;
    }
    const A: Row = { table: "test_requests", id: f.ids[0], label: "A" };
    const V: Row = { table: "visits", id: f.visit, label: "V" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.visits where id = $1 for share", [f.visit]);
    const rec = await actor("recompute", null);
    await begin(rec, PHYSICAL_PLAN);
    const prec = andRollback(rec, recompute(rec));
    const w1 = await mustBlockOn(rec, V, g, "recompute's fee guard wants the visit FOR UPDATE while W holds it FOR SHARE");
    const heldA = await rowLocked("test_requests", f.ids[0]);
    const a = await actor("undo", fx.admin1);
    await begin(a);
    const pu = andEnd(a, undo(a, f.visit, [f.ids[0]]));
    let w2 = "undo answered at once";
    if (heldA) {
      w2 = (await mustBlockOn(a, A, rec, "undo gets V FOR SHARE and then needs A, held by recompute")).text;
    } else {
      const early = await mustNotWait(a, pu, "recompute holds no line while queued on the visit");
      if (!early.ok) throw new Fail(`undo failed: ${fmtOut(early)}`);
    }
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([rec, a], [A, V]);
    })();
    const [rr, ru] = await raceResult(["recompute", "undo"], prec.then((x) => x.out), pu);
    const victim = deadlockVictim(["recompute", "undo"], rr, ru);
    if (victim) {
      throw new Fail(`40P01 deadlock (victim: ${victim}): recompute held A and queued on V FOR UPDATE, undo held V FOR SHARE and wanted A. ${w1.text}; ${w2}; after W commits: ${cycle}`);
    }
    if (!rr.ok) throw new Fail(`recompute failed: ${fmtOut(rr)}`);
    if (!ru.ok) throw new Fail(`undo failed: ${fmtOut(ru)}`);
    return `no deadlock - ${w1.text}; ${w2}`;
  });

  // R5: two visits. recompute holds V1's line (+V1) when it queues on V2 behind W;
  // a release on V2 holds V2 FOR SHARE and wants V2's line. Passing only if
  // recompute orders its visit locks (the fix); today it is R1's cycle again.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R5", "recompute over two visits vs a release on the second (W holds V2 FOR SHARE): must not deadlock", async () => {
    const f1 = await mkVisit({ states: ["ready"], paid: true, fee: true });
    const f2 = await mkVisit({ states: ["ready"], paid: true, fee: true });
    const A1: Row = { table: "test_requests", id: f1.ids[0], label: "A1" };
    const A2: Row = { table: "test_requests", id: f2.ids[0], label: "A2" };
    const V1: Row = { table: "visits", id: f1.visit, label: "V1" };
    const V2: Row = { table: "visits", id: f2.visit, label: "V2" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.visits where id = $1 for share", [f2.visit]);
    const rec = await actor("recompute", null);
    await begin(rec, PHYSICAL_PLAN);
    const prec = andRollback(rec, recompute(rec));
    const w1 = await mustBlockOn(rec, V2, g, "recompute reaches V2's line second and its guard queues on V2 behind W");
    const heldA1 = await rowLocked("test_requests", f1.ids[0]);
    const heldA2 = await rowLocked("test_requests", f2.ids[0]);
    const heldV1 = await rowLocked("visits", f1.visit);
    const m = await actor("release", fx.med1);
    await begin(m);
    const pm = andEnd(m, release(m, f2.visit, [f2.ids[0]]));
    let w2 = "release answered at once";
    if (heldA2) {
      w2 = (await mustBlockOn(m, A2, rec, "release gets V2 FOR SHARE (with W) and then needs A2, held by recompute")).text;
    } else {
      const early = await mustNotWait(m, pm, "recompute holds no V2 line while queued on V2");
      if (!early.ok) throw new Fail(`release failed: ${fmtOut(early)}`);
    }
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([rec, m], [A1, A2, V1, V2]);
    })();
    const [rr, rm] = await raceResult(["recompute", "release"], prec.then((x) => x.out), pm);
    const held = `recompute held ${[heldA1 && "A1", heldV1 && "V1", heldA2 && "A2"].filter(Boolean).join("+") || "nothing"} while queued on V2`;
    const victim = deadlockVictim(["recompute", "release"], rr, rm);
    if (victim) {
      throw new Fail(`40P01 deadlock (victim: ${victim}): ${held}; release held V2 FOR SHARE and wanted A2. ${w1.text}; ${w2}; after W commits: ${cycle}`);
    }
    if (!rr.ok) throw new Fail(`recompute failed: ${fmtOut(rr)}`);
    if (!rm.ok) throw new Fail(`release failed: ${fmtOut(rm)}`);
    return `no deadlock - ${held}; ${w1.text}; ${w2}`;
  });
}

// ---------------------------------------------------------------------------
// Q - fn_queue_delete_cascade (package header soft delete)
// ---------------------------------------------------------------------------

// The lock-order race shared by Q1 / Q2: components x1 < x2, x2 stored BEFORE x1.
// W holds x1. The claim / unclaim (id-ordered pre-lock) queues on x1 holding
// nothing. The header delete locks H, then the cascade UPDATEs the components
// `where parent_id = H` in plan order: x2 first, then it queues on x1 behind the
// claim. When W commits the claim gets x1 and wants x2 -> a cycle.
async function cascadeRace(writer: "claim" | "unclaim"): Promise<string> {
    const ip = writer === "unclaim";
  const p = await mkPkg({ comps: ip ? ["in_progress", "in_progress"] : ["requested", "requested"] });
  if (!(await storedBefore(p.x2, p.x1))) throw new Fail("fixture: x2 is not stored before x1 (heap order not reversed)");
  const X1: Row = { table: "test_requests", id: p.x1, label: "X1" };
  const X2: Row = { table: "test_requests", id: p.x2, label: "X2" };
  const H: Row = { table: "test_requests", id: p.header, label: "H" };
  const g = await actor("W", null);
  await beginRaw(g);
  await g.c.query("select 1 from public.test_requests where id = $1 for update", [p.x1]);
  const w = await actor("M2", fx.med2);
  await begin(w);
  const pw = andEnd(w, writer === "claim" ? claim(w, [p.x2, p.x1]) : unclaim(w, [p.x2, p.x1], [fx.med2, fx.med2]));
  const w1 = await mustBlockOn(w, X1, g, `the ${writer} locks x1 (lowest id) first and queues behind W holding nothing`);
  const d = await actor("delete", null);
  await begin(d);
  const pd = andEnd(d, deleteLines(d, p.visit, [p.header]));
  const w2 = await mustBlockOn(d, X1, null, `the header delete's cascade reaches x1 and queues behind the ${writer}`);
  const heldX2 = await rowLocked("test_requests", p.x2);
  await g.c.query("commit");
  const cycle = await (async () => {
    await sleep(300);
    return describeWaits([w, d], [H, X1, X2]);
  })();
  const [rw, rd] = await raceResult([writer, "delete"], pw, pd);
  const order = heldX2 ? "plan order: held x2 before queueing on x1" : "id order: held nothing while queued on x1";
  const victim = deadlockVictim([writer, "delete"], rw, rd);
  if (victim) {
    throw new Fail(
      `40P01 deadlock (victim: ${victim}): header delete (cascade, ${order}; holds H) vs ${writer} (id order). ` +
        `${w1.text}; ${w2.text}; after W commits: ${cycle}`,
    );
  }
  if (!rw.ok) throw new Fail(`${writer} failed: ${fmtOut(rw)}`);
  if (!rd.ok) throw new Fail(`delete failed: ${fmtOut(rd)}`);
  if (rw.v !== 2) throw new Fail(`${writer}: expected 2 rows, got ${rw.v}`);
  for (const id of [p.header, p.x1, p.x2]) {
    if (!(await lineOf(id)).deleted_at) throw new Fail("after both: the header and its components should all be deleted");
  }
  return `no deadlock - delete ${order}; ${w1.text}; ${w2.text}`;
}

async function cascadeScenarios(): Promise<void> {
  // concurrency-proof: fn_queue_delete_cascade
  await scenario("Q1", "header delete (cascade in plan order) vs claim of the components, heap order reversed: must not deadlock", () =>
    cascadeRace("claim"),
    { known: "PR 3b" },
  );
  // concurrency-proof: fn_queue_delete_cascade
  await scenario("Q2", "header delete (cascade in plan order) vs unclaim of the components, heap order reversed: must not deadlock", () =>
    cascadeRace("unclaim"),
    { known: "PR 3b" },
  );

  // Q3 (OBSERVE ONLY): header delete vs RELEASE of a component on an HMO visit. The
  // known accepted cycle: release locks X1 (lowest id) then H; the delete holds H
  // first, then its cascade wants X1. An id-ordered pre-lock in the cascade cannot
  // help (H is already held); Q3b runs the same race with the delete doing that
  // pre-lock by hand to show it.
  for (const pre of [false, true]) {
    await scenario(
      pre ? "Q3b" : "Q3",
      `${pre ? "WHAT-IF: delete pre-locks H then the components ORDER BY id; " : ""}header delete vs release of component x1 (HMO visit)`,
      async () => {
        const p = await mkPkg({ comps: ["ready", "requested"], hmo: true });
        const X1: Row = { table: "test_requests", id: p.x1, label: "X1" };
        const X2: Row = { table: "test_requests", id: p.x2, label: "X2" };
        const H: Row = { table: "test_requests", id: p.header, label: "H" };
        const V: Row = { table: "visits", id: p.visit, label: "V" };
        const g = await actor("W", null);
        await beginRaw(g);
        await g.c.query("select 1 from public.test_requests where id = $1 for update", [p.x1]);
        const m = await actor("release", fx.med1);
        await begin(m);
        const pm = andEnd(m, release(m, p.visit, [p.x1]));
        const w1 = await mustBlockOn(m, X1, g, "release locks V FOR SHARE, then x1 (lowest id of {x1, H}) and queues behind W");
        const d = await actor("delete", null);
        await begin(d);
        const pd = andEnd(
          d,
          (async () => {
            if (pre) {
              await d.c.query("select 1 from public.test_requests where id = $1 for update", [p.header]);
              await d.c.query(
                "select 1 from public.test_requests where parent_id = $1 and deleted_at is null order by id for update",
                [p.header],
              );
            }
            return deleteLines(d, p.visit, [p.header]);
          })(),
        );
        const w2 = await mustBlockOn(d, X1, null, "the delete holds H and reaches x1 in its cascade / pre-lock, behind the release");
        await g.c.query("commit");
        const cycle = await (async () => {
          await sleep(300);
          return describeWaits([m, d], [H, X1, X2, V]);
        })();
        const [rm, rd] = await raceResult(["release", "delete"], pm, pd);
        const victim = deadlockVictim(["release", "delete"], rm, rd);
        return (
          `${victim ? `40P01 DEADLOCK, victim: ${victim}` : "no deadlock"} (release: ${fmtOut(rm)}; delete: ${fmtOut(rd)}). ` +
          `${w1.text}; ${w2.text}; after W commits: ${cycle}`
        );
      },
      { known: "PR 3b" },
    );
  }

  // Q4: header RESTORE vs claim. claim / unclaim require deleted_at is null, so
  // deleted components are never in their lock set: they must not wait on each other.
  // concurrency-proof: fn_queue_delete_cascade
  await scenario("Q4", "header restore (open) vs claim of its still-deleted components: neither waits for the other", async () => {
    const p = await mkPkg({ comps: ["requested", "requested"], deleted: true });
    const d = await actor("restore", null);
    await begin(d);
    const n = expectOk("restore", await restoreLines(d, p.visit, [p.header]));
    if (n !== 1) throw new Fail(`restore: expected 1 header row, got ${n}`);
    const w = await actor("M2", fx.med2);
    await begin(w);
    const pw = andEnd(w, claim(w, [p.x1, p.x2]));
    const out = await mustNotWait(w, pw, "the components are still deleted in the claim's snapshot, so they are not in its lock set");
    if (out.ok) throw new Fail("claim of two deleted components should have been refused (P0077), but it succeeded");
    if (out.code !== "P0077") throw new Fail(`claim: expected P0077, got ${fmtOut(out)}`);
    await d.c.query("commit");
    for (const id of [p.header, p.x1, p.x2]) {
      const r = await lineOf(id);
      if (r.deleted_at) throw new Fail("after the restore: the header and components should be live again");
    }
    if ((await lineOf(p.x1)).assigned_to) throw new Fail("the refused claim must not have claimed anything");
    return "claim answered P0077 at once while the restore was open; restore committed; nothing claimed";
  });

  // Q5 (OBSERVE ONLY): the bulk line delete (bulk-delete-core.ts) of two PLAIN lines
  // stored in reverse heap order vs a claim of the same two lines. Same shape as Q1.
  await scenario(
    "Q5",
    "bulk delete of two plain lines (reverse heap order) vs claim of the same two lines",
    async () => {
      const f = await mkVisit({ states: ["requested", "requested"], paid: false, physical: "desc" });
      const [lo, hi] = f.ids;
      if (!(await storedBefore(hi, lo))) throw new Fail("fixture: the higher id is not stored before the lower one");
      const LO: Row = { table: "test_requests", id: lo, label: "lo" };
      const HI: Row = { table: "test_requests", id: hi, label: "hi" };
      const g = await actor("W", null);
      await beginRaw(g);
      await g.c.query("select 1 from public.test_requests where id = $1 for update", [lo]);
      const w = await actor("M2", fx.med2);
      await begin(w);
      const pw = andEnd(w, claim(w, [hi, lo]));
      const w1 = await mustBlockOn(w, LO, g, "the claim locks the lower id first and queues behind W holding nothing");
      const d = await actor("bulk-delete", null);
      await begin(d);
      const pd = andEnd(d, deleteLines(d, f.visit, [hi, lo]));
      const w2 = await mustBlockOn(d, LO, null, "the bulk delete reaches the lower line and queues behind the claim");
      const heldHi = await rowLocked("test_requests", hi);
      await g.c.query("commit");
      const cycle = await (async () => {
        await sleep(300);
        return describeWaits([w, d], [LO, HI]);
      })();
      const [rw, rd] = await raceResult(["claim", "bulk-delete"], pw, pd);
      const victim = deadlockVictim(["claim", "bulk-delete"], rw, rd);
      return (
        `${victim ? `40P01 DEADLOCK, victim: ${victim}` : "no deadlock"} (delete ${heldHi ? "held the higher line before queueing (plan order)" : "held nothing while queued (id order)"}; ` +
        `claim: ${fmtOut(rw)}; delete: ${fmtOut(rd)}). ${w1.text}; ${w2.text}; after W commits: ${cycle}`
      );
    },
    { known: "PR 3b" },
  );
}

// ---------------------------------------------------------------------------
// P - fn_release_headers_on_visit_paid (payment flip)
// ---------------------------------------------------------------------------

// Final consistency of a two-header visit: a header is released iff all its
// components are released.
async function expectHeadersConsistent(label: string, t: TwoHdr): Promise<string> {
  const { rows } = await monitor.query<{ id: string; status: string; comp: string }>(
    `select h.id, h.status, c.status as comp
       from public.test_requests h join public.test_requests c on c.parent_id = h.id
      where h.id = any($1::uuid[])`,
    [[t.h1, t.h2]],
  );
  const nm = (id: string) => (id === t.h1 ? "H1" : "H2");
  const out: string[] = [];
  for (const r of rows) {
    const headerReleased = r.status === "released";
    const compReleased = r.comp === "released";
    out.push(`${nm(r.id)}:${r.status}/${r.comp}`);
    if (headerReleased && !compReleased) {
      throw new Fail(`${label}: ${nm(r.id)} is released but its component is ${r.comp} (split package) [${out.join(", ")}]`);
    }
  }
  return out.join(", ");
}

async function headerReleaseScenarios(): Promise<void> {
  // P1: payment flip vs UNDO of a component of H1, both orders. They serialise on
  // the visit row (undo FOR SHARE vs the recalc FOR UPDATE); no 40P01.
  // concurrency-proof: fn_release_headers_on_visit_paid
  await scenario("P1a", "payment flip holds first (releases H1, H2) -> undo of H1's component waits on the visit, then finishes", async () => {
    const t = await mkTwoHeaders();
    const V: Row = { table: "visits", id: t.visit, label: "V" };
    const pay = await actor("payment", fx.admin1);
    await begin(pay);
    expectOk("payment", await insertPayment(pay, t.visit, t.total));
    const a = await actor("undo", fx.admin1);
    await begin(a);
    const pu = andEnd(a, undo(a, t.visit, [t.c1]));
    const w = await mustBlockOn(a, V, pay, "the undo wants the visit FOR SHARE; the payment's recalc holds it FOR UPDATE");
    await pay.c.query("commit");
    const u = await pu;
    if (!u.ok) {
      if (u.code === "40P01") throw new Fail(`40P01 deadlock (victim: undo): payment flip vs undo. ${w.text}`);
      throw new Fail(`undo failed: ${fmtOut(u)}`);
    }
    const state = await expectHeadersConsistent("after both", t);
    return `${w.text}; undone ${u.v.undone.length}, skipped ${u.v.skipped.length}; final ${state}`;
  });
  // concurrency-proof: fn_release_headers_on_visit_paid
  await scenario("P1b", "undo of H1's component holds first -> payment flip waits on the visit, then finishes", async () => {
    const t = await mkTwoHeaders();
    const V: Row = { table: "visits", id: t.visit, label: "V" };
    const a = await actor("undo", fx.admin1);
    await begin(a);
    const u = await undo(a, t.visit, [t.c1]);
    if (!u.ok) throw new Fail(`undo failed: ${fmtOut(u)}`);
    const pay = await actor("payment", fx.admin1);
    await begin(pay);
    const pp = andEnd(pay, insertPayment(pay, t.visit, t.total));
    const w = await mustBlockOn(pay, V, null, "the payment's recalc wants the visit FOR UPDATE while the undo holds it FOR SHARE");
    await a.c.query("commit");
    const r = await pp;
    if (!r.ok) {
      if (r.code === "40P01") throw new Fail(`40P01 deadlock (victim: payment): undo vs payment flip. ${w.text}`);
      throw new Fail(`payment failed: ${fmtOut(r)}`);
    }
    const state = await expectHeadersConsistent("after both", t);
    return `${w.text}; undone ${u.v.undone.length}; final ${state}`;
  });

  // P2: payment flip (open) vs claim / unclaim of OTHER lines of the same visit:
  // no shared rows, nothing to wait for.
  // concurrency-proof: fn_release_headers_on_visit_paid
  for (const wr of ["claim", "unclaim"] as const) {
    await scenario(`P2-${wr}`, `payment flip (open, holds the visit + both headers) vs ${wr} of another line of the visit: must not wait`, async () => {
      const t = await mkTwoHeaders();
      const pay = await actor("payment", fx.admin1);
      await begin(pay);
      expectOk("payment", await insertPayment(pay, t.visit, t.total));
      const w = await actor("M2", fx.med2);
      await begin(w);
      const pw = andEnd(w, wr === "claim" ? claim(w, [t.req]) : unclaim(w, [t.ip], [fx.med2]));
      const out = await mustNotWait(w, pw, `the ${wr} touches only a plain line the payment never locks`);
      if (!out.ok) throw new Fail(`${wr} failed: ${fmtOut(out)}`);
      await pay.c.query("commit");
      const state = await expectHeadersConsistent("after both", t);
      return `${wr} answered at once while the payment was open; final ${state}`;
    });
  }

  // P3: payment flip vs RECOMPUTE (the headers are eligible: their release entry was
  // reversed). W holds the visit FOR SHARE; the payment queues on it FIRST (its
  // recalc FOR UPDATE), then recompute reaches a header (locks it) and queues on
  // the visit behind it. When W commits the payment gets the visit and its trigger
  // wants the header recompute holds; recompute wants the visit the payment holds.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  // concurrency-proof: fn_release_headers_on_visit_paid
  await scenario("P3", "payment flip vs recompute over the (eligible) headers, visit held FOR SHARE by a third writer: must not deadlock", async () => {
    const t = await mkTwoHeaders();
    const V: Row = { table: "visits", id: t.visit, label: "V" };
    const H1: Row = { table: "test_requests", id: t.h1, label: "H1" };
    const H2: Row = { table: "test_requests", id: t.h2, label: "H2" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.visits where id = $1 for share", [t.visit]);
    const pay = await actor("payment", fx.admin1);
    await begin(pay);
    const pp = andEnd(pay, insertPayment(pay, t.visit, t.total));
    const w1 = await mustBlockOn(pay, V, null, "the payment's recalc queues on the visit behind W");
    const rec = await actor("recompute", null);
    await begin(rec, PHYSICAL_PLAN);
    const prec = andRollback(rec, recompute(rec));
    const w2 = await mustBlockOn(rec, V, null, "recompute locks a header, then its fee guard queues on the visit behind the payment");
    const heldH2 = await rowLocked("test_requests", t.h2);
    const heldH1 = await rowLocked("test_requests", t.h1);
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([pay, rec], [H1, H2, V]);
    })();
    const [rp, rr] = await raceResult(["payment", "recompute"], pp, prec.then((x) => x.out));
    const held = `recompute held ${[heldH2 && "H2", heldH1 && "H1"].filter(Boolean).join("+") || "nothing"} while queued on V`;
    const victim = deadlockVictim(["payment", "recompute"], rp, rr);
    if (victim) {
      throw new Fail(`40P01 deadlock (victim: ${victim}): ${held}; the payment's header-release trigger wanted a header recompute held, recompute wanted the visit the payment held. ${w1.text}; ${w2.text}; after W commits: ${cycle}`);
    }
    if (!rp.ok) throw new Fail(`payment failed: ${fmtOut(rp)}`);
    if (!rr.ok) throw new Fail(`recompute failed: ${fmtOut(rr)}`);
    const state = await expectHeadersConsistent("after both", t);
    return `no deadlock - ${held}; ${w1.text}; ${w2.text}; final ${state}`;
  });
}


// ---------------------------------------------------------------------------
// Control rounds (--control): prove the proof can fail
// ---------------------------------------------------------------------------
//
// Each mutant is a copy of the LIVE recompute function in a throwaway schema
// (plo_ctl_<hex>, never public - the stack is shared) with ONE guard removed; the
// named scenarios run against it through fn.recomputeSchema and the round passes
// only if every one of them FAILS ("caught"). B0 is the unmutated copy and must
// pass them all, so a broken copy cannot make every mutant look caught.
//   M1  the pre-0215 (0184) body: no visit/line pre-lock, one UPDATE over a CTE
//   M2  no visit pre-lock (b): lines are locked first, the 0183 guard then takes the visit
//   M3  no line pre-lock (c): the UPDATE locks the lines in plan order
//   M4  no predicate re-check in (d): updates every line collected in (a)
// NOT covered: the guards that live in triggers on public tables
// (guard_test_request_on_waived_visit) - a trigger on a public table fires for
// every session, so a mutant of it cannot be isolated.

const CTL_SCHEMA = `plo_ctl_${TAG.slice(4)}`;

// The pre-0215 body (0184), verbatim from pg_get_functiondef before 0215 was applied.
const PRE_FIX_BODY = "CREATE OR REPLACE FUNCTION public.recompute_clinic_fee_for_unreleased()\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public', 'pg_temp'\nAS $function$\ndeclare\n  v_affected int;\nbegin\n  with target_ids as (\n    select tr.id\n    from public.test_requests tr\n    join public.visits v on v.id = tr.visit_id\n    join public.patients pt on pt.id = v.patient_id   -- 0184: only an active patient's line\n    left join public.physicians p\n      on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)\n    left join public.physician_compensation pc on pc.physician_id = p.id\n    where coalesce(\n            pc.clinic_cut_php,\n            case when pc.compensation_arrangement in ('rent_paying', 'shareholder') then 0 else 100 end\n          ) = 0\n      and tr.clinic_fee_php > 0\n      and pt.deleted_at is null and pt.merged_into_id is null   -- 0184\n      and not exists (\n        select 1 from public.journal_entries je\n        where je.source_kind = 'test_request'\n          and je.source_id = tr.id\n          and je.status = 'posted'\n      )\n  ),\n  updated as (\n    update public.test_requests tr2\n      set clinic_fee_php = 0,\n          doctor_pf_php = tr2.final_price_php\n      where tr2.id in (select id from target_ids)\n      returning tr2.id\n  )\n  select count(*) into v_affected from updated;\n\n  return jsonb_build_object('rows_affected', v_affected);\nend;\n$function$";

interface Mutant {
  key: string;
  what: string;
  // [from, to] replacements applied in order to the LIVE definition; each must match.
  edits: Array<[string, string]>;
  replaceWhole?: boolean; // M1: use PRE_FIX_BODY instead of the live definition
  mustFail: string[];
}

const MUTANTS: Mutant[] = [
  {
    key: "M1",
    what: "the pre-0215 body (one UPDATE over a CTE, no pre-lock)",
    edits: [],
    replaceWhole: true,
    mustFail: ["R1", "R2a", "R3-claim", "R3-unclaim", "R4", "R5", "P3"],
  },
  {
    key: "M2",
    what: "no visit pre-lock (b)",
    edits: [["  perform 1 from public.visits\n   where id = any (v_visits)\n   order by id\n     for update;", ""]],
    mustFail: ["R1", "R4", "R5", "P3"],
  },
  {
    key: "M3",
    what: "no line pre-lock (c) - lines locked by the UPDATE, plan order",
    edits: [["  perform 1 from public.test_requests\n   where id = any (v_lines)\n   order by id\n     for update;", ""]],
    mustFail: ["R3-claim", "R3-unclaim"],
  },
  {
    key: "M4",
    what: "no eligibility re-check in (d) - updates every line collected in (a)",
    edits: [
      ["     where tr2.id = any (v_lines)\n       and tr2.id in (", "     where tr2.id = any (v_lines)\n       and (true or tr2.id in ("],
      ["            )\n       )\n    returning tr2.id", "            )\n       ))\n    returning tr2.id"],
    ],
    mustFail: ["R2a"],
  },
];

async function installCopy(m: Mutant | null): Promise<void> {
  let def: string;
  if (m?.replaceWhole) def = PRE_FIX_BODY;
  else {
    const { rows } = await monitor.query<{ d: string }>(
      "select pg_get_functiondef('public.recompute_clinic_fee_for_unreleased()'::regprocedure) as d",
    );
    def = rows[0].d;
  }
  for (const [from, to] of m?.edits ?? []) {
    if (!def.includes(from)) throw new Error(`mutant ${m?.key}: text to replace not found in the live body`);
    def = def.replace(from, to);
  }
  def = def.replace("public.recompute_clinic_fee_for_unreleased", `${CTL_SCHEMA}.recompute_clinic_fee_for_unreleased`);
  await monitor.query(`drop schema if exists ${CTL_SCHEMA} cascade`);
  await monitor.query(`create schema ${CTL_SCHEMA}`);
  await monitor.query(`grant usage on schema ${CTL_SCHEMA} to service_role`);
  await monitor.query(def);
  await monitor.query(`grant execute on function ${CTL_SCHEMA}.recompute_clinic_fee_for_unreleased() to service_role`);
}

const CONTROL_SCENARIOS = ["R1", "R2a", "R3-claim", "R3-unclaim", "R4", "R5", "P3"];

async function controlRounds(): Promise<void> {
  console.log("\ncontrol rounds (a mutant must make its scenarios FAIL):");
  const savedOnly = only;
  const rounds: Array<{ key: string; what: string; m: Mutant | null; list: string[]; wantPass: boolean }> = [
    { key: "B0", what: "unmutated copy of the live body", m: null, list: CONTROL_SCENARIOS, wantPass: true },
    ...MUTANTS.map((m) => ({ key: m.key, what: m.what, m, list: m.mustFail, wantPass: false })),
  ];
  for (const r of rounds) {
    await installCopy(r.m);
    fn.recomputeSchema = CTL_SCHEMA;
    only = r.list;
    const mine: Result[] = [];
    sink = mine;
    quiet = true;
    try {
      await recomputeScenarios();
      await headerReleaseScenarios();
    } finally {
      sink = results;
      quiet = false;
      fn.recomputeSchema = "public";
      only = savedOnly;
    }
    const got = new Map(mine.map((x) => [x.id, x]));
    const missing = r.list.filter((id) => !got.has(id));
    const wrong = r.list.filter((id) => got.has(id) && got.get(id)!.ok !== r.wantPass);
    const ok = missing.length === 0 && wrong.length === 0;
    const caught = r.list.filter((id) => got.get(id) && !got.get(id)!.ok);
    const label = r.wantPass ? `B0 baseline: ${r.list.length - wrong.length - missing.length}/${r.list.length} scenarios pass` : `${r.key} (${r.what}): caught by ${caught.join(", ") || "nothing"} (${caught.length}/${r.list.length})`;
    results.push({
      id: `control-${r.key}`,
      name: label,
      ok,
      observed: false,
      detail: ok ? "" : `${missing.length ? `not run: ${missing.join(",")}. ` : ""}${wrong.length ? (r.wantPass ? `failed on the unmutated copy: ${wrong.map((id) => `${id} (${got.get(id)!.detail.slice(0, 120)})`).join("; ")}` : `SURVIVED (passed): ${wrong.join(",")}`) : ""}`,
    });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` - ${results[results.length - 1].detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// Prerequisites (by object, not by ledger), seed, teardown
// ---------------------------------------------------------------------------

async function checkPrerequisites(): Promise<void> {
  const need = async (what: string, sql: string, params: unknown[] = []): Promise<void> => {
    const { rows } = await monitor.query<{ ok: boolean }>(sql, params);
    if (!rows[0]?.ok) throw new Error(`prerequisite missing on the local stack: ${what}`);
  };
  await need("recompute_clinic_fee_for_unreleased()", "select to_regprocedure('public.recompute_clinic_fee_for_unreleased()') is not null as ok");
  await need("fn_queue_delete_cascade() + its trigger", "select to_regprocedure('public.fn_queue_delete_cascade()') is not null and exists (select 1 from pg_trigger where tgname = 'trg_queue_delete_cascade' and tgenabled <> 'D') as ok");
  await need("fn_release_headers_on_visit_paid() + its trigger", "select to_regprocedure('public.fn_release_headers_on_visit_paid()') is not null and exists (select 1 from pg_trigger where tgname = 'tg_release_headers_on_visit_paid' and tgenabled <> 'D') as ok");
  await need("guard_test_request_on_waived_visit (0183) trigger", "select exists (select 1 from pg_trigger where tgname = 'trg_test_requests_waived_visit_guard' and tgenabled <> 'D') as ok");
  await need("release_visit_results / undo_visit_release (0198 + 0205)", "select to_regprocedure('public.release_visit_results(uuid,uuid[],text,uuid,jsonb)') is not null and to_regprocedure('public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)') is not null as ok");
  await need(
    "claim_panel_members / unclaim_panel_members with 0211's id-ordered pre-lock",
    `select (select prosrc from pg_proc where proname = 'claim_panel_members') ~* 'order by t0\\.id'
        and (select prosrc from pg_proc where proname = 'unclaim_panel_members') ~* 'order by t0\\.id' as ok`,
  );
  const { rows } = await monitor.query<{ src: string; cascade: string; hdr: string }>(
    `select (select prosrc from pg_proc where proname = 'recompute_clinic_fee_for_unreleased') as src,
            (select prosrc from pg_proc where proname = 'fn_queue_delete_cascade') as cascade,
            (select prosrc from pg_proc where proname = 'fn_release_headers_on_visit_paid') as hdr`,
  );
  const lock = (s: string) => (/for\s+update/i.test(s) ? "has explicit row locks" : "no explicit row locks (pre-fix shape)");
  console.log(`  bodies under test: recompute ${lock(rows[0].src)}; cascade ${lock(rows[0].cascade)}; header release ${lock(rows[0].hdr)}`);
}

async function sweepTagged(like: string, c: Client = monitor): Promise<void> {
  if (!/^plo-[0-9a-f]{0,6}$/.test(like)) throw new Error(`refusing to sweep pattern ${like}`);
  const up = like.toUpperCase();
  await c.query("begin");
  try {
    await c.query("set local session_replication_role = replica");
    const stmts = [
      `create temp table plo_visits on commit drop as select id from public.visits where visit_number like 'V-${up}%'`,
      `create temp table plo_staff on commit drop as select id from auth.users where email like '${like}%@example.test'`,
      `create temp table plo_tr on commit drop as select id from public.test_requests where visit_id in (select id from plo_visits)`,
      `create temp table plo_pay on commit drop as select id from public.payments where visit_id in (select id from plo_visits)`,
      `create temp table plo_je on commit drop as
         select id from public.journal_entries
          where created_by in (select id from plo_staff)
             or (source_kind = 'test_request' and source_id in (select id from plo_tr))
             or (source_kind = 'payment' and source_id in (select id from plo_pay))`,
      `insert into plo_je
         select j.id from public.journal_entries j
          where (j.reverses in (select id from plo_je)
                 or j.id in (select o.reversed_by from public.journal_entries o
                              where o.id in (select id from plo_je) and o.reversed_by is not null))
            and j.id not in (select id from plo_je)`,
      `delete from public.journal_lines where entry_id in (select id from plo_je)`,
      `delete from public.journal_entries where id in (select id from plo_je)`,
      `delete from public.audit_log
        where actor_id in (select id from plo_staff)
           or resource_id in (select id from plo_tr) or resource_id in (select id from plo_pay)
           or resource_id in (select id from plo_visits)`,
      `delete from public.release_notices where visit_id in (select id from plo_visits)`,
      `delete from public.result_test_requests where test_request_id in (select id from plo_tr)`,
      `delete from public.results where uploaded_by in (select id from plo_staff)`,
      `delete from public.payments where id in (select id from plo_pay)`,
      `delete from public.test_requests where id in (select id from plo_tr)`,
      `delete from public.visits where id in (select id from plo_visits)`,
      `delete from public.patients where drm_id like 'DRM-${up}%'`,
      `delete from public.services where code like '${up}%'`,
      `delete from public.report_groups where code like '${up}%'`,
      `delete from public.physician_compensation where physician_id in (select id from public.physicians where slug like '${like}%')`,
      `delete from public.physicians where slug like '${like}%'`,
      `delete from public.hmo_providers where name like '${like}%'`,
      `delete from public.staff_profiles where id in (select id from plo_staff)`,
      `delete from auth.users where id in (select id from plo_staff)`,
    ];
    for (const sql of stmts) await c.query(sql);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}

async function countTagged(like: string, c: Client = monitor): Promise<number> {
  const up = like.toUpperCase();
  const { rows } = await c.query<{ n: string }>(
    `select (select count(*) from auth.users where email like $1)
          + (select count(*) from public.staff_profiles where full_name like $2)
          + (select count(*) from public.services where code like $3)
          + (select count(*) from public.report_groups where code like $3)
          + (select count(*) from public.patients where drm_id like $4)
          + (select count(*) from public.visits where visit_number like $5)
          + (select count(*) from public.test_requests where id = any($6::uuid[]))
          + (select count(*) from public.payments where id = any($7::uuid[]))
          + (select count(*) from public.physicians where slug like $2)
          + (select count(*) from public.hmo_providers where name like $8)
          + (select count(*) from public.journal_entries where source_id = any($6::uuid[]) or source_id = any($7::uuid[]))
          + (select count(*) from public.audit_log where resource_type = 'test_request' and resource_id = any($6::uuid[]))
          + (select count(*) from public.release_notices where visit_id = any($9::uuid[])) as n`,
    [`${like}%@example.test`, `${like}%`, `${up}%`, `DRM-${up}%`, `V-${up}%`, made.tests, made.payments, `${like}%`, made.visits],
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
      await monitor.query("insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, $3, true)", [
        id,
        `${TAG} ${k.toUpperCase()}`,
        role,
      ]);
    }
    await monitor.query("insert into public.report_groups (id, code, name) values ($1, $2, $3)", [fx.group, TAG_UP, `${TAG} Chemistry`]);
    for (const [i, id] of fx.services.entries()) {
      await monitor.query(
        `insert into public.services (id, code, name, price_php, kind, section, report_group_id)
         values ($1, $2, $3, 100, 'lab_test', 'chemistry', $4)`,
        [id, `${TAG_UP}-${i}`, `${TAG} test ${i}`, fx.group],
      );
    }
    await monitor.query(
      `insert into public.services (id, code, name, price_php, kind, section) values ($1, $2, $3, 100, 'lab_package', 'chemistry')`,
      [fx.pkgService, `${TAG_UP}-PK`, `${TAG} package`],
    );
    for (const [i, id] of fx.compServices.entries()) {
      await monitor.query(
        `insert into public.services (id, code, name, price_php, kind, section) values ($1, $2, $3, 0, 'lab_test', 'chemistry')`,
        [id, `${TAG_UP}-C${i}`, `${TAG} component ${i}`],
      );
    }
    await monitor.query(
      `insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex) values ($1, $2, 'Plo', 'Fixture', '1990-01-01', 'female')`,
      [fx.patient, `DRM-${TAG_UP}`],
    );
    // A physician whose clinic cut is 0: every fixture line carrying a clinic fee is
    // eligible for recompute_clinic_fee_for_unreleased.
    await monitor.query("insert into public.physicians (id, slug, full_name, specialty) values ($1, $2, $3, 'General')", [
      fx.physician,
      `${TAG}-dr`,
      `${TAG} Dr Zero`,
    ]);
    await monitor.query(
      `insert into public.physician_compensation (physician_id, compensation_arrangement, clinic_cut_php) values ($1, 'rent_paying', 0)
       on conflict (physician_id) do update set compensation_arrangement = 'rent_paying', clinic_cut_php = 0`,
      [fx.physician],
    );
    await monitor.query("insert into public.hmo_providers (id, name) values ($1, $2)", [fx.hmo, `${TAG} HMO`]);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

async function teardown(c: Client = monitor): Promise<void> {
  await closeActors();
  await c.query(`drop schema if exists ${CTL_SCHEMA} cascade`);
  await sweepTagged(TAG, c);
  const left = await countTagged(TAG, c);
  if (left > 0) {
    results.push({ id: "teardown", name: "teardown", ok: false, observed: false, detail: `${left} fixture rows left behind` });
    console.log(`  FAIL     teardown - ${left} fixture rows left behind`);
  } else {
    console.log("  teardown: every fixture row removed");
  }
}

// SIGINT / SIGTERM: the main flow is mid-scenario on its own connections, so the
// cleanup runs on a FRESH connection after every connection of this run (the
// monitor, the probe and all actors) has been terminated - no fixture can be
// created behind the sweep and no open transaction can block it.
async function abortCleanup(sig: string): Promise<void> {
  aborting = true;
  console.log(`\n  ${sig} received - tearing down`);
  const cleaner = new Client({ connectionString: DB_URL });
  await cleaner.connect();
  await cleaner.query("select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and application_name = $1", [APP_NAME]);
  await sleep(300);
  await cleaner.query(`drop schema if exists ${CTL_SCHEMA} cascade`);
  await sweepTagged(TAG, cleaner);
  const left = await countTagged(TAG, cleaner);
  console.log(left > 0 ? `  FAIL     teardown - ${left} fixture rows left behind` : "  teardown: every fixture row removed");
  await cleaner.end();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  monitor = await connect();
  probe = await connect();

  const { rows: lock } = await monitor.query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtext('plan-order-lockers:proof')) as got",
  );
  if (!lock[0].got) {
    console.error("[plan-order-lockers:proof] another run is in progress on this stack - try again when it finishes.");
    await probe.end().catch(() => undefined);
    await monitor.end();
    process.exit(3);
  }

  let seeded = false;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      abortCleanup(sig)
        .catch((e) => console.error(e))
        .finally(() => process.exit(code));
    });
  }
  try {
    await checkPrerequisites();
    await sweepTagged("plo-");
    const { rows: stale } = await monitor.query<{ n: string }>("select nspname as n from pg_namespace where nspname ~ '^plo_ctl_[0-9a-f]{6}$'");
    for (const { n } of stale) await monitor.query(`drop schema ${n} cascade`);
    console.log(`plan-order lockers proof - fixtures tagged ${TAG}`);
    await seed();
    seeded = true;

    await recomputeScenarios();
    await cascadeScenarios();
    await headerReleaseScenarios();

    if (process.argv.includes("--control")) await controlRounds();
  } finally {
    if (aborting) await sleep(60000); // the signal handler is cleaning up and will exit
    if (seeded || (await countTagged(TAG)) > 0) await teardown();
    else await closeActors();
    await probe.end().catch(() => undefined);
    await monitor.end();
  }

  const counted = results.filter((r) => !r.observed);
  const failed = counted.filter((r) => !r.ok);
  const observed = results.filter((r) => r.observed);
  if (observed.length) {
    console.log("\nOBSERVE-ONLY (not counted):");
    for (const o of observed) console.log(`  ${o.id}: ${o.detail}`);
  }
  console.log(`\n${counted.length - failed.length}/${counted.length} passed${failed.length ? ` - failed: ${failed.map((f) => f.id).join(", ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  if (aborting) {
    await sleep(60000); // the signal handler exits the process once its cleanup is done
  }
  console.error(e);
  process.exit(1);
});
