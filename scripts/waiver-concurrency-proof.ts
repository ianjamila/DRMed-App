// Hand-run local CONCURRENCY proof for the waived-balance functions
// (supabase/migrations/0183_waived_balance_gl.sql, P0069-P0071):
// waive_visit_balance (+ its helper waiver_post_allocation) and the guards and
// bridges it races with - guard_payment_on_waived_visit (payment insert / void,
// P0070), the visit/line triggers, fn_undo_release_bridge ->
// waiver_unrecognise_line (undo-release). No later migration redefines them
// (0198 / 0205 only document the lock order in a comment).
//
// This replaces supabase/tests/0183_waiver_race_smoke.sql (dblink, supabase_admin,
// psql). Same races, driven the way the other runners drive them: separate `pg`
// connections acting as service_role with the admin's JWT `sub` (the app writes
// waivers, payments and undo-releases through the service-role admin client),
// real committed fixtures, pg_locks to PROVE each interleaving was reached.
//
// DETERMINISTIC, NOT LUCKY. Every forced scenario holds one side's locks in an
// open transaction, starts the other side, and does not move on until pg_locks
// shows that backend waiting on a row lock. If the intended interleaving is not
// reached the scenario FAILS - it never degrades into a sequential run.
//
// SCENARIOS (old dblink smoke -> this file; every one runs in BOTH plan modes)
//   old 1  -> S1  payment-then-waive: a payment insert wins the visit lock; the
//                 waiver waits, then reads paid_php AFTER it commits (waives 600).
//   old 2  -> S2  waive-then-payment: the waive wins the visit lock; the payment
//                 insert waits, reads 'waived' and is refused (P0070).
//   old 3  -> S3  undo-then-waive: an undo-release wins the line lock; the waiver
//                 reads the line's FINAL status (ready_for_release) and leaves the
//                 allocation unrecognised - no standalone JE.
//   old 4  -> S4  waive-then-undo: the waiver wins the line lock, posts a
//                 standalone JE; the undo, running after, reverses it through
//                 waiver_unrecognise_line.
//   old 5  -> S5  forced package-cascade deadlock [CR-17]: waiver (visit -> header
//                 -> component by id) vs an undo cascade (component -> header) lock
//                 in opposite order; Postgres aborts exactly one side (40P01),
//                 re-running the loser converges on the same end state either way.
//   NEW    -> S6  waive vs waive: the second waits, then is refused "already
//                 waived" (P0071); one allocation set only.
//   NEW    -> S7  payment-void then waive: the void holds the visit lock; the
//                 waiver waits, then waives the FULL total (the voided payment no
//                 longer counts).
//   NEW    -> S8  waive then payment-void: the void waits and is refused (P0070);
//                 the payment stays live.
//   NEW    -> S9  lock-order agreement: a session holding a visit's LOWEST line
//                 while the waiver waits on it can still lock the higher line and
//                 commit - no deadlock, because the waiver locks lines in id order.
//
// CONTROL ROUNDS (--control) prove the proof can fail: each copies
// waive_visit_balance + waiver_post_allocation into a throwaway schema
// (wvr_ctl_<hex>, never public - the local stack is shared) with ONE guard
// removed, reruns the named forced scenarios against the copy, and passes only
// if they FAIL in both modes (see MUTANTS):
//   M1 drops the line row locks (S3, S5)           M4 drops the already-waived refusal (S6)
//   M2 drops the visit row lock (S1, S7)           M5 counts voided payments as paid (S7)
//   M3 locks lines in DESC id order (S5, S9)       M6 never posts the standalone JE (S4)
// NOT mutated: the guards that live in triggers on public tables
// (guard_payment_on_waived_visit, the visit/line guards, fn_undo_release_bridge /
// waiver_unrecognise_line). A trigger on a public table fires for every session,
// so a mutant of it cannot be isolated on the shared stack. They are exercised -
// not mutated - by S2, S4, S5 and S8.
//
// FIXTURES. Committed (two connections cannot see each other's uncommitted
// rows): an admin (auth.users + staff_profiles), a lab-test and a package
// service, a patient per run, and a fresh visit + lines + payments per scenario.
// Every row carries a per-run tag (`wvr-<hex>` / `WVR-<HEX>`); stale rows from a
// crashed run are swept before seeding, and the `finally` deletes everything
// (and the journal entries the bridges posted for it) and proves nothing tagged
// is left. It never touches rows it did not mint.
//
// Run (local stack, 0183 applied):
//   npm run waiver:concurrency-proof               # 2 plan modes
//   npm run waiver:concurrency-proof -- --control  # + control rounds
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";

requireLocalOrExplicitProd("waiver:concurrency-proof", {
  writes:
    "throwaway fixtures tagged wvr-<hex> (an admin, services, a patient, visits, lines, payments, waiver allocations and the journal entries their bridges post), committed so connections can race on them, then deleted",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// This script COMMITS rows: never run it against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(
    `[waiver:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script commits fixtures and only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `wvr-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();

const fx = {
  admin: randomUUID(),
  svcLab: randomUUID(),
  svcPkg: randomUUID(),
  patient: randomUUID(),
};

type Mode = "seq" | "indexed";

// Where the functions under test live: public, or a --control mutant schema.
let fnSchema = "public";

interface Actor {
  name: string;
  c: Client;
  pid: number;
}

let monitor: Client; // postgres; seeds, reads committed state, watches waits
const open: Actor[] = [];

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  // A forced wait that never resolves must fail the run, not hang it.
  await c.query("set statement_timeout = '20s'");
  return c;
}

// A fresh connection per actor per scenario (plpgsql caches plans per session).
async function actor(name: string): Promise<Actor> {
  const c = await connect();
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  const a = { name, c, pid: rows[0].pid };
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
  indexed: ["set local enable_seqscan = off", "set local enable_bitmapscan = off"],
};

// BEGIN as service_role carrying the admin's JWT sub (auth.uid() = the admin).
async function begin(a: Actor, mode: Mode): Promise<void> {
  await a.c.query("begin");
  await a.c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: fx.admin, role: "service_role" }),
  ]);
  await a.c.query("set local role service_role");
  for (const g of MODE_GUCS[mode]) await a.c.query(g);
}

// ---------------------------------------------------------------------------
// The calls, exactly as the app issues them
// ---------------------------------------------------------------------------

type Out<T> = { ok: true; v: T } | { ok: false; code: string; message: string };

async function settle<T>(p: Promise<QueryResult>, pick: (r: QueryResult) => T): Promise<Out<T>> {
  try {
    const r = await p;
    return { ok: true, v: pick(r) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "?", message: err.message ?? String(e) };
  }
}

// waiveVisitBalanceAction -> rpc("waive_visit_balance")
function waive(a: Actor, visit: string, reason: string): Promise<Out<{ waived_php: number; posted_now: number }>> {
  return settle(
    a.c.query(`select ${fnSchema}.waive_visit_balance($1::uuid, $2::uuid, $3::text) as r`, [visit, fx.admin, reason]),
    (r) => r.rows[0].r as { waived_php: number; posted_now: number },
  );
}

// Payment insert (the receive-payment action), service role.
function pay(a: Actor, visit: string, amount: number, id: string = randomUUID()): Promise<Out<number>> {
  return settle(
    a.c.query(
      "insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values ($1, $2, $3, 'cash', $4, now())",
      [id, visit, amount, fx.admin],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// voidPaymentAction's UPDATE (payments/[id]/void/actions.ts).
function voidPayment(a: Actor, paymentId: string): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.payments set voided_at = now(), voided_by = $2, void_reason = $3
        where id = $1 and voided_at is null returning id`,
      [paymentId, fx.admin, `${TAG} concurrency proof`],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// undo release: the status flip the app's undo issues (fires fn_undo_release_bridge).
function undoRelease(a: Actor, line: string): Promise<Out<number>> {
  return settle(
    a.c.query(
      `update public.test_requests
          set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null
        where id = $1`,
      [line],
    ),
    (r) => r.rowCount ?? 0,
  );
}

function lockLine(a: Actor, line: string): Promise<Out<number>> {
  return settle(a.c.query("select 1 from public.test_requests where id = $1 for update", [line]), (r) => r.rowCount ?? 0);
}

// Commit on success, roll back on refusal - the way PostgREST ends each RPC's
// transaction. Never rejects.
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

// ---------------------------------------------------------------------------
// Interleaving control
// ---------------------------------------------------------------------------

class Fail extends Error {}

// Waiting on a ROW: an ungranted transactionid or tuple lock (a relation-level
// wait from another session's DDL on the shared stack does not count).
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
    await sleep(100);
  }
  throw new Fail(`interleaving not reached: ${a.name} never waited on a lock (${why})`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expectOk<T>(label: string, o: Out<T>): T {
  if (!o.ok) throw new Fail(`${label}: expected success, got ${o.code} ${o.message}`);
  return o.v;
}

function expectCode<T>(label: string, o: Out<T>, code: string): void {
  if (o.ok) throw new Fail(`${label}: expected ${code}, but it succeeded`);
  if (o.code !== code) throw new Fail(`${label}: expected ${code}, got ${o.code} ${o.message}`);
}

// ---------------------------------------------------------------------------
// Fixture builders (committed, as postgres)
// ---------------------------------------------------------------------------

let visitSeq = 0;
const made = { tests: [] as string[], payments: [] as string[], visits: [] as string[] };

interface Line {
  id: string;
  price: number;
}
interface Fix {
  visit: string;
  lines: Line[]; // ids ascending
  payment: string | null;
}

// A visit of lab lines at the given prices (ids sorted ascending, so lines[0]
// has the lowest lock order). Optionally paid `paid` (live payment, partial).
// `release` releases the listed line indexes as postgres AFTER payment (so the
// GL bridge posts the release JE exactly as in production), then - when
// `voidAfter` - voids that payment, leaving the JE posted and the visit unpaid.
async function mkVisit(spec: {
  prices: number[];
  paid?: number;
  release?: number[];
  voidAfter?: boolean;
  note: string;
}): Promise<Fix> {
  const ids = Array.from({ length: spec.prices.length }, () => randomUUID()).sort();
  const lines = ids.map((id, i) => ({ id, price: spec.prices[i] }));
  const total = spec.prices.reduce((t, p) => t + p, 0);
  const visit = randomUUID();
  const payment = spec.paid ? randomUUID() : null;
  const seq = ++visitSeq;
  made.visits.push(visit);
  made.tests.push(...ids);
  if (payment) made.payments.push(payment);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, notes)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', $4, 0, $5)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient, total, `${TAG} ${spec.note}`],
    );
    for (const l of lines) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
         values ($1, $2, $3, 'requested', $4, $5, $5)`,
        [l.id, visit, fx.svcLab, fx.admin, l.price],
      );
    }
    if (payment) {
      await monitor.query(
        "insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values ($1, $2, $3, 'cash', $4, now())",
        [payment, visit, spec.paid, fx.admin],
      );
    }
    for (const i of spec.release ?? []) {
      await monitor.query("update public.test_requests set status = 'ready_for_release' where id = $1", [ids[i]]);
      await monitor.query(
        "update public.test_requests set status = 'released', released_at = now(), released_by = $2, release_medium = 'other' where id = $1",
        [ids[i], fx.admin],
      );
    }
    if (spec.voidAfter && payment) {
      await monitor.query(
        "update public.payments set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1",
        [payment, fx.admin, `${TAG} prep void`],
      );
    }
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, lines, payment };
}

interface PkgFix {
  visit: string;
  header: string;
  c1: string;
  c2: string;
}

// Package visit (old scenario 5): header H (a lab_package line, 5888) with
// components c1, c2 (parent_id = H, 0 each). Ids are minted ascending
// header < c1 < c2 so the header sorts FIRST in `order by id` (the deadlock needs
// it). Paid 5888, both components released (the header auto-releases, 0109),
// payment then voided: the release JEs stay posted.
async function mkPackage(): Promise<PkgFix> {
  const [header, c1, c2] = [randomUUID(), randomUUID(), randomUUID()].sort();
  const visit = randomUUID();
  const payment = randomUUID();
  const seq = ++visitSeq;
  made.visits.push(visit);
  made.tests.push(header, c1, c2);
  made.payments.push(payment);
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, notes)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 5888, 0, $4)`,
      [visit, `V-${TAG_UP}-${seq}`, fx.patient, `${TAG} package`],
    );
    await monitor.query(
      `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php, is_package_header)
       values ($1, $2, $3, 'ready_for_release', $4, 5888, 5888, true)`,
      [header, visit, fx.svcPkg, fx.admin],
    );
    for (const id of [c1, c2]) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php, parent_id)
         values ($1, $2, $3, 'in_progress', $4, 0, 0, $5)`,
        [id, visit, fx.svcLab, fx.admin, header],
      );
    }
    await monitor.query(
      "insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values ($1, $2, 5888, 'cash', $3, now())",
      [payment, visit, fx.admin],
    );
    for (const id of [c1, c2]) {
      await monitor.query(
        "update public.test_requests set status = 'released', released_at = now(), released_by = $2 where id = $1",
        [id, fx.admin],
      );
    }
    const { rows } = await monitor.query("select 1 from public.test_requests where id = $1 and status = 'released'", [header]);
    if (rows.length !== 1) throw new Error("prep: package header did not auto-release (0109)");
    await monitor.query("update public.payments set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1", [
      payment,
      fx.admin,
      `${TAG} prep void`,
    ]);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
  return { visit, header, c1, c2 };
}

// ---------------------------------------------------------------------------
// Committed-state readers (monitor connection)
// ---------------------------------------------------------------------------

async function visitRow(visit: string): Promise<{ status: string; waived: number; paid: number }> {
  const { rows } = await monitor.query<{ payment_status: string; waived_php: string | null; paid_php: string }>(
    "select payment_status, waived_php, paid_php from public.visits where id = $1",
    [visit],
  );
  return { status: rows[0].payment_status, waived: Number(rows[0].waived_php ?? 0), paid: Number(rows[0].paid_php) };
}

async function allocs(visit: string): Promise<Array<{ id: string; line: string; amount: number; recognised: boolean }>> {
  const { rows } = await monitor.query<{ id: string; test_request_id: string; amount_php: string; recognised_at: Date | null }>(
    "select id, test_request_id, amount_php, recognised_at from public.visit_waiver_allocations where visit_id = $1 order by test_request_id",
    [visit],
  );
  return rows.map((r) => ({ id: r.id, line: r.test_request_id, amount: Number(r.amount_php), recognised: r.recognised_at !== null }));
}

async function waiverJe(allocId: string): Promise<{ id: string; status: string } | null> {
  const { rows } = await monitor.query<{ id: string; status: string }>(
    "select id, status from public.journal_entries where source_kind = 'visit_waiver' and source_id = $1",
    [allocId],
  );
  return rows[0] ?? null;
}

async function reversalStatus(origJe: string): Promise<string | null> {
  const { rows } = await monitor.query<{ status: string }>("select status from public.journal_entries where reverses = $1", [origJe]);
  return rows[0]?.status ?? null;
}

async function liveWaiverJes(visit: string): Promise<number> {
  const { rows } = await monitor.query<{ n: number }>(
    `select count(*)::int as n from public.journal_entries
      where source_kind = 'visit_waiver' and source_id in (select id from public.visit_waiver_allocations where visit_id = $1)`,
    [visit],
  );
  return rows[0].n;
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
let curMode: Mode = "seq";

async function scenario(id: string, name: string, body: () => Promise<string | void>): Promise<void> {
  if (only && !only.includes(id)) return;
  const full = `[${curMode}] ${id} ${name}`;
  try {
    const note = await body();
    sink.push({ name: full, ok: true, detail: note ?? "" });
    console.log(`  PASS  ${full}${note ? ` - ${note}` : ""}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    sink.push({ name: full, ok: false, detail });
    console.log(`  FAIL  ${full} - ${detail}`);
  } finally {
    await closeActors();
  }
}

async function forcedScenarios(mode: Mode): Promise<void> {
  curMode = mode;

  // concurrency-proof: waive_visit_balance (S1: waiver queues behind a payment on the visit lock and reads paid_php after it commits)
  // ---- S1 payment-then-waive (old 1) --------------------------------------
  await scenario("S1", "payment-then-waive", async () => {
    const f = await mkVisit({ prices: [1000], note: "S1" });
    const [s1, s2] = [await actor("S1-pay"), await actor("S1-waive")];
    await begin(s1, mode);
    expectOk("S1 payment insert", await pay(s1, f.visit, 400));
    await begin(s2, mode);
    const w = andEnd(s2, waive(s2, f.visit, `${TAG} S1`));
    await mustWait(s2, "waiver waits on the visit lock the payment holds");
    await s1.c.query("commit");
    expectOk("S1 waive", await w);
    const v = await visitRow(f.visit);
    if (v.status !== "waived" || v.waived !== 600) throw new Fail(`visit should be waived at 600, got ${v.status}/${v.waived}`);
    const sum = (await allocs(f.visit)).reduce((t, a) => t + a.amount, 0);
    if (sum !== 600) throw new Fail(`allocation sum should be 600, got ${sum}`);
    return "waived 600 after the payment committed";
  });

  // concurrency-proof: guard_payment_on_waived_visit (S2 payment insert and S8 void each wait on the visit lock, then are refused P0070)
  // ---- S2 waive-then-payment (old 2) --------------------------------------
  await scenario("S2", "waive-then-payment", async () => {
    const f = await mkVisit({ prices: [1000], note: "S2" });
    const [s1, s2] = [await actor("S2-waive"), await actor("S2-pay")];
    await begin(s1, mode);
    expectOk("S2 waive", await waive(s1, f.visit, `${TAG} S2`));
    await begin(s2, mode);
    const p = andEnd(s2, pay(s2, f.visit, 400));
    await mustWait(s2, "payment waits on the visit lock the waiver holds");
    await s1.c.query("commit");
    expectCode("S2 payment", await p, "P0070");
    const { rows } = await monitor.query("select 1 from public.payments where visit_id = $1", [f.visit]);
    if (rows.length > 0) throw new Fail("a payment row was created despite the waive");
    return "payment refused P0070";
  });

  // ---- S3 undo-then-waive (old 3) -----------------------------------------
  await scenario("S3", "undo-then-waive", async () => {
    const f = await mkVisit({ prices: [1000], paid: 1000, release: [0], voidAfter: true, note: "S3" });
    const [s1, s2] = [await actor("S3-undo"), await actor("S3-waive")];
    await begin(s1, mode);
    expectOk("S3 undo", await undoRelease(s1, f.lines[0].id));
    await begin(s2, mode);
    const w = andEnd(s2, waive(s2, f.visit, `${TAG} S3`));
    await mustWait(s2, "waiver waits on the line lock the undo holds");
    await s1.c.query("commit");
    expectOk("S3 waive", await w);
    const a = await allocs(f.visit);
    if (a.length !== 1) throw new Fail(`expected one allocation, got ${a.length}`);
    if (a[0].recognised) throw new Fail("allocation was recognised (should be pending, folded at the next release)");
    if ((await liveWaiverJes(f.visit)) !== 0) {
      throw new Fail("a visit_waiver JE was posted (the waiver should have read ready_for_release, not released)");
    }
    return "allocation pending, no standalone JE";
  });

  // concurrency-proof: waiver_unrecognise_line, fn_undo_release_bridge, waiver_post_allocation (S4: the undo waits behind the waiver that posted the standalone JE, then reverses it; S3/S5 race the same undo path)
  // ---- S4 waive-then-undo (old 4) -----------------------------------------
  await scenario("S4", "waive-then-undo", async () => {
    const f = await mkVisit({ prices: [1000], paid: 1000, release: [0], voidAfter: true, note: "S4" });
    const [s1, s2] = [await actor("S4-waive"), await actor("S4-undo")];
    await begin(s1, mode);
    expectOk("S4 waive", await waive(s1, f.visit, `${TAG} S4`));
    await begin(s2, mode);
    const u = andEnd(s2, undoRelease(s2, f.lines[0].id));
    await mustWait(s2, "undo waits on the line lock the waiver holds");
    await s1.c.query("commit");
    expectOk("S4 undo", await u);
    const [a] = await allocs(f.visit);
    const je = a ? await waiverJe(a.id) : null;
    if (!je || je.status !== "reversed") throw new Fail(`expected the standalone waiver JE reversed, got ${je?.status ?? "none"}`);
    const rev = await reversalStatus(je.id);
    if (rev !== "posted") throw new Fail(`mirrored reversal is not posted (got ${rev})`);
    if (a.recognised) throw new Fail("allocation still recognised after the undo");
    return "standalone JE reversed by the undo";
  });

  // ---- S5 forced package-cascade deadlock (old 5) -------------------------
  await scenario("S5", "package-cascade deadlock [CR-17]", async () => {
    const p = await mkPackage();
    const [s1, s2] = [await actor("S5-undo"), await actor("S5-waive")];
    await begin(s1, mode);
    expectOk("S5 s1 locks component 1", await lockLine(s1, p.c1));
    await begin(s2, mode);
    // The waiver: visit, header (free), component 1 (held by s1) -> waits.
    const w = waive(s2, p.visit, `${TAG} S5`);
    await mustWait(s2, "waiver waits on component 1");
    // The undo cascade: component 1 -> trigger locks the header, held by the waiver.
    const u = undoRelease(s1, p.c1);
    // Both sides are now queued in a cycle; Postgres resolves it after
    // deadlock_timeout. Require that a wait was observed on the way.
    let done = 0;
    const wd = w.then((o) => (done++, o));
    const ud = u.then((o) => (done++, o));
    let seen = false;
    for (let i = 0; i < 100 && done === 0; i++) {
      if ((await waitingOnLock(s1.pid)) || (await waitingOnLock(s2.pid))) seen = true;
      await sleep(50);
    }
    const [wo, uo] = await Promise.all([wd, ud]);
    if (!seen) throw new Fail("neither side was observed waiting on a lock before resolution");
    const wErr = !wo.ok;
    const uErr = !uo.ok;
    if (wErr && uErr) throw new Fail(`both sides errored (waive=${!wo.ok && wo.code}, undo=${!uo.ok && uo.code})`);
    if (!wErr && !uErr) throw new Fail("neither side errored - expected a deadlock");
    const bad = wErr ? wo : uErr ? uo : null;
    if (bad && !bad.ok && bad.code !== "40P01") throw new Fail(`loser failed with ${bad.code} (expected 40P01)`);
    const loser = uErr ? "undo" : "waive";
    if (uErr) {
      await s1.c.query("rollback");
      await s2.c.query("commit");
      await begin(s1, mode);
      expectOk("S5 undo retry", await andEnd(s1, undoRelease(s1, p.c1)));
    } else {
      await s2.c.query("rollback");
      await s1.c.query("commit");
      await begin(s2, mode);
      expectOk("S5 waive retry", await andEnd(s2, waive(s2, p.visit, `${TAG} S5 retry`)));
    }
    // End state: identical either way.
    const v = await visitRow(p.visit);
    if (v.status !== "waived" || v.waived !== 5888) throw new Fail(`visit is not waived at 5888 (${v.status}/${v.waived})`);
    const a = (await allocs(p.visit)).find((x) => x.line === p.header);
    if (!a) throw new Fail("the header's allocation is missing");
    if (a.recognised) throw new Fail("the header's allocation should be unrecognised (folded, pending re-release)");
    const { rows: hs } = await monitor.query("select 1 from public.test_requests where id = $1 and status = 'ready_for_release'", [p.header]);
    if (hs.length !== 1) throw new Fail("the header is not back to ready_for_release");
    const { rows: rj } = await monitor.query(
      "select 1 from public.journal_entries where source_kind = 'test_request' and source_id = $1 and status = 'reversed'",
      [p.header],
    );
    if (rj.length < 1) throw new Fail("the header's original release JE is not reversed");
    const je = await waiverJe(a.id);
    if (loser === "undo") {
      // The waiver survived and posted the standalone header JE first; the
      // retried undo reversed it through waiver_unrecognise_line.
      if (!je || je.status !== "reversed") throw new Fail(`expected the standalone header waiver JE reversed (loser=undo), got ${je?.status ?? "none"}`);
      if ((await reversalStatus(je.id)) !== "posted") throw new Fail("mirrored waiver reversal is not posted");
    } else if (je) {
      // The undo survived first; the header was back to ready_for_release before
      // the retried waiver ran, so it folded the share: no standalone JE.
      throw new Fail("an unexpected standalone visit_waiver JE exists (loser=waive)");
    }
    // 1100 nets to zero across the header's own entries and their reversals.
    const { rows: net } = await monitor.query<{ net: string }>(
      `select coalesce(sum(jl.debit_php - jl.credit_php), 0)::text as net
         from public.journal_lines jl
         join public.journal_entries je on je.id = jl.entry_id
         join public.chart_of_accounts coa on coa.id = jl.account_id
        where coa.code = '1100' and je.status in ('posted', 'reversed')
          and ((je.source_kind = 'test_request' and je.source_id = $1)
            or (je.source_kind = 'visit_waiver' and je.source_id = $2)
            or je.reverses in (select id from public.journal_entries
                                where (source_kind = 'test_request' and source_id = $1)
                                   or (source_kind = 'visit_waiver' and source_id = $2)))`,
      [p.header, a.id],
    );
    if (Number(net[0].net) !== 0) throw new Fail(`1100 does not net to zero for the header (got ${net[0].net})`);
    return `loser was ${loser}, retried standalone; 1100 nets to 0`;
  });

  // ---- S6 waive vs waive (new) ---------------------------------------------
  await scenario("S6", "waive-vs-waive", async () => {
    const f = await mkVisit({ prices: [1000], note: "S6" });
    const [s1, s2] = [await actor("S6-first"), await actor("S6-second")];
    await begin(s1, mode);
    expectOk("S6 first waive", await waive(s1, f.visit, `${TAG} S6 first`));
    await begin(s2, mode);
    const w2 = andEnd(s2, waive(s2, f.visit, `${TAG} S6 second`));
    await mustWait(s2, "second waiver waits on the visit lock");
    await s1.c.query("commit");
    expectCode("S6 second waive", await w2, "P0071");
    const a = await allocs(f.visit);
    const sum = a.reduce((t, x) => t + x.amount, 0);
    if (a.length !== 1 || sum !== 1000) throw new Fail(`expected one allocation of 1000, got ${a.length} / ${sum}`);
    return "second waive refused P0071, one allocation set";
  });

  // ---- S7 void-then-waive (new) --------------------------------------------
  await scenario("S7", "void-then-waive", async () => {
    const f = await mkVisit({ prices: [1000], paid: 400, note: "S7" });
    const [s1, s2] = [await actor("S7-void"), await actor("S7-waive")];
    await begin(s1, mode);
    if (expectOk("S7 void", await voidPayment(s1, f.payment!)) !== 1) throw new Fail("S7 void touched no row");
    await begin(s2, mode);
    const w = andEnd(s2, waive(s2, f.visit, `${TAG} S7`));
    await mustWait(s2, "waiver waits on the visit lock the void holds");
    await s1.c.query("commit");
    expectOk("S7 waive", await w);
    const v = await visitRow(f.visit);
    if (v.status !== "waived" || v.waived !== 1000) throw new Fail(`should waive the full 1000 once the payment is voided, got ${v.status}/${v.waived}`);
    return "waived 1000 (voided payment no longer counts)";
  });

  // ---- S8 waive-then-void (new) --------------------------------------------
  await scenario("S8", "waive-then-void", async () => {
    const f = await mkVisit({ prices: [1000], paid: 400, note: "S8" });
    const [s1, s2] = [await actor("S8-waive"), await actor("S8-void")];
    await begin(s1, mode);
    expectOk("S8 waive", await waive(s1, f.visit, `${TAG} S8`));
    await begin(s2, mode);
    const vd = andEnd(s2, voidPayment(s2, f.payment!));
    await mustWait(s2, "void waits on the visit lock the waiver holds");
    await s1.c.query("commit");
    expectCode("S8 void", await vd, "P0070");
    const { rows } = await monitor.query("select voided_at from public.payments where id = $1", [f.payment]);
    if (rows[0].voided_at !== null) throw new Fail("the payment was voided despite the waive");
    return "void refused P0070, payment stays live";
  });

  // ---- S9 lock-order agreement (new) ---------------------------------------
  await scenario("S9", "line lock order agrees (no deadlock)", async () => {
    const f = await mkVisit({ prices: [500, 500], note: "S9" });
    const [s1, s2] = [await actor("S9-holder"), await actor("S9-waive")];
    await begin(s1, mode);
    expectOk("S9 lock lowest line", await lockLine(s1, f.lines[0].id));
    await begin(s2, mode);
    const w = andEnd(s2, waive(s2, f.visit, `${TAG} S9`));
    await mustWait(s2, "waiver waits on the lowest line");
    // The waiver has locked nothing above the line it waits on, so the holder
    // can still take the higher line. A waiver locking in DESC order would hold
    // it already and deadlock here.
    const second = await lockLine(s1, f.lines[1].id);
    if (!second.ok) throw new Fail(`holder could not take the higher line (${second.code}): the waiver locks lines out of id order`);
    await s1.c.query("commit");
    expectOk("S9 waive", await w);
    return "holder took both lines, waiver completed";
  });
}

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

// Remove every row of the runs whose tag starts with `like` ("wvr-" = every
// stale run, TAG = this run), including the journal entries the payment,
// release and waiver bridges posted for them. One transaction under
// session_replication_role = replica (local only): the immutable-ledger guards
// and the waived-visit guards must not veto a teardown.
async function sweepTagged(like: string): Promise<void> {
  if (!/^wvr-[0-9a-f]{0,6}$/.test(like)) throw new Error(`refusing to sweep pattern ${like}`);
  const up = like.toUpperCase();
  await monitor.query("begin");
  try {
    await monitor.query("set local session_replication_role = replica");
    const stmts = [
      `create temp table wvr_visits on commit drop as select id from public.visits where visit_number like 'V-${up}%'`,
      `create temp table wvr_staff on commit drop as select id from auth.users where email like '${like}%@example.test'`,
      `create temp table wvr_tr on commit drop as select id from public.test_requests where visit_id in (select id from wvr_visits)`,
      `create temp table wvr_pay on commit drop as select id from public.payments where visit_id in (select id from wvr_visits)`,
      `create temp table wvr_alloc on commit drop as select id from public.visit_waiver_allocations where visit_id in (select id from wvr_visits)`,
      `create temp table wvr_je on commit drop as
         select id from public.journal_entries
          where created_by in (select id from wvr_staff)
             or (source_kind = 'test_request' and source_id in (select id from wvr_tr))
             or (source_kind = 'payment' and source_id in (select id from wvr_pay))
             or (source_kind = 'visit_waiver' and source_id in (select id from wvr_alloc))`,
      `insert into wvr_je
         select j.id from public.journal_entries j
          where (j.reverses in (select id from wvr_je)
                 or j.id in (select o.reversed_by from public.journal_entries o
                              where o.id in (select id from wvr_je) and o.reversed_by is not null))
            and j.id not in (select id from wvr_je)`,
      `delete from public.journal_lines where entry_id in (select id from wvr_je)`,
      `delete from public.journal_entries where id in (select id from wvr_je)`,
      `delete from public.audit_log
        where actor_id in (select id from wvr_staff)
           or resource_id in (select id from wvr_tr) or resource_id in (select id from wvr_pay)
           or resource_id in (select id from wvr_visits) or resource_id in (select id from wvr_alloc)`,
      `delete from public.doctor_pf_entries where test_request_id in (select id from wvr_tr)`,
      `delete from public.visit_waiver_allocations where id in (select id from wvr_alloc)`,
      `delete from public.payments where id in (select id from wvr_pay)`,
      `delete from public.test_requests where id in (select id from wvr_tr)`,
      `delete from public.visits where id in (select id from wvr_visits)`,
      `delete from public.patients where drm_id like 'DRM-${up}%'`,
      `delete from public.services where code like '${up}%'`,
      `delete from public.staff_profiles where id in (select id from wvr_staff)`,
      `delete from auth.users where id in (select id from wvr_staff)`,
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
          + (select count(*) from public.patients where drm_id like $4)
          + (select count(*) from public.visits where visit_number like $5)
          + (select count(*) from public.visit_waiver_allocations where visit_id = any($6::uuid[]))
          + (select count(*) from public.test_requests where id = any($7::uuid[]))
          + (select count(*) from public.payments where id = any($8::uuid[]))
          + (select count(*) from public.journal_entries
              where source_id = any($7::uuid[]) or source_id = any($8::uuid[]))
          + (select count(*) from public.audit_log
              where resource_id = any($7::uuid[]) or resource_id = any($8::uuid[]) or resource_id = any($6::uuid[])) as n`,
    [`${like}%@example.test`, `${like}%`, `${up}%`, `DRM-${up}%`, `V-${up}%`, made.visits, made.tests, made.payments],
  );
  return Number(rows[0].n);
}

async function seed(): Promise<void> {
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
      [fx.admin, `${TAG}-a@example.test`],
    );
    await monitor.query("insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, 'admin', true)", [
      fx.admin,
      `${TAG} Admin`,
    ]);
    await monitor.query("insert into public.services (id, code, name, price_php, kind) values ($1, $2, $3, 1000, 'lab_test')", [
      fx.svcLab,
      `${TAG_UP}-LAB`,
      `${TAG} lab test`,
    ]);
    await monitor.query("insert into public.services (id, code, name, price_php, kind) values ($1, $2, $3, 5888, 'lab_package')", [
      fx.svcPkg,
      `${TAG_UP}-PKG`,
      `${TAG} package`,
    ]);
    await monitor.query(
      `insert into public.patients (id, drm_id, first_name, last_name, birthdate)
       values ($1, $2, 'Wvr', 'Fixture', '1990-01-01')`,
      [fx.patient, `DRM-${TAG_UP}`],
    );
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Control rounds (--control): prove the proof can fail
// ---------------------------------------------------------------------------
//
// Each mutant is a copy of the live waive_visit_balance + waiver_post_allocation
// with one guard removed, created in a throwaway schema (never public - other
// sessions keep calling the real functions). The named forced scenarios run
// against the copy, and the round PASSES only when every one of them fails in
// both plan modes.

type FnName = "waive_visit_balance" | "waiver_post_allocation";

interface Mutant {
  key: string;
  what: string;
  fn: FnName;
  edits: Array<[string, string]>;
  mustFail: string[];
}

const LINE_LOCK = "perform 1 from public.test_requests where visit_id = p_visit_id and deleted_at is null order by id for update;";

const MUTANTS: Mutant[] = [
  {
    key: "M1",
    what: "no line row locks (the waiver reads line statuses without FOR UPDATE)",
    fn: "waive_visit_balance",
    edits: [[LINE_LOCK, "perform 1 from public.test_requests where visit_id = p_visit_id and deleted_at is null order by id;"]],
    mustFail: ["S3", "S5"],
  },
  {
    key: "M2",
    what: "no visit row lock (the waiver reads the visit and its payments without FOR UPDATE)",
    fn: "waive_visit_balance",
    edits: [["select * into v_visit from public.visits where id = p_visit_id for update;", "select * into v_visit from public.visits where id = p_visit_id;"]],
    mustFail: ["S1", "S7"],
  },
  {
    key: "M3",
    what: "wrong lock order (lines locked in DESC id order, against every other path)",
    fn: "waive_visit_balance",
    edits: [[LINE_LOCK, "perform 1 from public.test_requests where visit_id = p_visit_id and deleted_at is null order by id desc for update;"]],
    mustFail: ["S9"],
  },
  {
    key: "M4",
    what: "no already-waived refusal (a second waive carries on)",
    fn: "waive_visit_balance",
    edits: [["if v_visit.payment_status = 'waived' then", "if false then"]],
    mustFail: ["S6"],
  },
  {
    key: "M5",
    what: "paid sum counts voided payments (drops the voided_at is null filter)",
    fn: "waive_visit_balance",
    edits: [["where visit_id = p_visit_id and voided_at is null;", "where visit_id = p_visit_id;"]],
    mustFail: ["S7"],
  },
  {
    key: "M6",
    what: "released lines are never cleared (no standalone waiver JE is posted)",
    fn: "waive_visit_balance",
    edits: [["where t.status = 'released'", "where false"]],
    mustFail: ["S4"],
  },
];

const FN_SIGS: Record<FnName, string> = {
  waive_visit_balance: "uuid, uuid, text",
  waiver_post_allocation: "uuid, uuid",
};

async function controlRounds(): Promise<void> {
  const schema = `wvr_ctl_${TAG.slice(4)}`;
  const names = Object.keys(FN_SIGS) as FnName[];
  const defs = {} as Record<FnName, string>;
  for (const fn of names) {
    const { rows } = await monitor.query<{ d: string }>(
      `select pg_get_functiondef('public.${fn}(${FN_SIGS[fn]})'::regprocedure) as d`,
    );
    let d = rows[0].d;
    // The function itself and every call between the copies.
    for (const other of names) d = d.split(`public.${other}(`).join(`${schema}.${other}(`);
    defs[fn] = d;
  }

  for (const m of MUTANTS) {
    let mutated = defs[m.fn];
    for (const [from, to] of m.edits) {
      if (!mutated.includes(from)) throw new Error(`control ${m.key}: "${from}" not found in ${m.fn}`);
      mutated = mutated.replace(from, () => to);
    }
    await monitor.query(`drop schema if exists ${schema} cascade`);
    await monitor.query(`create schema ${schema}`);
    try {
      for (const fn of names) await monitor.query(fn === m.fn ? mutated : defs[fn]);
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
      const detail = ok ? `caught by ${failedIds.length} scenario run(s)` : `NOT caught by ${missed.join(", ")}`;
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

async function teardown(): Promise<void> {
  await closeActors();
  await monitor.query(`drop schema if exists wvr_ctl_${TAG.slice(4)} cascade`);
  await sweepTagged(TAG);
  const left = await countTagged(TAG);
  if (left > 0) {
    results.push({ name: "teardown", ok: false, detail: `${left} fixture rows left behind` });
    console.log(`  FAIL  teardown - ${left} fixture rows left behind`);
  } else {
    console.log("  teardown: every fixture row removed (0 left)");
  }
}

async function main(): Promise<void> {
  monitor = await connect();

  // One run at a time on the shared stack: the startup sweep removes EVERY wvr-
  // fixture, which would pull a concurrent run's live rows out from under it.
  const { rows: lock } = await monitor.query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtext('waiver:concurrency-proof')) as got",
  );
  if (!lock[0].got) {
    console.error("[waiver:concurrency-proof] another run is in progress on this stack - try again when it finishes.");
    await monitor.end();
    process.exit(3);
  }

  let seeded = false;
  process.once("SIGINT", () => {
    console.log("\n  interrupted - tearing down");
    teardown()
      .catch((e) => console.error(e))
      .finally(() => process.exit(130));
  });
  try {
    const { rows: fn } = await monitor.query<{ ok: boolean }>(
      `select to_regprocedure('public.waive_visit_balance(uuid,uuid,text)') is not null
          and to_regprocedure('public.waiver_post_allocation(uuid,uuid)') is not null
          and to_regclass('public.visit_waiver_allocations') is not null as ok`,
    );
    if (!fn[0].ok) throw new Error("0183 is not applied to the local stack");

    await sweepTagged("wvr-");
    // Control-round schemas a crashed run left behind (always wvr_ctl_<hex>).
    const { rows: stale } = await monitor.query<{ n: string }>(
      "select nspname as n from pg_namespace where nspname ~ '^wvr_ctl_[0-9a-f]{6}$'",
    );
    for (const { n } of stale) await monitor.query(`drop schema ${n} cascade`);
    console.log(`waiver concurrency proof - fixtures tagged ${TAG}`);
    await seed();
    seeded = true;

    for (const mode of ["seq", "indexed"] as Mode[]) await forcedScenarios(mode);
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
