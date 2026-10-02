// Hand-run local CONCURRENCY proof for the `test_requests` writers that used to
// lock rows in PLAN (heap) order, or reach for the visit row AFTER a line, while
// release / undo (0198) and claim / unclaim (0211) lock visit -> lines in id order.
// Design: docs/superpowers/specs/2026-10-01-plan-order-lockers-audit.md.
//
//   recompute_clinic_fee_for_unreleased()  (0215)             scenarios R1-R7
//   delete_test_request_lines / restore_test_request_lines /
//   restore_panel_members (0216) + fn_queue_delete_cascade (0125)  scenarios Q1-Q10
//   fn_release_headers_on_visit_paid()     (0138)             scenarios P1-P3
//
// The global lock order every one of them now takes: the patient lifecycle lock
// (shared) -> the visit row -> the lines ORDER BY id -> the write. The assertions
// describe the CORRECT behaviour (no 40P01, no fee change on a line that has a
// posted journal entry, both sides finish); --control proves each guard matters by
// running the named scenarios against mutant copies (M1-M10) that must FAIL.
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
// THE APP STATEMENTS, mirrored:
//   recompute   service role   admin.rpc("recompute_clinic_fee_for_unreleased")
//   line delete service role   queue/bulk-delete-core.ts deleteTestRequestsForVisit
//                              -> rpc("delete_test_request_lines")
//   line restore service role  visits/queue-restore-core.ts -> rpc("restore_test_request_lines")
//   panel Undo  service role   panel-writes.ts restorePanelMembers -> rpc("restore_panel_members")
//   payment     authenticated  payments/new/actions.ts (the staff session client)
//   release/undo/claim/unclaim authenticated, one JWT `sub` per connection
//   merge       service role   admin/patient-merge/actions.ts -> rpc("merge_patients_guarded") (0196)
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
//   npm run plan-order-lockers:proof -- --control   # + the mutant control rounds
//   PLO_ONLY=R1,Q1 npm run plan-order-lockers:proof # just those scenarios
//   PLO_ONLY=none PLO_CTL=B0,M1 npm run plan-order-lockers:proof -- --control # just those control rounds
//
// The function under test is resolved through `fn.*` so a later control round can
// point a scenario at a mutant copy (recompute) or swap a trigger function in a
// scenario's own setup (cascade, header release) without touching the scenarios.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  lineSchema: "public", // delete_test_request_lines / restore_test_request_lines / restore_panel_members (0216)
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
  mergeSource: randomUUID(), // R7: a patient of its own, merged (and rolled back) into mergeKeep
  mergeKeep: randomUUID(),
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

// bulk-delete-core.ts deleteTestRequestsForVisit (admin client): rpc("delete_test_request_lines")
// (0216). A package header's components follow through fn_queue_delete_cascade. Returns how many
// lines the call itself deleted (the header; its components ride the cascade).
// concurrency-proof: delete_test_request_lines
// concurrency-proof: fn_queue_delete_cascade
function deleteLines(a: Actor, visit: string, ids: readonly string[]): Promise<Out<number>> {
  return settle(
    a.c.query(`select ${fn.lineSchema}.delete_test_request_lines($1::uuid, $2::uuid[], $3::uuid, $4, $5::timestamptz) as r`, [
      visit,
      ids,
      fx.admin1,
      `${TAG} concurrency proof`,
      new Date().toISOString(),
    ]),
    (r) => (r.rows[0].r as string[]).length,
  );
}

// queue-restore-core.ts restoreTestRequestsForVisit (admin client): rpc("restore_test_request_lines")
// (0216) - without `at` the manual Restore, with it a bulk Undo's exact-instant group.
// concurrency-proof: restore_test_request_lines
function restoreLines(a: Actor, visit: string, ids: readonly string[], at?: string): Promise<Out<number>> {
  return settle(
    a.c.query(`select ${fn.lineSchema}.restore_test_request_lines($1::uuid, $2::uuid[], $3::timestamptz) as r`, [
      visit,
      ids,
      at ?? null,
    ]),
    (r) => (r.rows[0].r as string[]).length,
  );
}

// panel-writes.ts restorePanelMembers (admin client): rpc("restore_panel_members") (0200, re-created by 0216).
// concurrency-proof: restore_panel_members
function restorePanel(a: Actor, visit: string, ids: readonly string[], at: string): Promise<Out<number>> {
  return settle(
    a.c.query(`select ${fn.lineSchema}.restore_panel_members($1::uuid, $2::uuid[], $3::timestamptz[]) as n`, [
      visit,
      ids,
      ids.map(() => at),
    ]),
    (r) => Number(r.rows[0].n),
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

// admin/patient-merge/actions.ts: admin.rpc("merge_patients_guarded") - service role (0196).
function merge(a: Actor, keep: string, source: string): Promise<Out<unknown>> {
  return settle(
    a.c.query("select public.merge_patients_guarded($1, $2, $3, $4::jsonb) as r", [keep, source, fx.admin1, JSON.stringify({ source: "admin" })]),
    (r) => r.rows[0].r as unknown,
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
  activity?: string; // pg_stat_activity state / wait event: shows a backend that finished or waits elsewhere
}
async function blockInfo(pid: number): Promise<BlockInfo> {
  const { rows } = await monitor.query<{ locktype: string; granted: boolean; page: number | null; tuple: number | null; xid: string | null }>(
    `select locktype, granted, page, tuple, transactionid::text as xid from pg_locks
      where pid = $1 and (locktype = 'tuple' or (locktype = 'transactionid' and not granted))`,
    [pid],
  );
  const t = rows.find((r) => r.locktype === "tuple");
  const x = rows.find((r) => r.locktype === "transactionid");
  const { rows: act } = await monitor.query<{ state: string | null; wet: string | null; we: string | null }>(
    "select state, wait_event_type as wet, wait_event as we from pg_stat_activity where pid = $1",
    [pid],
  );
  const activity = act[0] ? `${act[0].state ?? "?"}${act[0].wet ? ` waiting ${act[0].wet}/${act[0].we}` : ""}` : "gone";
  return { tuple: t ? `(${t.page},${t.tuple})` : null, tupleGranted: t?.granted ?? false, waitXid: x?.xid ?? null, activity };
}
const fmtBlock = (b: BlockInfo) =>
  `tuple ${b.tuple ?? "none"}${b.tuple ? (b.tupleGranted ? " granted" : " queued") : ""}, waits behind xid ${b.waitXid ?? "none"}${b.activity ? `, backend ${b.activity}` : ""}`;

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

// The backend must be seen waiting on the patient lifecycle advisory lock (0184)
// or on one of `rows` behind `behind`, within ~5s. Returns which one.
async function mustWaitPatientLockOr(
  a: Actor,
  rows: Row | Row[],
  behind: Actor,
  why: string,
): Promise<{ on: "patient lock" | string; text: string }> {
  const want = Array.isArray(rows) ? rows : [rows];
  const ctids = await Promise.all(want.map((r) => ctidIn(r.table, r.id)));
  const wantXid = await xidOf(behind);
  let last: BlockInfo = { tuple: null, tupleGranted: false, waitXid: null };
  for (let i = 0; i < 50; i++) {
    const { rows: adv } = await monitor.query(
      "select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted",
      [a.pid],
    );
    if (adv.length) return { on: "patient lock", text: `${a.name} waits on the patient lifecycle lock` };
    last = await blockInfo(a.pid);
    const hit = ctids.findIndex((c) => c === last.tuple);
    if (hit >= 0 && last.waitXid === wantXid) {
      return { on: want[hit].label, text: `${a.name} waits on ${want[hit].label} ${ctids[hit]} behind ${behind.name} (xid ${wantXid})` };
    }
    await sleep(100);
  }
  throw new Fail(
    `interleaving not reached: ${a.name} waited on neither the patient lock nor ${want.map((r, i) => `${r.label} ${ctids[i]}`).join(" or ")} (${why}); last seen: ${fmtBlock(last)}`,
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
  deletedAt: string | null; // `deleted`: the one instant every line was soft-deleted at
}

let visitSeq = 0;
const made = { tests: [] as string[], payments: [] as string[], visits: [] as string[], results: [] as string[] };

// A visit of `states.length` plain lab lines (100 each; with `fee`: clinic 40 +
// doctor PF 60 and the zero-clinic-cut physician attending, i.e. ELIGIBLE for
// recompute), paid by one payment unless paid=false. `physical: "desc"` stores the
// lines in DESCENDING id order, so heap order is the reverse of lock-by-id order.
async function mkVisit(spec: Parameters<typeof mkVisitOnce>[0]): Promise<Fix> {
  // Heap placement follows free space, so a "reversed" fixture can land in id order: rebuild (up to 8 times) until it is truly reversed.
  for (let i = 0; i < 8; i++) {
    const fix = await mkVisitOnce(spec);
    if (spec.physical !== "desc" || fix.ids.length < 2) return fix;
    if (await storedBefore(fix.ids[fix.ids.length - 1], fix.ids[fix.ids.length - 2])) return fix;
  }
  throw new Fail("fixture: could not store the lines in reverse heap order after 8 tries");
}

async function mkVisitOnce(spec: {
  states: St[];
  paid?: boolean;
  hmo?: boolean;
  physical?: "desc";
  fee?: boolean;
  holder?: string;
  patient?: string;
  report?: boolean; // link every line to one result (report-mates: release / undo lock them all)
  deleted?: boolean; // soft-delete every line at one instant (an unpaid visit only)
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
  let deletedAt: string | null = null;
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, attending_physician_id, hmo_provider_id)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', $4, 0, $5, $6)`,
      [visit, `V-${TAG_UP}-${seq}`, spec.patient ?? fx.patient, 100 * n, spec.fee ? fx.physician : null, spec.hmo ? fx.hmo : null],
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
    if (spec.report) {
      const result = randomUUID();
      made.results.push(result);
      await monitor.query("insert into public.results (id, uploaded_by) values ($1, $2)", [result, fx.med1]);
      for (const id of ids) {
        await monitor.query("insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)", [result, id]);
      }
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
    if (spec.deleted) {
      deletedAt = new Date().toISOString();
      await monitor.query(
        "update public.test_requests set deleted_at = $2, deleted_by = $3, delete_reason = 'plo fixture' where id = any($1::uuid[])",
        [ids, deletedAt, fx.admin1],
      );
    }
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, ids, payment, deletedAt };
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
async function mkPkg(spec: { comps: [St, St]; hmo?: boolean; deleted?: boolean; holder?: string; patient?: string }): Promise<PkgFix> {
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
      [visit, `V-${TAG_UP}-${seq}`, spec.patient ?? fx.patient, spec.hmo ? fx.hmo : null],
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
const ctlOnly: string[] | null = process.env.PLO_CTL ? process.env.PLO_CTL.split(",") : null; // --control: just these rounds
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

  // R6: ONE all-patients statement must not be aborted by a line it must not touch.
  // A waived visit's lines are frozen (0183 guard, P0070). Same class as 0184's inactive
  // patients: the scrub skips them, so every other doctor's line still gets scrubbed.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R6", "recompute with an eligible line on a WAIVED visit and one on a normal visit: succeeds, scrubs only the normal one", async () => {
    const w = await mkVisit({ states: ["requested"], paid: false, fee: true });
    const n = await mkVisit({ states: ["requested"], paid: false, fee: true });
    // Fixture surgery on this run's own visit only. Undone before the scenario ends: a
    // waived eligible line left behind would abort a later 0184-style recompute (control
    // round M1) at once with P0070, so its other scenarios would "catch" for that reason.
    const setStatus = async (status: string | null): Promise<string | null> => {
      await monitor.query("begin");
      try {
        await monitor.query("set local session_replication_role = replica");
        const { rows } = await monitor.query<{ s: string | null }>(
          "update public.visits v set payment_status = $2 from public.visits o where v.id = $1 and o.id = v.id returning o.payment_status as s",
          [w.visit, status],
        );
        await monitor.query("commit");
        return rows[0]?.s ?? null;
      } catch (e) {
        await monitor.query("rollback").catch(() => undefined);
        throw e;
      }
    };
    const before = await setStatus("waived");
    try {
      // Every other fixture line of this run that is still eligible is scrubbed too: count them.
      const { rows: el } = await monitor.query<{ n: number }>(
        `select count(*)::int as n
           from public.test_requests tr
           join public.visits v on v.id = tr.visit_id
           join public.patients pt on pt.id = v.patient_id
           left join public.physicians p on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
           left join public.physician_compensation pc on pc.physician_id = p.id
          where coalesce(pc.clinic_cut_php, case when pc.compensation_arrangement in ('rent_paying','shareholder') then 0 else 100 end) = 0
            and tr.clinic_fee_php > 0 and pt.deleted_at is null and pt.merged_into_id is null
            and v.payment_status is distinct from 'waived'
            and not exists (select 1 from public.journal_entries je where je.source_kind = 'test_request' and je.source_id = tr.id and je.status = 'posted')`,
      );
      const rec = await actor("recompute", null);
      await begin(rec, PHYSICAL_PLAN);
      const out = await recompute(rec);
      let seen: Array<{ id: string; clinic: string; pf: string }> = [];
      if (out.ok) {
        const r = await rec.c.query<{ id: string; clinic: string; pf: string }>(
          "select id, clinic_fee_php as clinic, doctor_pf_php as pf from public.test_requests where id = any($1::uuid[])",
          [[w.ids[0], n.ids[0]]],
        );
        seen = r.rows;
      }
      await rec.c.query("rollback").catch(() => undefined);
      if (!out.ok) throw new Fail(`recompute aborted (${out.code}): ${out.message.split("\n")[0]} - one waived line stops the whole scrub`);
      const byId = new Map(seen.map((x) => [x.id, x]));
      const wl = byId.get(w.ids[0]);
      const nl = byId.get(n.ids[0]);
      if (!wl || !nl) throw new Fail("could not read the lines from inside the recompute transaction");
      if (Number(nl.clinic) !== 0 || Number(nl.pf) !== 100) throw new Fail(`the normal line was not scrubbed: clinic ${nl.clinic}, pf ${nl.pf}`);
      if (Number(wl.clinic) !== FEE.clinic || Number(wl.pf) !== FEE.pf) throw new Fail(`the waived line was changed: clinic ${wl.clinic}, pf ${wl.pf}`);
      if (out.v.rows_affected !== el[0].n) throw new Fail(`rows_affected ${out.v.rows_affected}, expected ${el[0].n} (every eligible non-waived line)`);
      return `waived line untouched, normal line scrubbed, rows_affected ${out.v.rows_affected} = ${el[0].n} eligible non-waived lines`;
    } finally {
      await setStatus(before);
    }
  });

  // R7: recompute vs a patient MERGE (0196). Merge takes the patient lifecycle lock
  // EXCLUSIVE and then UPDATEs the source's visits. A recompute that holds a visit and
  // only then asks for the SHARED patient lock (its UPDATE fires a_lifecycle_guard)
  // closes a cycle. W holds the line A, so recompute (holding V) is queued on A; the
  // merge starts: with the fix it queues on the patient lock recompute took first
  // (b0); without it, it takes the patient lock and queues on V. When W lets go,
  // recompute's UPDATE wants the shared patient lock -> 40P01. Both sides roll back:
  // nothing is merged.
  // concurrency-proof: recompute_clinic_fee_for_unreleased
  await scenario("R7", "recompute vs a merge of the line's patient (W holds the line): must not deadlock", async () => {
    const f = await mkVisit({ states: ["requested"], paid: false, fee: true, patient: fx.mergeSource });
    const A: Row = { table: "test_requests", id: f.ids[0], label: "A" };
    const V: Row = { table: "visits", id: f.visit, label: "V" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.test_requests where id = $1 for update", [f.ids[0]]);
    const rec = await actor("recompute", null);
    await begin(rec);
    const prec = andRollback(rec, recompute(rec));
    const w1 = await mustBlockOn(rec, A, g, "recompute pre-locks V and queues on A behind W");
    const heldV = await rowLocked("visits", f.visit);
    const mg = await actor("merge", null);
    await begin(mg);
    const pmg = andRollback(mg, merge(mg, fx.mergeKeep, fx.mergeSource));
    let w2 = "merge answered at once (recompute holds neither V nor the patient lock)";
    if (heldV) {
      // The recompute pre-locks EVERY eligible visit, so earlier scenarios' committed fixture
      // visits of the merge source are held too: the merge can queue on any of them first.
      const { rows: sv } = await monitor.query<{ id: string }>("select id from public.visits where patient_id = $1 and id <> $2", [fx.mergeSource, f.visit]);
      const others: Row[] = sv.map((r, i) => ({ table: "visits", id: r.id, label: `V${i + 2}` }));
      w2 = (await mustWaitPatientLockOr(mg, [V, ...others], rec, "merge needs the patient lock exclusive, then the source's visits")).text;
    } else {
      const early = await mustNotWait(mg, pmg.then((x) => x.out), "recompute holds no visit while queued on A");
      if (!early.ok) throw new Fail(`merge failed: ${fmtOut(early)}`);
    }
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([rec, mg], [A, V]);
    })();
    const [rr, rm] = await raceResult(["recompute", "merge"], prec.then((x) => x.out), pmg.then((x) => x.out));
    const victim = deadlockVictim(["recompute", "merge"], rr, rm);
    if (victim) {
      throw new Fail(
        `40P01 deadlock (victim: ${victim}): recompute held V and wanted the shared patient lock, merge held it exclusive and wanted a visit recompute held. ` +
          `${w1.text}; ${w2}; after W commits: ${cycle}`,
      );
    }
    if (!rr.ok) throw new Fail(`recompute failed: ${fmtOut(rr)}`);
    if (!rm.ok) throw new Fail(`merge failed: ${fmtOut(rm)}`);
    return `no deadlock - ${w1.text}; ${w2}`;
  });
}

// ---------------------------------------------------------------------------
// Q - line delete / restore (0216) and the package-header cascade (0125)
// ---------------------------------------------------------------------------
//
// Since 0216 every line delete / restore is one of three functions that lock in
// the global order - patient lifecycle lock (shared) -> visit FOR UPDATE -> the
// lines (+ a header's components) ORDER BY id - before the write. The scenarios
// below were the cycles of the old bare UPDATEs (they fail on mutant M7, the
// pre-0216 bodies) plus the ones a missing piece of the new order would open
// (M8-M10).

// A backend that must either answer by itself or be seen waiting on one of `rows`
// behind `behind` - which one depends on the body under test; the caller asserts the outcome.
async function answersOrWaitsOn<T>(
  a: Actor,
  p: Promise<Out<T>>,
  rows: Row | Row[],
  behind: Actor,
  why: string,
): Promise<{ answered: boolean; text: string }> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  const want = Array.isArray(rows) ? rows : [rows];
  const ctids = await Promise.all(want.map((r) => ctidIn(r.table, r.id)));
  let last: BlockInfo = { tuple: null, tupleGranted: false, waitXid: null };
  for (let i = 0; i < 50; i++) {
    if (done) return { answered: true, text: `${a.name} answered at once` };
    last = await blockInfo(a.pid);
    // `behind` may hold no xid at all (it locked nothing yet) - read it only on a hit.
    const { rows: bx } = await monitor.query<{ x: string | null }>("select backend_xid::text as x from pg_stat_activity where pid = $1", [behind.pid]);
    const wantXid = bx[0]?.x ?? null;
    const hit = ctids.findIndex((c) => c === last.tuple);
    if (hit >= 0 && wantXid && last.waitXid === wantXid) {
      return { answered: false, text: `${a.name} waits on ${want[hit].label} ${ctids[hit]} behind ${behind.name} (xid ${wantXid})` };
    }
    await sleep(100);
  }
  throw new Fail(
    `interleaving not reached: ${a.name} neither answered nor waited on ${want.map((r, i) => `${r.label} ${ctids[i]}`).join(" or ")} behind ${behind.name} (${why}); last seen: ${fmtBlock(last)}`,
  );
}

// The lock-order race shared by Q1 / Q2: components x1 < x2, x2 stored BEFORE x1.
// W holds x1. The claim / unclaim (id-ordered pre-lock) queues on x1 holding
// nothing. The header delete takes the visit, then (0216) the lines by id: x1
// first, so it queues on x1 behind the claim holding no line. The pre-0216 bare
// UPDATE locked H and its cascade then took the components in plan order: x2
// first, then x1 behind the claim - which then wanted x2: a cycle.
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
  const w2 = await mustBlockOn(d, X1, null, `the header delete reaches x1 (pre-lock or cascade) and queues behind the ${writer}`);
  const heldX2 = await rowLocked("test_requests", p.x2);
  await g.c.query("commit");
  const cycle = await (async () => {
    await sleep(300);
    return describeWaits([w, d], [H, X1, X2]);
  })();
  const [rw, rd] = await raceResult([writer, "delete"], pw, pd);
  const order = heldX2 ? "plan order: held x2 before queueing on x1" : "id order: held no line while queued on x1";
  const victim = deadlockVictim([writer, "delete"], rw, rd);
  if (victim) {
    throw new Fail(
      `40P01 deadlock (victim: ${victim}): header delete (${order}) vs ${writer} (id order). ` +
        `${w1.text}; ${w2.text}; after W commits: ${cycle}`,
    );
  }
  if (!rw.ok) throw new Fail(`${writer} failed: ${fmtOut(rw)}`);
  if (!rd.ok) throw new Fail(`delete failed: ${fmtOut(rd)}`);
  if (rw.v !== 2) throw new Fail(`${writer}: expected 2 rows, got ${rw.v}`);
  if (rd.v !== 1) throw new Fail(`delete: expected the header (1 line) back, got ${rd.v}`);
  for (const id of [p.header, p.x1, p.x2]) {
    if (!(await lineOf(id)).deleted_at) throw new Fail("after both: the header and its components should all be deleted");
  }
  return `no deadlock - delete ${order}; ${w1.text}; ${w2.text}`;
}

// Q7 / Q9 / Q10: a delete / restore / panel restore vs a MERGE of the visit's
// patient. merge_patients_guarded (0196) takes the patient lock EXCLUSIVE, then
// UPDATEs the visits. W holds the lowest line, so the writer (patient lock, visit)
// is queued on it; the merge must queue on the patient lock the writer took
// FIRST. A writer that holds the visit without the patient lock (0200's
// restore_panel_members; mutant M10) only asks for it later, when its UPDATE
// fires a_lifecycle_guard - behind the merge, which waits for the visit: 40P01.
async function mergeRace(kind: "delete" | "restore" | "panel"): Promise<string> {
  const f = await mkVisit({ states: ["requested", "requested"], paid: false, patient: fx.mergeSource, deleted: kind !== "delete" });
  const [lo, hi] = f.ids;
  const LO: Row = { table: "test_requests", id: lo, label: "lo" };
  const V: Row = { table: "visits", id: f.visit, label: "V" };
  const g = await actor("W", null);
  await beginRaw(g);
  await g.c.query("select 1 from public.test_requests where id = $1 for update", [lo]);
  const op = await actor(kind, null);
  await begin(op);
  const pop = andEnd(
    op,
    kind === "delete"
      ? deleteLines(op, f.visit, [lo, hi])
      : kind === "restore"
        ? restoreLines(op, f.visit, [lo, hi])
        : restorePanel(op, f.visit, [lo, hi], f.deletedAt!),
  );
  const w1 = await mustBlockOn(op, LO, g, `the ${kind} takes the visit, then the lines by id: queues on lo behind W`);
  const heldV = await rowLocked("visits", f.visit);
  if (!heldV) throw new Fail(`the ${kind} should hold the visit while it is queued on lo`);
  const mg = await actor("merge", null);
  await begin(mg);
  const pmg = andRollback(mg, merge(mg, fx.mergeKeep, fx.mergeSource));
  const w2 = await mustWaitPatientLockOr(mg, V, op, "merge needs the patient lock exclusive, then the visit");
  await g.c.query("commit");
  const cycle = await (async () => {
    await sleep(300);
    return describeWaits([op, mg], [LO, V]);
  })();
  const [ro, rm] = await raceResult([kind, "merge"], pop, pmg.then((x) => x.out));
  const victim = deadlockVictim([kind, "merge"], ro, rm);
  if (victim) {
    throw new Fail(
      `40P01 deadlock (victim: ${victim}): the ${kind} held the visit and wanted the shared patient lock, the merge held it exclusive and wanted the visit. ` +
        `${w1.text}; ${w2.text}; after W commits: ${cycle}`,
    );
  }
  if (!ro.ok) throw new Fail(`${kind} failed: ${fmtOut(ro)}`);
  if (!rm.ok) throw new Fail(`merge failed: ${fmtOut(rm)}`);
  if (ro.v !== 2) throw new Fail(`${kind}: expected 2 lines, got ${ro.v}`);
  for (const id of [lo, hi]) {
    const gone = (await lineOf(id)).deleted_at !== null;
    if (gone !== (kind === "delete")) throw new Fail(`after the ${kind}: line ${id} should be ${kind === "delete" ? "deleted" : "live"}`);
  }
  return `no deadlock - ${w1.text}; ${w2.text}`;
}

async function cascadeScenarios(): Promise<void> {
  // concurrency-proof: delete_test_request_lines
  // concurrency-proof: fn_queue_delete_cascade
  await scenario("Q1", "header delete vs claim of its components, heap order reversed: must not deadlock", () => cascadeRace("claim"));
  // concurrency-proof: delete_test_request_lines
  // concurrency-proof: fn_queue_delete_cascade
  await scenario("Q2", "header delete vs unclaim of its components, heap order reversed: must not deadlock", () => cascadeRace("unclaim"));

  // Q3: header delete vs RELEASE of a component on an HMO visit. Release (0198)
  // takes the visit FOR SHARE, then x1 and H by id; W holds x1, so release is
  // queued on x1 holding the visit. The delete now asks for the visit FOR UPDATE
  // first and queues behind the release holding no line. The pre-0216 UPDATE
  // locked H first and its cascade then wanted x1: the cycle once filed as
  // "accepted" (no pre-lock inside the trigger can help - H is locked before it runs).
  // When W lets go the release finishes and the delete then meets a released
  // component: the 0125 guard refuses it whole (P0043), nothing half-done.
  // concurrency-proof: delete_test_request_lines
  // concurrency-proof: fn_queue_delete_cascade
  await scenario("Q3", "header delete vs release of component x1 (HMO visit): must not deadlock; the delete is refused whole", async () => {
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
    const pd = andEnd(d, deleteLines(d, p.visit, [p.header]));
    const w2 = await mustBlockOn(d, [V, X1], null, "the delete waits on the visit (0216) or, holding H, on x1 (pre-0216)");
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([m, d], [H, X1, X2, V]);
    })();
    const [rm, rd] = await raceResult(["release", "delete"], pm, pd);
    const victim = deadlockVictim(["release", "delete"], rm, rd);
    if (victim) {
      throw new Fail(`40P01 deadlock (victim: ${victim}): ${w1.text}; ${w2.text}; after W commits: ${cycle}`);
    }
    const rel = expectOk("release", rm);
    if (!rel.released.some((r) => r.id === p.x1)) throw new Fail(`release: x1 should be released, got ${JSON.stringify(rel)}`);
    if (rd.ok) throw new Fail("delete: a header whose component was just released must be refused, but it succeeded");
    if (!/^P00(4[2-4]|50)$/.test(rd.code)) throw new Fail(`delete: expected a 0125 guard refusal, got ${fmtOut(rd)}`);
    for (const id of [p.header, p.x1, p.x2]) {
      if ((await lineOf(id)).deleted_at) throw new Fail("after the refused delete: nothing may be deleted");
    }
    return `no deadlock - release first, delete refused whole (${rd.code}); ${w1.text}; ${w2.text}`;
  });

  // Q4: header restore vs claim. claim / unclaim require deleted_at is null, so
  // deleted components are never in their lock set: they must not wait on each other.
  // concurrency-proof: restore_test_request_lines
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

  // Q5: the bulk line delete of two PLAIN lines stored in reverse heap order vs a
  // claim of the same two lines. Same shape as Q1, without the cascade.
  // concurrency-proof: delete_test_request_lines
  await scenario("Q5", "bulk delete of two plain lines (reverse heap order) vs claim of the same two lines: must not deadlock", async () => {
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
    const order = heldHi ? "held the higher line before queueing (plan order)" : "held no line while queued (id order)";
    const victim = deadlockVictim(["claim", "bulk-delete"], rw, rd);
    if (victim) throw new Fail(`40P01 deadlock (victim: ${victim}): delete ${order}. ${w1.text}; ${w2.text}; after W commits: ${cycle}`);
    if (!rw.ok) throw new Fail(`claim failed: ${fmtOut(rw)}`);
    if (!rd.ok) throw new Fail(`delete failed: ${fmtOut(rd)}`);
    if (rw.v !== 2 || rd.v !== 2) throw new Fail(`expected 2 claimed and 2 deleted, got ${rw.v} / ${rd.v}`);
    return `no deadlock - delete ${order}; ${w1.text}; ${w2.text}`;
  });

  // Q6: restore of a deleted package header vs a release from a stale screen of its
  // component x1 (HMO visit). Release locks the visit FOR SHARE, then x1 and its
  // parent H by id, whatever their deleted state (then refuses x1). W holds the
  // visit FOR SHARE. The restore now waits for the visit FOR UPDATE holding no
  // line, so the release (FOR SHARE is compatible with W's) runs through. The
  // pre-0216 UPDATE locked H, then 0183's waived guard wanted the visit FOR UPDATE
  // behind W; the release then queued on H holding the visit: 40P01 once W let go.
  // concurrency-proof: restore_test_request_lines
  await scenario("Q6", "restore of a deleted header vs release of its component (W holds the visit FOR SHARE): must not deadlock", async () => {
    const p = await mkPkg({ comps: ["ready", "requested"], hmo: true, deleted: true });
    const X1: Row = { table: "test_requests", id: p.x1, label: "X1" };
    const H: Row = { table: "test_requests", id: p.header, label: "H" };
    const V: Row = { table: "visits", id: p.visit, label: "V" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.visits where id = $1 for share", [p.visit]);
    const r = await actor("restore", null);
    await begin(r);
    const pr = andEnd(r, restoreLines(r, p.visit, [p.header]));
    const w1 = await mustBlockOn(r, V, g, "the restore wants the visit FOR UPDATE (0216 pre-lock, or 0183's guard pre-0216) behind W");
    const heldH = await rowLocked("test_requests", p.header);
    const m = await actor("release", fx.med1);
    await begin(m);
    const pm = andEnd(m, release(m, p.visit, [p.x1]));
    // Pre-0216 the restore held only H (its UPDATE); a restore that pre-locks the lines
    // but not the visit (M8) holds x1 too, so the release can queue on either.
    const w2 = await answersOrWaitsOn(m, pm, [X1, H], r, "release shares the visit with W, then locks x1 and H by id");
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([r, m], [X1, H, V]);
    })();
    const [rr, rm] = await raceResult(["restore", "release"], pr, pm);
    const victim = deadlockVictim(["restore", "release"], rr, rm);
    if (victim) {
      throw new Fail(
        `40P01 deadlock (victim: ${victim}): restore ${heldH ? "held H" : "held no line"} and wanted the visit FOR UPDATE, release held it FOR SHARE and wanted a line the restore held. ` +
          `${w1.text}; ${w2.text}; after W commits: ${cycle}`,
      );
    }
    if (!rr.ok) throw new Fail(`restore failed: ${fmtOut(rr)}`);
    if (rr.v !== 1) throw new Fail(`restore: expected the header (1 line), got ${rr.v}`);
    if (rm.ok && rm.v.released.length > 0) throw new Fail(`release: nothing deleted may be released, got ${JSON.stringify(rm.v)}`);
    for (const id of [p.header, p.x1, p.x2]) {
      if ((await lineOf(id)).deleted_at) throw new Fail("after the restore: the header and its components should be live");
    }
    return `no deadlock - restore ${heldH ? "held H" : "held no line"} while waiting on the visit; release ${rm.ok ? "answered" : fmtOut(rm)}; ${w1.text}; ${w2.text}`;
  });

  // Q7 / Q9 / Q10: vs a merge of the patient (see mergeRace).
  // concurrency-proof: restore_panel_members
  await scenario("Q7", "panel Undo of a bulk delete (restore_panel_members) vs a merge of the patient (W holds a member): must not deadlock", () =>
    mergeRace("panel"),
  );

  // Q8: delete of a line vs undo of a released report-mate (HMO visit). Undo (0198)
  // takes the visit FOR SHARE, then every member of the report by id - the line
  // being deleted too. W holds the visit FOR SHARE. The delete now waits for the
  // visit FOR UPDATE holding no line, and the undo runs through. The pre-0216
  // UPDATE locked the line, then its cascade wanted the visit (total_php) behind
  // W; the undo then queued on that line holding the visit: 40P01 once W let go.
  // concurrency-proof: delete_test_request_lines
  await scenario("Q8", "delete of a line vs undo of a released report-mate (W holds the visit FOR SHARE): must not deadlock", async () => {
    const f = await mkVisit({ states: ["ready", "released"], paid: false, hmo: true, report: true });
    const [l, s] = f.ids; // l: ready (to delete), s: released (to undo)
    const L: Row = { table: "test_requests", id: l, label: "L" };
    const V: Row = { table: "visits", id: f.visit, label: "V" };
    const g = await actor("W", null);
    await beginRaw(g);
    await g.c.query("select 1 from public.visits where id = $1 for share", [f.visit]);
    const d = await actor("delete", null);
    await begin(d);
    const pd = andEnd(d, deleteLines(d, f.visit, [l]));
    const w1 = await mustBlockOn(d, V, g, "the delete wants the visit (0216 pre-lock FOR UPDATE, or its cascade's total_php UPDATE pre-0216) behind W");
    const heldL = await rowLocked("test_requests", l);
    const u = await actor("undo", fx.med1);
    await begin(u);
    const pu = andEnd(u, undo(u, f.visit, [s]));
    const w2 = await answersOrWaitsOn(u, pu, L, d, "undo shares the visit with W, then locks the report's members by id");
    await g.c.query("commit");
    const cycle = await (async () => {
      await sleep(300);
      return describeWaits([d, u], [L, V]);
    })();
    const [rd, ru] = await raceResult(["delete", "undo"], pd, pu);
    const victim = deadlockVictim(["delete", "undo"], rd, ru);
    if (victim) {
      throw new Fail(
        `40P01 deadlock (victim: ${victim}): delete ${heldL ? "held L" : "held no line"} and wanted the visit, undo held it FOR SHARE and wanted L. ` +
          `${w1.text}; ${w2.text}; after W commits: ${cycle}`,
      );
    }
    const un = expectOk("undo", ru);
    if (!un.undone.some((x) => x.id === s)) throw new Fail(`undo: the released mate should be undone, got ${JSON.stringify(un)}`);
    if (!rd.ok) throw new Fail(`delete failed: ${fmtOut(rd)}`);
    if (!(await lineOf(l)).deleted_at) throw new Fail("after the delete: L should be deleted");
    if ((await lineOf(s)).status === "released") throw new Fail("after the undo: the mate should not be released");
    return `no deadlock - delete ${heldL ? "held L" : "held no line"} while waiting on the visit; ${w1.text}; ${w2.text}`;
  });

  // concurrency-proof: delete_test_request_lines
  await scenario("Q9", "bulk delete vs a merge of the patient (W holds a line): must not deadlock", () => mergeRace("delete"));
  // concurrency-proof: restore_test_request_lines
  await scenario("Q10", "manual restore vs a merge of the patient (W holds a line): must not deadlock", () => mergeRace("restore"));
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
// Each round installs copies of the LIVE recompute function and the three 0216
// line functions in a throwaway schema (plo_ctl_<hex>, never public - the stack is
// shared), with ONE guard removed from the mutant's target; the named scenarios
// run against the copies through fn.recomputeSchema / fn.lineSchema and the round
// passes only if every one of them FAILS ("caught"). B0 is the unmutated set and
// must pass them all, so a broken copy cannot make every mutant look caught.
//   M1  the pre-0215 (0184) body: no visit/line pre-lock, one UPDATE over a CTE
//   M2  no visit pre-lock (b): lines are locked first, the 0183 guard then takes the visit
//   M3  no line pre-lock (c): the UPDATE locks the lines in plan order
//   M4  no predicate re-check in (d): updates every line collected in (a)
//   M5  no waived-visit filter (a, d): one waived line aborts the whole scrub (P0070)
//   M6  no patient lifecycle lock first (b0): a merge closes a cycle (R7)
//   M7  the pre-0216 line writes: bare UPDATEs for delete / restore and 0200's
//       restore_panel_members (visit FOR NO KEY UPDATE, no patient lock)
//   M8  no visit pre-lock in the three line functions (lines first, the visit later)
//   M9  no line pre-lock in delete_test_request_lines (the UPDATE + cascade lock in plan order)
//   M10 no patient lifecycle lock first in the three line functions (a merge closes a cycle)
// NOT separately provable: restore_test_request_lines' / restore_panel_members' line
// pre-lock. Every writer that can lock a DELETED line takes the visit first (release /
// undo FOR SHARE, recompute FOR UPDATE) and claim / unclaim skip deleted lines (Q4),
// so with the visit held the restore's line order cannot meet another line locker.
// NOT covered: the guards that live in triggers on public tables
// (guard_test_request_on_waived_visit) - a trigger on a public table fires for
// every session, so a mutant of it cannot be isolated.

const CTL_SCHEMA = `plo_ctl_${TAG.slice(4)}`;

// The pre-0215 body (0184), verbatim from pg_get_functiondef before 0215 was applied.
const PRE_FIX_BODY = "CREATE OR REPLACE FUNCTION public.recompute_clinic_fee_for_unreleased()\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public', 'pg_temp'\nAS $function$\ndeclare\n  v_affected int;\nbegin\n  with target_ids as (\n    select tr.id\n    from public.test_requests tr\n    join public.visits v on v.id = tr.visit_id\n    join public.patients pt on pt.id = v.patient_id   -- 0184: only an active patient's line\n    left join public.physicians p\n      on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)\n    left join public.physician_compensation pc on pc.physician_id = p.id\n    where coalesce(\n            pc.clinic_cut_php,\n            case when pc.compensation_arrangement in ('rent_paying', 'shareholder') then 0 else 100 end\n          ) = 0\n      and tr.clinic_fee_php > 0\n      and pt.deleted_at is null and pt.merged_into_id is null   -- 0184\n      and not exists (\n        select 1 from public.journal_entries je\n        where je.source_kind = 'test_request'\n          and je.source_id = tr.id\n          and je.status = 'posted'\n      )\n  ),\n  updated as (\n    update public.test_requests tr2\n      set clinic_fee_php = 0,\n          doctor_pf_php = tr2.final_price_php\n      where tr2.id in (select id from target_ids)\n      returning tr2.id\n  )\n  select count(*) into v_affected from updated;\n\n  return jsonb_build_object('rows_affected', v_affected);\nend;\n$function$";

// The functions a control round copies: the recompute and the three 0216 line writers.
const COPIES = {
  recompute: "recompute_clinic_fee_for_unreleased()",
  delete: "delete_test_request_lines(uuid,uuid[],uuid,text,timestamptz)",
  restore: "restore_test_request_lines(uuid,uuid[],timestamptz)",
  panel: "restore_panel_members(uuid,uuid[],timestamptz[])",
} as const;
type Copy = keyof typeof COPIES;

// The pre-0216 line writes, as the app issued them (bare UPDATEs, now in a function
// of the same signature so the scenarios call them the same way).
const PRE_0216_DELETE = `CREATE OR REPLACE FUNCTION public.delete_test_request_lines(p_visit_id uuid, p_test_request_ids uuid[], p_actor uuid, p_reason text, p_deleted_at timestamptz)
 RETURNS uuid[] LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  with d as (
    update public.test_requests set deleted_at = p_deleted_at, deleted_by = p_actor, delete_reason = p_reason
     where id = any (p_test_request_ids) and visit_id = p_visit_id and deleted_at is null
    returning id)
  select coalesce(array_agg(id order by id), '{}'::uuid[]) from d;
$function$`;
const PRE_0216_RESTORE = `CREATE OR REPLACE FUNCTION public.restore_test_request_lines(p_visit_id uuid, p_test_request_ids uuid[], p_deleted_at timestamptz DEFAULT NULL)
 RETURNS uuid[] LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  with r as (
    update public.test_requests set deleted_at = null, deleted_by = null, delete_reason = null
     where id = any (p_test_request_ids) and visit_id = p_visit_id
       and ((p_deleted_at is null and deleted_at is not null) or deleted_at = p_deleted_at)
    returning id)
  select coalesce(array_agg(id order by id), '{}'::uuid[]) from r;
$function$`;
// 0200's restore_panel_members, verbatim from its migration.
function pre0216Panel(): string {
  const src = readFileSync(join(process.cwd(), "supabase/migrations/0200_panel_undo_all_or_nothing.sql"), "utf8");
  const start = src.indexOf("create or replace function public.restore_panel_members(");
  const end = src.indexOf("$$;", start);
  if (start < 0 || end < 0) throw new Error("0200's restore_panel_members not found");
  return src.slice(start, end + 3);
}

interface Mutant {
  key: string;
  what: string;
  // [copy, from, to] replacements applied in order to the LIVE definitions; each must match.
  edits: Array<[Copy, string, string]>;
  replace?: Partial<Record<Copy, string>>; // whole pre-fix definitions instead of the live ones
  mustFail: string[];
}

const MUTANTS: Mutant[] = [
  {
    key: "M1",
    what: "the pre-0215 body (one UPDATE over a CTE, no pre-lock)",
    edits: [],
    replace: { recompute: PRE_FIX_BODY },
    mustFail: ["R1", "R2a", "R3-claim", "R3-unclaim", "R4", "R5", "R6", "P3"],
  },
  {
    key: "M2",
    what: "no visit pre-lock (b)",
    edits: [["recompute", "  perform 1 from public.visits\n   where id = any (v_visits)\n   order by id\n     for update;", ""]],
    mustFail: ["R1", "R4", "R5", "P3"],
  },
  {
    key: "M3",
    what: "no line pre-lock (c) - lines locked by the UPDATE, plan order",
    edits: [["recompute", "  perform 1 from public.test_requests\n   where id = any (v_lines)\n   order by id\n     for no key update;", ""]],
    mustFail: ["R3-claim", "R3-unclaim"],
  },
  {
    key: "M4",
    what: "no eligibility re-check in (d) - updates every line collected in (a)",
    edits: [
      ["recompute", "     where tr2.id = any (v_lines)\n       and tr2.id in (", "     where tr2.id = any (v_lines)\n       and (true or tr2.id in ("],
      ["recompute", "            )\n       )\n    returning tr2.id", "            )\n       ))\n    returning tr2.id"],
    ],
    mustFail: ["R2a"],
  },
  {
    key: "M5",
    what: "no waived-visit filter (0184-style) in (a) and (d)",
    edits: [
      ["recompute", "        and v.payment_status is distinct from 'waived'   -- 0215\n", ""],
      ["recompute", "            and v.payment_status is distinct from 'waived'   -- 0215\n", ""],
    ],
    mustFail: ["R6"],
  },
  {
    key: "M6",
    what: "no patient lifecycle lock first (b0) - the UPDATE asks for it while holding the visit",
    edits: [["recompute", "  perform public.lifecycle_lock(v_patients, false);\n", ""]],
    mustFail: ["R7"],
  },
  {
    key: "M7",
    what: "the pre-0216 line writes (bare UPDATEs; 0200's restore_panel_members)",
    edits: [],
    replace: { delete: PRE_0216_DELETE, restore: PRE_0216_RESTORE, panel: pre0216Panel() },
    mustFail: ["Q1", "Q2", "Q3", "Q5", "Q6", "Q7", "Q8"],
  },
  {
    key: "M8",
    what: "no visit pre-lock in the line functions - lines first, the visit later",
    edits: (["delete", "restore", "panel"] as const).map((c) => [
      c,
      "from public.visits v where v.id = p_visit_id for update;",
      "from public.visits v where v.id = p_visit_id;",
    ]),
    mustFail: ["Q6", "Q8"],
  },
  {
    key: "M9",
    what: "no line pre-lock in delete_test_request_lines - the UPDATE and its cascade lock in plan order",
    edits: [["delete", "   order by t.id\n     for update;\n\n  -- 3.", "   ;\n\n  -- 3."]],
    mustFail: ["Q1", "Q2", "Q5"],
  },
  {
    key: "M10",
    what: "no patient lifecycle lock first in the line functions - the UPDATE asks for it holding the visit",
    edits: (["delete", "restore", "panel"] as const).map((c) => [c, "  perform public.lifecycle_lock_and_assert(array[v_patient], false);\n", ""]),
    mustFail: ["Q7", "Q9", "Q10"],
  },
];

async function installCopies(m: Mutant | null): Promise<void> {
  await monitor.query(`drop schema if exists ${CTL_SCHEMA} cascade`);
  await monitor.query(`create schema ${CTL_SCHEMA}`);
  await monitor.query(`grant usage on schema ${CTL_SCHEMA} to service_role`);
  for (const [copy, sig] of Object.entries(COPIES) as Array<[Copy, string]>) {
    let def = m?.replace?.[copy];
    if (def === undefined) {
      const { rows } = await monitor.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [`public.${sig}`]);
      def = rows[0].d;
    }
    for (const [target, from, to] of m?.edits ?? []) {
      if (target !== copy) continue;
      if (!def.includes(from)) throw new Error(`mutant ${m?.key}: text to replace not found in the live ${copy} body`);
      def = def.replace(from, to);
    }
    const name = sig.slice(0, sig.indexOf("("));
    if (!def.includes(`public.${name}(`)) throw new Error(`${copy}: definition header not found`);
    def = def.replace(`public.${name}(`, `${CTL_SCHEMA}.${name}(`);
    await monitor.query(def);
    await monitor.query(`grant execute on function ${CTL_SCHEMA}.${sig} to service_role`);
  }
}

const CONTROL_SCENARIOS = [
  "R1", "R2a", "R3-claim", "R3-unclaim", "R4", "R5", "R6", "R7", "P3",
  "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10",
];

async function controlRounds(): Promise<void> {
  console.log("\ncontrol rounds (a mutant must make its scenarios FAIL):");
  const savedOnly = only;
  const rounds: Array<{ key: string; what: string; m: Mutant | null; list: string[]; wantPass: boolean }> = [
    { key: "B0", what: "unmutated copy of the live body", m: null, list: CONTROL_SCENARIOS, wantPass: true },
    ...MUTANTS.map((m) => ({ key: m.key, what: m.what, m, list: m.mustFail, wantPass: false })),
  ].filter((r) => !ctlOnly || ctlOnly.includes(r.key));
  for (const r of rounds) {
    await installCopies(r.m);
    fn.recomputeSchema = CTL_SCHEMA;
    fn.lineSchema = CTL_SCHEMA;
    only = r.list;
    const mine: Result[] = [];
    sink = mine;
    quiet = true;
    try {
      await recomputeScenarios();
      await cascadeScenarios();
      await headerReleaseScenarios();
    } finally {
      sink = results;
      quiet = false;
      fn.recomputeSchema = "public";
      fn.lineSchema = "public";
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
    // Why each scenario caught the mutant (a 40P01, a lost update...), so a copy that is merely broken shows.
    if (!r.wantPass) {
      for (const id of caught) {
        const d = got.get(id)!.detail;
        const seen = d.indexOf("; last seen: ");
        console.log(`        ${id}: ${d.slice(0, 150)}${seen >= 0 && d.length > 150 ? ` ... ${d.slice(seen + 2)}` : ""}`);
      }
    }
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
    `select (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'claim_panel_members') ~* 'order by t0\\.id'
        and (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'unclaim_panel_members') ~* 'order by t0\\.id' as ok`,
  );
  const { rows } = await monitor.query<{ src: string; cascade: string; hdr: string }>(
    `select (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'recompute_clinic_fee_for_unreleased') as src,
            (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fn_queue_delete_cascade') as cascade,
            (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fn_release_headers_on_visit_paid') as hdr`,
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
          + (select count(*) from public.release_notices where visit_id = any($9::uuid[]))
          + (select count(*) from public.results where id = any($10::uuid[])) as n`,
    [`${like}%@example.test`, `${like}%`, `${up}%`, `DRM-${up}%`, `V-${up}%`, made.tests, made.payments, `${like}%`, made.visits, made.results],
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
    for (const [id, k] of [[fx.mergeSource, "S"], [fx.mergeKeep, "K"]] as const) {
      await monitor.query(
        `insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex) values ($1, $2, $3, 'Fixture', '1990-01-01', 'female')`,
        [id, `DRM-${TAG_UP}-${k}`, `Plo${k}`],
      );
    }
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
    // A crashed run can leave its control schema behind; sweep it first.
    const { rows: stale } = await monitor.query<{ n: string }>("select nspname as n from pg_namespace where nspname ~ '^plo_ctl_[0-9a-f]{6}$'");
    for (const { n } of stale) await monitor.query(`drop schema ${n} cascade`);
    await checkPrerequisites();
    await sweepTagged("plo-");
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
