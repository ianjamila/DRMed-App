// Hand-run local CONCURRENCY proof for the eight GL-bridge TRIGGER functions that took row locks
// but had never been raced:
//   bridge_payment_insert / bridge_payment_void                          (0140)  AFTER INSERT / void UPDATE on payments
//   bridge_cash_adjustment_insert (0152) / bridge_cash_adjustment_void (0141)    on eod_cash_adjustments
//   bridge_hmo_claim_resolution_insert / _void                           (0141)  on hmo_claim_resolutions
//   bridge_test_request_released / bridge_test_request_cancelled         (0183)  AFTER UPDATE on test_requests
// Each posts or reverses a journal entry (JE) for its source row. The "insert" bridges look for a posted JE
// of the source first (FOR UPDATE + status = 'posted'), the "void"/"cancelled" bridges reverse that JE (FOR
// UPDATE on it, must reverse exactly once), the release bridge also locks the line's waiver allocation.
//
// The sequential smokes cannot prove a race (a transaction never waits on itself), so this runner uses
// separate `pg` connections. DETERMINISTIC, NOT LUCKY: a forced scenario holds the first caller's
// transaction open, starts the second, and does not move on until pg_locks shows THAT backend waiting on
// the expected row lock (and, where it matters, which RELATION the lock is on). If the interleaving is not
// reached the scenario FAILS - it never degrades into a sequential run. Only the free-race scenarios
// (P6, T8, X1) rely on timing, and they assert invariants only.
//
// HOW EACH SOURCE ROW IS WRITTEN (as the app does)
//   payments           service_role: insert (receive payment), the void UPDATE verbatim from
//                      payments/[id]/void/actions.ts, correct_payment (Edit payment: voids the old row and
//                      inserts the new one in ONE transaction).
//   eod_cash_adjustments  service_role: the postTillCashExpense insert, voidTillCashExpense's UPDATE.
//   hmo_claim_resolutions service_role: the hmo-claims actions' insert / void UPDATE.
//   test_requests      a lab line is released and undone through release_visit_results /
//                      undo_visit_release as a signed-in admin (authenticated); a doctor line is "Mark
//                      done" with the visits/[id]/actions.ts UPDATE (authenticated, same WHERE); waive_visit_balance
//                      as service_role. THE APP HAS NO WRITER OF test_requests.status = 'cancelled' (only the
//                      DB's own package cascade), so a cancel is a plain service_role UPDATE, which is what
//                      an operator script would issue - and deliberately without a status guard.
//   direct JE writer   a plain-postgres UPDATE of journal_entries.status, the shape of a ledger tool or hand
//                      fix that reaches the entry WITHOUT going through the source row.
//
// WHAT IS AND IS NOT REDUNDANT (read this before the mutants)
//   A void/cancel serialises on the SOURCE row: the second UPDATE queues on it, then re-evaluates its WHERE.
//   So void x void, cancel x cancel and release x release are already serialised before the trigger body
//   runs, and the journal FOR UPDATE / status = 'posted' re-check are not what stops a double reversal -
//   P1 C1 H1 T3 T4 assert the waiter is queued on the source relation and keep passing without the lock
//   (the mutants' mustPass lists). The guards matter against a writer that reaches the JE (or, for the
//   release bridge, the waiver allocation) directly: P2 C2 H2 T5 (void/cancel), P5 C4 H4 (insert) and T6
//   (allocation). Those hold the JE / allocation, start the bridge, and require it to WAIT on the entry and
//   re-check - no second reversal, no second posting, no double fold of a waiver.
//   The INSERT bridges are only ever reached for a source row that is new, so its JE cannot exist yet; the
//   idempotency guard can only bite for an id whose JE is already there (a replayed / restored payment id),
//   which is what P5 C4 H4 do (the source row is removed with the delete trigger skipped, the JE kept).
//   P4 C3 H3 race two inserts of one id: the loser waits on the unique index, then 23505, exactly one JE.
//
// SCENARIOS
//   P1 payment void x void             P2 payment void x direct JE writer
//   P3a Edit payment x void of the old row   P3b void first, then Edit payment (P0054)
//   P4 payment insert x insert, same id      P5 payment insert x direct JE writer (replayed id)
//   P6 free race: payment inserts / voids / Edits across sessions, invariants only
//   P7 payment insert x the visit gaining an HMO provider (the bridge's unlocked read of visits is covered by the
//      visit lock the payment guard takes first: the JE debits AR - HMO)
//   P8a a visit delete in flight x payment insert (refused P0045/P0046, no JE)   P8b payment insert x visit delete (delete refused)
//   C1 cash adjustment void x void     C2 void x direct JE writer
//   C3 insert x insert, same id        C4 insert x direct JE writer (replayed id)
//   H1 HMO resolution void x void      H2 void x direct JE writer
//   H3 insert x insert, same id        H4 insert x direct JE writer (replayed id)
//   H5 two resolutions overshoot one claim item: the second queues on the BATCH row, then P0011
//   T1 doctor line "Mark done" x "Mark done" (one JE, one PF accrual)     T1b lab release x release (RPC)
//   T2a release x undo (doctor line, PF)     T2b undo x release (doctor line: re-accrues PF once)
//   T2c lab release x undo and undo x release (RPCs)
//   T3a cancel x undo of a released line     T3b undo x cancel (unguarded)    T4 cancel x cancel
//   T5 cancel x direct JE writer            T6 release x direct allocation writer
//   TW1 waive_visit_balance x release of a line of that visit (the share folds into the release JE once)
//   T8 free race: release / undo / cancel soup on one line, lab and doctor, invariants only
//   X1 free race: every bridge at once (payment insert/void, cash adj, HMO resolution, release/undo), no 40P01
//   K1a cancel x PF payout link   K1b PF payout link x cancel   - KNOWN issues, see below
//
// CONTROL ROUNDS (--control) prove the proof can fail. Each mutant removes ONE guard from the live
// function and the named scenarios must FAIL against it (mustPass ones must still pass):
//   M<fn>L  the journal-entry FOR UPDATE removed        M<fn>S  the `status = 'posted'` filter removed
//     (fn = PV payment void, PI payment insert, CV / CI cash adjustment void / insert, HV / HI HMO resolution
//      void / insert, TC test request cancelled: 14 mutants; the L / S of a void or cancel die in P2 C2 H2 T5 on
//      the duplicate reversal, those of an insert in P5 C4 H4 on the missing re-posting)
//   MRA     bridge_test_request_released without the waiver-allocation FOR UPDATE (T6)
// A trigger function cannot be copied into another schema, so each mutant is a TAGGED-CONDITIONAL swap of
// the public function: the deviation applies only inside a transaction that ran
//   set_config('glb.tag', '<run tag>', true)
// which only this runner's actors do - every other session's rows behave exactly as before. The originals
// are restored in finally / SIGINT / SIGTERM and verified byte-for-byte.
//
// KNOWN ISSUES (reported, not asserted; a KNOWN scenario that stops reproducing or breaks exits 1):
//   K1a/K1b createPfDisbursement (src/lib/actions/accounting/pf-disbursements.ts) reads the open PF entries,
//   inserts the disbursement header (its JE posts Dr 2110 / Cr cash for the total) and only then links the
//   entries with `update ... where id in (...)` - three statements, no lock, and the link has no
//   `voided_at is null` / `disbursement_id is null` filter. A concurrent cancel (or undo) of the line voids
//   the entry in between: the entry ends up voided AND disbursed, the doctor was paid for a cancelled line and
//   2110 is debited twice. The reverse order (link first, then cancel/undo) voids an entry that is already paid
//   out - bridge_test_request_cancelled's / fn_undo_release_bridge's UPDATE of doctor_pf_entries has no
//   `disbursement_id is null` guard either.
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows), tagged glb-<hex>,
// swept at start, deleted in finally (incl. auth users and every journal entry they posted) and then
// counted: a tagged row left is a FAIL. Local DB only.
//
// Run (local stack):
//   npm run gl-bridge:concurrency-proof [-- --control]
//   GLB_ROUNDS=40 npm run gl-bridge:concurrency-proof        # more free-race rounds
//   GLB_ONLY=P2,T5 npm run gl-bridge:concurrency-proof       # a subset while iterating
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

requireLocalOrExplicitProd("gl-bridge:concurrency-proof", {
  writes:
    "throwaway staff, services, a physician, patients, visits, lines, payments, cash adjustments, HMO claims and PF disbursements tagged glb-<hex>, plus the journal entries their bridges post, committed so two connections can race on them, then deleted; during --control it briefly swaps the eight public.bridge_* trigger functions for variants that deviate only inside transactions carrying this run's tag",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[gl-bridge:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const TAG = `glb-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();
const ROUNDS = Number(process.env.GLB_ROUNDS ?? 15);
const ONLY = process.env.GLB_ONLY ? new Set(process.env.GLB_ONLY.split(",").map((s) => s.trim())) : null;
const CONTROL = process.argv.includes("--control");
const BACKUP = join(tmpdir(), "glb-bridge-originals.json");
const MARK = "/* glb-mutant */";

const fx = {
  admin: randomUUID(),
  svcLab: randomUUID(),
  svcDoc: randomUUID(),
  physician: randomUUID(),
  patient: randomUUID(),
  provider: randomUUID(),
  shift: "" as string,
  contra: "" as string,
};

let monitor: Client;
const open: Client[] = [];
let seq = 0;
/** Set by the SIGINT/SIGTERM handler: no new scenario, mutant or swap may start once cleanup is under way. */
let aborting = false;

class Fail extends Error {}
/** A KNOWN issue reproduced (a scenario in KNOWN_IDS that throws this is reported, not failed). */
class Known extends Error {}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Fail(msg);
}
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Fail(`${label}: got ${g}, want ${w}`);
}

// ---------------------------------------------------------------------------
// Connections and actors
// ---------------------------------------------------------------------------
/** svc = service_role (the admin client), staff = authenticated admin (the session client), raw = plain postgres. */
type Who = "svc" | "staff" | "raw";
type Actor = { c: Client; pid: number; name: string; who: Who; settled: boolean };
type Out = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string; msg: string };

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  open.push(c);
  return c;
}
async function actor(name: string, who: Who): Promise<Actor> {
  const c = await newClient();
  const pid = (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  return { c, pid, name, who, settled: false };
}
/** begin; svc/staff carry the admin's JWT (auth.uid() = admin) and this run's mutant tag. */
async function begin(a: Actor): Promise<void> {
  await a.c.query("begin");
  if (a.who === "raw") return;
  const role = a.who === "svc" ? "service_role" : "authenticated";
  await a.c.query("select set_config('request.jwt.claims', $1, true), set_config('glb.tag', $2, true)", [
    JSON.stringify({ sub: fx.admin, role }),
    TAG,
  ]);
  await a.c.query(`set local role ${role}`);
}
function settle(p: Promise<{ rows: unknown[]; rowCount: number | null }>): Promise<Out> {
  return p.then(
    (r) => ({ ok: true as const, rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code ?? "?", msg: e.message ?? String(e) }),
  );
}
/** Run one statement and track whether it has answered (for mustWait). */
function call(a: Actor, sql: string, params: unknown[] = []): Promise<Out> {
  a.settled = false;
  return settle(a.c.query(sql, params)).then((o) => {
    a.settled = true;
    return o;
  });
}
/** End the transaction the moment its own call answers: commit on success, roll back on refusal. */
async function end(a: Actor, o: Out): Promise<Out> {
  try {
    await a.c.query(o.ok ? "commit" : "rollback");
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "end-failed", msg: err.message ?? String(e) };
  }
  return o;
}
function andEnd(a: Actor, p: Promise<Out>): Promise<Out> {
  return p.then((o) => end(a, o));
}
async function closeAll(): Promise<void> {
  for (const c of open.splice(0)) {
    if (c === monitor) continue;
    await c.query("rollback").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
  open.push(monitor);
}
const val = (o: Out, key: string): unknown => (o.ok ? o.rows[0]?.[key] : `${o.code}: ${o.msg}`);
function expectOk(o: Out, label: string): void {
  if (!o.ok) throw new Fail(`${label}: refused ${o.code} (${o.msg})`);
}
function rowsOf(o: Out): number {
  return o.ok ? o.rowCount : -1;
}
const q = (sql: string, params: unknown[] = []) => monitor.query(sql, params);
const num = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q(sql, params)).rows[0]!.n);

// ---------------------------------------------------------------------------
// Interleaving control (pg_locks, THIS backend only)
// ---------------------------------------------------------------------------
/** What `pid` is queued on right now: a row lock (transactionid / tuple), something else, or nothing. */
async function waitingOn(pid: number): Promise<"row" | "other" | null> {
  const { rows } = await monitor.query<{ locktype: string }>("select locktype from pg_locks where pid = $1 and not granted", [pid]);
  if (rows.length === 0) return null;
  if (rows.some((r) => r.locktype === "transactionid" || r.locktype === "tuple")) return "row";
  return "other";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The actor's in-flight call must be seen queued on a row lock within ~5s, and must not have answered. */
async function mustWait(a: Actor, why: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = "no lock wait";
  while (Date.now() < deadline) {
    if (a.settled) throw new Fail(`interleaving not reached: ${a.name} answered without waiting (${why})`);
    const w = await waitingOn(a.pid);
    if (w === "row") return;
    if (w) last = `waiting on ${w}`;
    await sleep(25);
  }
  throw new Fail(`interleaving not reached: ${a.name} never waited on a row lock (${why}); saw ${last}`);
}
/** Which relations' tuple locks `pid` holds (a row-lock waiter holds the tuple lock of the row it queues on). */
async function tupleRelations(pid: number): Promise<string[]> {
  const { rows } = await monitor.query<{ rel: string }>(
    "select distinct relation::regclass::text as rel from pg_locks where pid = $1 and locktype = 'tuple' and relation is not null",
    [pid],
  );
  return rows.map((r) => r.rel);
}

/** First caller runs (its transaction stays open); second starts and must queue; first ends; second ends. */
async function forced(opts: {
  whoA: Who;
  whoB: Who;
  first: (a: Actor) => Promise<Out>;
  second: (b: Actor) => Promise<Out>;
  why: string;
  /** Relation whose tuple the waiter must be queued on. */
  rel?: string;
  during?: (a: Actor, b: Actor) => Promise<void>;
}): Promise<{ o1: Out; o2: Out }> {
  const [a, b] = [await actor("first", opts.whoA), await actor("second", opts.whoB)];
  await begin(a);
  const r1 = await opts.first(a);
  expectOk(r1, "first caller");
  await begin(b);
  const p2 = andEnd(b, opts.second(b));
  await mustWait(b, opts.why);
  if (opts.rel) {
    const rels = await tupleRelations(b.pid);
    expect(rels.includes(opts.rel), `the waiter is queued on ${JSON.stringify(rels)}, not ${opts.rel}`);
  }
  if (opts.during) await opts.during(a, b);
  const o1 = await end(a, r1);
  const o2 = await p2;
  return { o1, o2 };
}

// ---------------------------------------------------------------------------
// Fixtures (committed, as postgres)
// ---------------------------------------------------------------------------
/** Every id this run minted that a leftover check can look up by primary key. */
const made = { ids: [] as string[] };
const mint = (): string => {
  const id = randomUUID();
  made.ids.push(id);
  return id;
};
const today = "(now() at time zone 'Asia/Manila')::date";

async function seed(): Promise<void> {
  const shift = await q("select id from public.cash_shifts where is_active order by sort_order, code limit 1");
  if (shift.rowCount === 0) throw new Error("no active cash_shifts row on this stack - the cash-adjustment fixtures need one");
  fx.shift = shift.rows[0]!.id as string;
  const contra = await q("select id from public.chart_of_accounts where code = '6420'");
  if (contra.rowCount === 0) throw new Error("chart_of_accounts has no 6420 on this stack");
  fx.contra = contra.rows[0]!.id as string;
  await q("begin");
  try {
    await q(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
      [fx.admin, `${TAG}-a@glb.example.test`],
    );
    await q("insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, 'admin', true)", [fx.admin, `${TAG} Admin`]);
    await q("insert into public.services (id, code, name, price_php, kind) values ($1, $2, $3, 1000, 'lab_test')", [fx.svcLab, `${TAG_UP}-LAB`, `${TAG} lab test`]);
    await q("insert into public.services (id, code, name, price_php, kind) values ($1, $2, $3, 1000, 'doctor_consultation')", [fx.svcDoc, `${TAG_UP}-DOC`, `${TAG} consultation`]);
    await q("insert into public.physicians (id, slug, full_name, specialty) values ($1, $2, $3, 'glb')", [fx.physician, `${TAG}-dr`, `${TAG} Dr`]);
    await q("insert into public.patients (id, drm_id, first_name, last_name, birthdate) values ($1, $2, 'Glb', 'Fixture', '1990-01-01')", [fx.patient, `DRM-${TAG_UP}`]);
    await q("insert into public.hmo_providers (id, name) values ($1, $2)", [fx.provider, `${TAG} HMO`]);
    await q("commit");
  } catch (e) {
    await q("rollback").catch(() => undefined);
    throw e;
  }
}

async function mkVisit(total: number, note: string): Promise<string> {
  seq += 1;
  const id = mint();
  await q(
    `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, notes)
     values ($1, $2, $3, ${today}, 'unpaid', $4, 0, $5)`,
    [id, `V-${TAG_UP}-${seq}`, fx.patient, total, `${TAG} ${note}`],
  );
  return id;
}
async function mkPaymentOn(visit: string, amount: number): Promise<string> {
  const id = mint();
  await q("insert into public.payments (id, visit_id, amount_php, method, received_by, notes) values ($1, $2, $3, 'cash', $4, $5)", [id, visit, amount, fx.admin, TAG]);
  return id;
}

// ---- the three source tables -------------------------------------------------
interface Ctx {
  id: string;
  [k: string]: string;
}
interface Src {
  name: string;
  /** journal_entries.source_kind of the source's own entry. */
  kind: string;
  table: string;
  /** Context rows committed, the source row not yet inserted. */
  fresh(): Promise<Ctx>;
  /** The app's insert of the source row (explicit id). */
  ins(c: Ctx): [string, unknown[]];
  /** The app's void UPDATE (with its own `voided_at is null` guard). */
  voidSql(c: Ctx): [string, unknown[]];
}
const PAY: Src = {
  name: "payment",
  kind: "payment",
  table: "payments",
  async fresh() {
    const visit = await mkVisit(1000, "payment");
    return { id: mint(), visit };
  },
  ins: (c) => [
    "insert into public.payments (id, visit_id, amount_php, method, received_by, notes) values ($1, $2, 1000, 'cash', $3, $4)",
    [c.id, c.visit, fx.admin, TAG],
  ],
  // payments/[id]/void/actions.ts, verbatim WHERE guards.
  voidSql: (c) => [
    `update public.payments set voided_at = now(), voided_by = $2, void_reason = 'Recorded twice: glb proof'
      where id = $1 and voided_at is null returning id`,
    [c.id, fx.admin],
  ],
};
const CASH: Src = {
  name: "cash adjustment",
  kind: "cash_adjustment",
  table: "eod_cash_adjustments",
  async fresh() {
    return { id: mint() };
  },
  // postTillCashExpense's insert.
  ins: (c) => [
    `insert into public.eod_cash_adjustments (id, business_date, shift_id, kind, amount_php, payee, contra_account_id, notes, recorded_by)
     values ($1, ${today}, $2, 'petty_cash', 50, 'glb vendor', $3, $4, $5)`,
    [c.id, fx.shift, fx.contra, TAG, fx.admin],
  ],
  // voidTillCashExpense's UPDATE.
  voidSql: (c) => [
    `update public.eod_cash_adjustments set voided_at = now(), voided_by = $2, void_reason = 'glb proof void'
      where id = $1 and kind = 'petty_cash' and voided_at is null returning id`,
    [c.id, fx.admin],
  ],
};
/** A claim item billed 100 on a fresh visit line + batch (no resolution yet). */
async function mkHmoItem(): Promise<{ item: string; batch: string }> {
  const visit = await mkVisit(1000, "hmo");
  const line = mint();
  const batch = mint();
  const item = mint();
  await q(
    `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
     values ($1, $2, $3, 'requested', $4, 1000, 1000)`,
    [line, visit, fx.svcLab, fx.admin],
  );
  await q("insert into public.hmo_claim_batches (id, provider_id, status, reference_no) values ($1, $2, 'submitted', $3)", [batch, fx.provider, `${TAG}-${seq}`]);
  await q("insert into public.hmo_claim_items (id, batch_id, test_request_id, billed_amount_php) values ($1, $2, $3, 100)", [item, batch, line]);
  return { item, batch };
}
const hmoIns = (id: string, item: string, amount: number): [string, unknown[]] => [
  "insert into public.hmo_claim_resolutions (id, item_id, destination, amount_php, resolved_by) values ($1, $2, 'patient_bill', $3, $4)",
  [id, item, amount, fx.admin],
];
const HMO: Src = {
  name: "HMO resolution",
  kind: "hmo_claim_resolution",
  table: "hmo_claim_resolutions",
  async fresh() {
    const { item, batch } = await mkHmoItem();
    return { id: mint(), item, batch };
  },
  ins: (c) => hmoIns(c.id, c.item!, 40),
  // hmo-claims/actions.ts voidHmoResolution.
  voidSql: (c) => [
    `update public.hmo_claim_resolutions set voided_at = now(), voided_by = $2, void_reason = 'glb proof void'
      where id = $1 and voided_at is null returning item_id`,
    [c.id, fx.admin],
  ],
};
/** The source row exists and its bridge has posted its JE. */
async function mkSrc(s: Src): Promise<Ctx> {
  const c = await s.fresh();
  const [sql, params] = s.ins(c);
  await q(sql, params);
  expect((await jeState(s.kind, c.id)).posted === 1, `${s.name} fixture: the insert bridge did not post a JE`);
  return c;
}
/** Remove the source row WITHOUT its delete bridge (replica role: local, this transaction only), keeping its JE posted. */
async function dropKeepingJe(s: Src, c: Ctx): Promise<void> {
  await q("begin");
  try {
    await q("set local session_replication_role = replica");
    await q(`delete from public.${s.table} where id = $1`, [c.id]);
    await q("commit");
  } catch (e) {
    await q("rollback").catch(() => undefined);
    throw e;
  }
  expect((await jeState(s.kind, c.id)).posted === 1, "the replayed id's JE must still be posted");
}

// ---- test-request lines -------------------------------------------------------
interface Line {
  id: string;
  visit: string;
  doc: boolean;
}
/**
 * A visit with ONE line, paid in full (so it can be released) unless `unpaid`. A doctor line carries clinic fee
 * 400 + doctor PF 600 and an attending physician (the release bridge accrues PF for it). `release` releases it as
 * postgres AFTER payment so the bridge posts its JE exactly as in production.
 */
async function mkLine(o: { doc?: boolean; release?: boolean; unpaid?: boolean; price?: number }): Promise<Line> {
  const doc = o.doc === true;
  const price = o.price ?? 1000;
  const visit = await mkVisit(price, doc ? "doc line" : "lab line");
  const id = mint();
  await q("begin");
  try {
    await q(
      `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php, clinic_fee_php, doctor_pf_php, attending_physician_id)
       values ($1, $2, $3, 'requested', $4, $5, $5, $6, $7, $8)`,
      [id, visit, doc ? fx.svcDoc : fx.svcLab, fx.admin, price, doc ? 400 : null, doc ? 600 : null, doc ? fx.physician : null],
    );
    if (!o.unpaid) await mkPaymentOn(visit, price);
    await q("update public.test_requests set status = 'ready_for_release' where id = $1", [id]);
    if (o.release) {
      await q("update public.test_requests set status = 'released', released_at = now(), released_by = $2, release_medium = 'other' where id = $1", [id, fx.admin]);
    }
    await q("commit");
  } catch (e) {
    await q("rollback").catch(() => undefined);
    throw e;
  }
  return { id, visit, doc };
}
/** A visit of two unpaid lab lines (500 each), ready for release, not waived. */
async function mkTwoLines(): Promise<{ visit: string; lines: [string, string] }> {
  const visit = await mkVisit(1000, "two lines");
  const lines = [mint(), mint()].sort() as [string, string];
  for (const id of lines) {
    await q(
      `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
       values ($1, $2, $3, 'ready_for_release', $4, 500, 500)`,
      [id, visit, fx.svcLab, fx.admin],
    );
  }
  return { visit, lines };
}
const waiveRpc = (a: Actor, visit: string) => call(a, "select public.waive_visit_balance($1::uuid, $2::uuid, 'glb proof') as r", [visit, fx.admin]);
/** mkTwoLines + the real waive_visit_balance committed (an unrecognised allocation of 500 per line). */
async function mkWaived(): Promise<{ visit: string; lines: [string, string] }> {
  const w = await mkTwoLines();
  const a = await actor("setup-waive", "svc");
  await begin(a);
  expectOk(await end(a, await waiveRpc(a, w.visit)), "waive fixture");
  const al = await q("select amount_php from public.visit_waiver_allocations where visit_id = $1 order by test_request_id", [w.visit]);
  eq("allocations", al.rows.map((r) => Number(r.amount_php)), [500, 500]);
  return w;
}

// ---------------------------------------------------------------------------
// Calls, exactly as the app issues them
// ---------------------------------------------------------------------------
const releaseRpc = (a: Actor, visit: string, ids: string[]) =>
  call(a, "select public.release_visit_results($1::uuid, $2::uuid[], 'email') as r", [visit, ids]);
const undoRpc = (a: Actor, visit: string, ids: string[]) =>
  call(a, "select public.undo_visit_release($1::uuid, $2::uuid[], null, null, 'glb proof') as r", [visit, ids]);
// visits/[id]/actions.ts markConsultationDone: same WHERE, session (authenticated) client.
const markDone = (a: Actor, l: Line) =>
  call(
    a,
    `update public.test_requests set status = 'released', released_at = now(), released_by = $3, release_medium = 'other'
      where id = $1 and visit_id = $2 and status in ('requested', 'in_progress', 'ready_for_release') returning id`,
    [l.id, l.visit, fx.admin],
  );
/** A release UPDATE without the app's status guard (an operator's / script's write). */
const releaseUnguarded = (a: Actor, l: Line) =>
  call(a, "update public.test_requests set status = 'released', released_at = now(), released_by = $2, release_medium = 'other' where id = $1 returning id", [l.id, fx.admin]);
/** The release a line of this kind goes through in the app. */
const releaseOf = (a: Actor, l: Line) => (l.doc ? markDone(a, l) : releaseRpc(a, l.visit, [l.id]));
const cancelLine = (a: Actor, id: string) => call(a, "update public.test_requests set status = 'cancelled' where id = $1 returning id", [id]);
const jeWriter = (a: Actor, kind: string, id: string) =>
  call(a, `update public.journal_entries set status = 'reversed' where source_kind = '${kind}' and source_id = $1 and status = 'posted'`, [id]);

// ---------------------------------------------------------------------------
// Committed-state readers and assertions
// ---------------------------------------------------------------------------
async function jeState(kind: string, id: string): Promise<{ posted: number; reversed: number; reversals: number; total: number }> {
  const r = await q(
    `select count(*) filter (where status = 'posted')::int as posted,
            count(*) filter (where status = 'reversed')::int as reversed,
            count(*)::int as total,
            (select count(*)::int from public.journal_entries x
              where x.source_kind = 'reversal' and x.reverses in (select y.id from public.journal_entries y where y.source_kind = $1 and y.source_id = $2)) as reversals
       from public.journal_entries where source_kind = $1 and source_id = $2`,
    [kind, id],
  );
  const row = r.rows[0]!;
  return { posted: Number(row.posted), reversed: Number(row.reversed), reversals: Number(row.reversals), total: Number(row.total) };
}
/** Exactly one source JE, reversed exactly once by a posted mirror entry. */
async function assertOneReversal(kind: string, id: string, label: string): Promise<void> {
  const orig = await q("select id, status, reversed_by from public.journal_entries where source_kind = $1 and source_id = $2", [kind, id]);
  eq(`${label}: ${kind} journal entries`, orig.rowCount, 1);
  const rev = await q("select id, status from public.journal_entries where source_kind = 'reversal' and reverses = $1", [orig.rows[0]!.id]);
  eq(`${label}: reversal entries of the JE`, rev.rowCount, 1);
  eq(`${label}: reversal posted`, rev.rows[0]!.status, "posted");
  eq(`${label}: original reversed`, orig.rows[0]!.status, "reversed");
  eq(`${label}: original points at the reversal`, orig.rows[0]!.reversed_by, rev.rows[0]!.id);
  const off = await q(
    "select account_id from public.journal_lines where entry_id in ($1, $2) group by account_id having sum(debit_php - credit_php) <> 0",
    [orig.rows[0]!.id, rev.rows[0]!.id],
  );
  eq(`${label}: the reversal mirrors every line`, off.rowCount, 0);
}
const lineStatus = async (id: string): Promise<string> => String((await q("select status from public.test_requests where id = $1", [id])).rows[0]!.status);
const livePf = (id: string) => num("select count(*)::int as n from public.doctor_pf_entries where test_request_id = $1 and voided_at is null", [id]);
const allPf = (id: string) => num("select count(*)::int as n from public.doctor_pf_entries where test_request_id = $1", [id]);

/**
 * The ledger of one line, whatever raced: a posted release JE iff the line is released (never two), every
 * reversed entry has exactly one posted mirror, net revenue = the live entry's own, PF accrued iff released
 * and pointing at the live entry.
 */
async function lineInvariants(l: Line, label: string): Promise<string> {
  const st = await lineStatus(l.id);
  const jes = (await q("select id, status, reversed_by from public.journal_entries where source_kind = 'test_request' and source_id = $1", [l.id])).rows;
  const posted = jes.filter((j) => j.status === "posted");
  const reversed = jes.filter((j) => j.status === "reversed");
  eq(`${label}: posted release JEs (line is ${st})`, posted.length, st === "released" ? 1 : 0);
  const revs = (await q("select id, status, reverses from public.journal_entries where source_kind = 'reversal' and reverses = any($1::uuid[])", [jes.map((j) => j.id)])).rows;
  eq(`${label}: one reversal per reversed entry`, revs.length, reversed.length);
  for (const r of revs) expect(r.status === "posted", `${label}: a reversal is ${r.status}`);
  for (const j of reversed) expect(revs.some((r) => r.id === j.reversed_by && r.reverses === j.id), `${label}: a reversed JE does not point at its own reversal`);
  const net = (ids: string[]) =>
    num(
      `select coalesce(sum(l.credit_php - l.debit_php), 0)::float8 as n
         from public.journal_lines l join public.chart_of_accounts a on a.id = l.account_id
        where a.code like '4%' and l.entry_id = any($1::uuid[])`,
      [ids],
    );
  eq(
    `${label}: net revenue of the line's entries equals the live entry's own`,
    await net([...jes.map((j) => j.id as string), ...revs.map((r) => r.id as string)]),
    await net(posted.map((j) => j.id as string)),
  );
  if (l.doc) {
    eq(`${label}: live PF accruals`, await livePf(l.id), st === "released" ? 1 : 0);
    if (st === "released") {
      const pf = await q("select journal_entry_id from public.doctor_pf_entries where test_request_id = $1 and voided_at is null", [l.id]);
      eq(`${label}: the PF accrual points at the live release JE`, pf.rows[0]!.journal_entry_id, posted[0]!.id);
    }
  }
  return st;
}

// ---------------------------------------------------------------------------
// Generic scenarios over the three source tables
// ---------------------------------------------------------------------------
/** void x void: the second queues on the SOURCE row, then matches nothing; one reversal. */
async function sVoidVoid(s: Src): Promise<void> {
  const c = await mkSrc(s);
  const { o1, o2 } = await forced({
    whoA: "svc",
    whoB: "svc",
    first: (a) => call(a, ...s.voidSql(c)),
    second: (b) => call(b, ...s.voidSql(c)),
    rel: s.table,
    why: `the second void queues on the ${s.name} row the first holds`,
    during: async (_a, b) => {
      const rels = await tupleRelations(b.pid);
      expect(!rels.includes("journal_entries"), `the waiter queued on journal_entries, not the ${s.name} row (${JSON.stringify(rels)})`);
    },
  });
  expectOk(o1, "first void");
  expectOk(o2, "second void");
  eq("the second void matched nothing", rowsOf(o2), 0);
  await assertOneReversal(s.kind, c.id, "void then void");
}
/**
 * void x a direct JE writer (the model's B4 shape): the writer holds the source's JE (about to mark it reversed)
 * while the source is voided. The bridge must WAIT on the entry and re-check status = 'posted', adding NO
 * reversal. Without the FOR UPDATE it reads the stale 'posted' entry; without the status filter it re-reads the
 * now-reversed entry - either way it reverses an already-reversed entry.
 */
async function sVoidWriter(s: Src): Promise<void> {
  const c = await mkSrc(s);
  const [w, b] = [await actor("je-writer", "raw"), await actor("voider", "svc")];
  await w.c.query("begin");
  const r1 = await jeWriter(w, s.kind, c.id);
  expectOk(r1, "je writer");
  eq("the writer touched one entry", rowsOf(r1), 1);
  await begin(b);
  const p2 = andEnd(b, call(b, ...s.voidSql(c)));
  await mustWait(b, "the bridge queues on the journal entry the writer holds");
  const rels = await tupleRelations(b.pid); // asserted after the outcome, so a mutant dies on the duplicate reversal
  expectOk(await end(w, r1), "je writer end");
  const o2 = await p2;
  expectOk(o2, "void");
  eq("the void updated the source row", rowsOf(o2), 1);
  eq("no second reversal of an entry the writer already reversed", (await jeState(s.kind, c.id)).reversals, 0);
  expect(rels.includes("journal_entries"), `the voider queued on ${JSON.stringify(rels)}, not journal_entries`);
}
/** insert x insert of ONE id: the loser waits on the unique index, then 23505; one row, one posted JE. */
async function sDupInsert(s: Src): Promise<void> {
  const c = await s.fresh();
  const { o1, o2 } = await (async () => {
    const [a, b] = [await actor("first", "svc"), await actor("second", "svc")];
    await begin(a);
    const r1 = await call(a, ...s.ins(c));
    expectOk(r1, "first insert");
    await begin(b);
    const p2 = andEnd(b, call(b, ...s.ins(c)));
    await mustWait(b, "the second insert queues on the first's uncommitted primary key");
    return { o1: await end(a, r1), o2: await p2 };
  })();
  expectOk(o1, "first insert end");
  expect(!o2.ok && o2.code === "23505", `second insert: expected 23505, got ${JSON.stringify(o2)}`);
  eq("source rows", await num(`select count(*)::int as n from public.${s.table} where id = $1`, [c.id]), 1);
  eq("posted JEs", (await jeState(s.kind, c.id)).posted, 1);
  eq("total JEs", (await jeState(s.kind, c.id)).total, 1);
}
/**
 * insert x a direct JE writer, on a replayed id: the source row is gone (restored backup / replay) but its JE is
 * still posted. The writer holds that JE while the row is re-inserted: the bridge must WAIT, see the entry
 * reversed, and post a fresh one - exactly one posted JE for the source. Without the FOR UPDATE it trusts the
 * stale 'posted' entry and posts nothing; without the status filter it re-reads the reversed entry and posts nothing.
 */
async function sInsertWriter(s: Src): Promise<void> {
  const c = await mkSrc(s);
  await dropKeepingJe(s, c);
  const [w, b] = [await actor("je-writer", "raw"), await actor("inserter", "svc")];
  await w.c.query("begin");
  const r1 = await jeWriter(w, s.kind, c.id);
  expectOk(r1, "je writer");
  eq("the writer touched one entry", rowsOf(r1), 1);
  await begin(b);
  const p2 = andEnd(b, call(b, ...s.ins(c)));
  // Soft wait: a bridge without the lock answers at once (and posts nothing) - judge that on the OUTCOME too, below.
  const waited = await mustWait(b, "the insert bridge queues on the journal entry the writer holds").then(
    () => true,
    () => false,
  );
  const rels = waited ? await tupleRelations(b.pid) : [];
  expectOk(await end(w, r1), "je writer end");
  const o2 = await p2;
  expectOk(o2, "re-insert");
  const st = await jeState(s.kind, c.id);
  eq("posted JEs for the re-inserted source (the writer reversed the old one)", st.posted, 1);
  eq("reversed JEs", st.reversed, 1);
  expect(waited, "interleaving not reached: the inserter answered without waiting on the journal entry the writer holds");
  expect(rels.includes("journal_entries"), `the inserter queued on ${JSON.stringify(rels)}, not journal_entries`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
type Scenario = () => Promise<void>;
const KNOWN_IDS = new Set(["K1a", "K1b"]);
const scenarios: Record<string, Scenario> = {
  // concurrency-proof: bridge_payment_void (P1 void x void - the second queues on the PAYMENT row, one reversal)
  P1: () => sVoidVoid(PAY),
  // concurrency-proof: bridge_payment_void (P2 void x a direct JE writer holding the payment's entry)
  P2: () => sVoidWriter(PAY),
  // concurrency-proof: bridge_payment_insert (P3a Edit payment inserts the new row and voids the old one in ONE transaction while a plain void of the old row queues)
  // concurrency-proof: bridge_payment_void (P3a the Edit's void of the old row races the plain void)
  async P3a() {
    const c = await mkSrc(PAY);
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) =>
        call(a, "select public.correct_payment(p_payment_id := $1::uuid, p_amount_php := 800, p_method := 'cash', p_reference_number := null, p_notes := null, p_reason := 'glb proof edit', p_actor_id := $2::uuid, p_expected := $3::jsonb) as id", [
          c.id,
          fx.admin,
          JSON.stringify({ amount_php: 1000, visit_id: c.visit }),
        ]),
      second: (b) => call(b, ...PAY.voidSql(c)),
      rel: "payments",
      why: "the plain void queues on the payment row the Edit holds",
    });
    expectOk(o1, "edit");
    expectOk(o2, "void");
    eq("the plain void matched nothing (the Edit already voided the row)", rowsOf(o2), 0);
    await assertOneReversal("payment", c.id, "edit x void: old row");
    const nid = String(val(o1, "id"));
    made.ids.push(nid);
    const st = await jeState("payment", nid);
    eq("the new payment's JE", [st.posted, st.total, st.reversals], [1, 1, 0]);
    eq("live payments of the visit", await num("select count(*)::int as n from public.payments where visit_id = $1 and voided_at is null", [c.visit]), 1);
  },
  // concurrency-proof: bridge_payment_void (P3b the plain void first, then the Edit queues on the payment row and is refused P0054)
  async P3b() {
    const c = await mkSrc(PAY);
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => call(a, ...PAY.voidSql(c)),
      second: (b) =>
        call(b, "select public.correct_payment(p_payment_id := $1::uuid, p_amount_php := 800, p_method := 'cash', p_reference_number := null, p_notes := null, p_reason := 'glb proof edit', p_actor_id := $2::uuid, p_expected := $3::jsonb) as id", [
          c.id,
          fx.admin,
          JSON.stringify({ amount_php: 1000, visit_id: c.visit }),
        ]),
      rel: "payments",
      why: "the Edit queues on the payment row the void holds",
    });
    expectOk(o1, "void");
    expect(!o2.ok && o2.code === "P0054", `Edit after a void: expected P0054, got ${JSON.stringify(o2)}`);
    await assertOneReversal("payment", c.id, "void then edit");
    eq("no replacement payment", await num("select count(*)::int as n from public.payments where visit_id = $1 and voided_at is null", [c.visit]), 0);
  },
  // concurrency-proof: bridge_payment_insert (P4 two inserts of one payment id: the loser waits on the unique index, one JE)
  P4: () => sDupInsert(PAY),
  // concurrency-proof: bridge_payment_insert (P5 re-insert of a payment id whose JE is held by a direct writer)
  P5: () => sInsertWriter(PAY),
  // concurrency-proof: bridge_payment_insert (P7 the visit gains an HMO provider while a payment is being recorded: the insert queues on the visit row and its JE debits AR - HMO)
  async P7() {
    const visit = await mkVisit(1000, "p7");
    const id = mint();
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => call(a, "update public.visits set hmo_provider_id = $2 where id = $1", [visit, fx.provider]),
      second: (b) => call(b, ...PAY.ins({ id, visit })),
      rel: "visits",
      why: "the payment insert queues on the visit row the update holds",
    });
    expectOk(o1, "visit update");
    expectOk(o2, "payment insert");
    const dr = await q(
      `select a.code from public.journal_lines l join public.chart_of_accounts a on a.id = l.account_id
        where l.entry_id = (select id from public.journal_entries where source_kind = 'payment' and source_id = $1 and status = 'posted') and l.credit_php > 0`,
      [id],
    );
    eq("the payment's credit side is AR - HMO (the visit's committed state), not AR - Patients", dr.rows.map((r) => r.code), ["1110"]);
  },
  // concurrency-proof: bridge_payment_insert (P8a a visit delete in flight x a payment insert)
  async P8a() {
    const visit = await mkVisit(1000, "p8a");
    const id = mint();
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => call(a, "update public.visits set deleted_at = now(), deleted_by = $2, delete_reason = 'glb proof' where id = $1 and deleted_at is null returning id", [visit, fx.admin]),
      second: (b) => call(b, ...PAY.ins({ id, visit })),
      rel: "visits",
      why: "the payment insert queues on the visit row the delete holds",
    });
    expectOk(o1, "visit delete");
    // enforce_no_payment_on_deleted_visit (P0045) reads visits.deleted_at before the visit lock, so a payment that was
    // already past it is stopped by recalc_visit_payment (P0046) once the lock is granted and the visit reads deleted:
    // the whole insert, JE included, rolls back.
    expect(!o2.ok && (o2.code === "P0045" || o2.code === "P0046"), `payment behind a visit delete: expected P0045/P0046, got ${JSON.stringify(o2)}`);
    eq("no payment row", await num("select count(*)::int as n from public.payments where id = $1", [id]), 0);
    eq("no JE", (await jeState("payment", id)).total, 0);
  },
  // concurrency-proof: bridge_payment_insert (P8b a payment insert in flight x a visit delete)
  async P8b() {
    const visit = await mkVisit(1000, "p8b");
    const id = mint();
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => call(a, ...PAY.ins({ id, visit })),
      second: (b) => call(b, "update public.visits set deleted_at = now(), deleted_by = $2, delete_reason = 'glb proof' where id = $1 and deleted_at is null returning id", [visit, fx.admin]),
      rel: "visits",
      why: "the visit delete queues on the visit row the payment holds",
    });
    expectOk(o1, "payment insert");
    expect(!o2.ok, `visit delete behind a payment: expected a refusal, got ${JSON.stringify(o2)}`);
    const v = (await q("select deleted_at is not null as d from public.visits where id = $1", [visit])).rows[0]!;
    eq("the visit is not deleted", v.d, false);
    eq("payment JE", (await jeState("payment", id)).posted, 1);
  },
  // concurrency-proof: bridge_payment_insert (P6 free race: inserts, voids and Edits of payments on one visit)
  // concurrency-proof: bridge_payment_void (P6 free race)
  async P6() {
    for (let i = 0; i < ROUNDS; i++) {
      const visit = await mkVisit(3000, "p6");
      const [p1, p2] = [await mkPaymentOn(visit, 1000), await mkPaymentOn(visit, 1000)];
      const ops: Array<(a: Actor) => Promise<Out>> = [
        (a) => call(a, ...PAY.voidSql({ id: p1, visit })),
        (a) => call(a, ...PAY.voidSql({ id: p1, visit })),
        (a) => call(a, "select public.correct_payment(p_payment_id := $1::uuid, p_amount_php := 700, p_method := 'cash', p_reference_number := null, p_notes := null, p_reason := 'glb p6', p_actor_id := $2::uuid, p_expected := null) as id", [p2, fx.admin]),
        (a) => call(a, ...PAY.ins({ id: mint(), visit })),
      ];
      const acts = await Promise.all(ops.map((_, k) => actor(`r${k}`, "svc")));
      const outs = await Promise.all(
        acts.map(async (a, k) => {
          await begin(a);
          return andEnd(a, ops[k]!(a));
        }),
      );
      for (const [k, o] of outs.entries()) {
        // The only legal refusal is the Edit of a payment that is no longer live.
        if (!o.ok) expect(o.code === "P0054" && k === 2, `round ${i} racer ${k}: ${o.code} ${o.msg}`);
        else if (k === 2) made.ids.push(String(val(o, "id")));
      }
      const pays = (await q("select id, voided_at is not null as voided from public.payments where visit_id = $1", [visit])).rows;
      for (const p of pays) {
        const st = await jeState("payment", p.id as string);
        if (p.voided) eq(`round ${i}: voided payment ${String(p.id).slice(0, 6)} JE`, [st.posted, st.reversed, st.reversals], [0, 1, 1]);
        else eq(`round ${i}: live payment ${String(p.id).slice(0, 6)} JE`, [st.posted, st.reversed, st.reversals], [1, 0, 0]);
      }
      await closeAll();
    }
  },

  // concurrency-proof: bridge_cash_adjustment_void (C1 void x void - the second queues on the adjustment row, one reversal)
  C1: () => sVoidVoid(CASH),
  // concurrency-proof: bridge_cash_adjustment_void (C2 void x a direct JE writer holding the adjustment's entry)
  C2: () => sVoidWriter(CASH),
  // concurrency-proof: bridge_cash_adjustment_insert (C3 two inserts of one adjustment id: the loser waits on the unique index, one JE)
  C3: () => sDupInsert(CASH),
  // concurrency-proof: bridge_cash_adjustment_insert (C4 re-insert of an adjustment id whose JE is held by a direct writer)
  C4: () => sInsertWriter(CASH),

  // concurrency-proof: bridge_hmo_claim_resolution_void (H1 void x void - the second queues on the resolution row, one reversal)
  H1: () => sVoidVoid(HMO),
  // concurrency-proof: bridge_hmo_claim_resolution_void (H2 void x a direct JE writer holding the resolution's entry)
  H2: () => sVoidWriter(HMO),
  // concurrency-proof: bridge_hmo_claim_resolution_insert (H3 two inserts of one resolution id: the loser waits on the unique index, one JE)
  H3: () => sDupInsert(HMO),
  // concurrency-proof: bridge_hmo_claim_resolution_insert (H4 re-insert of a resolution id whose JE is held by a direct writer)
  H4: () => sInsertWriter(HMO),
  // concurrency-proof: bridge_hmo_claim_resolution_insert (H5 two resolutions of 60 on one 100 claim item: the second queues on the BATCH row, then P0011)
  async H5() {
    const { item, batch } = await mkHmoItem();
    const [r1, r2] = [mint(), mint()];
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => call(a, ...hmoIns(r1, item, 60)),
      second: (b) => call(b, ...hmoIns(r2, item, 60)),
      rel: "hmo_claim_batches",
      why: `the second resolution queues on the batch row ${batch.slice(0, 6)} the first holds`,
    });
    expectOk(o1, "first resolution");
    expect(!o2.ok && o2.code === "P0011", `second resolution: expected P0011, got ${JSON.stringify(o2)}`);
    eq("resolutions of the item", await num("select count(*)::int as n from public.hmo_claim_resolutions where item_id = $1", [item]), 1);
    eq("JEs of the first", (await jeState("hmo_claim_resolution", r1)).posted, 1);
    eq("JEs of the refused one", (await jeState("hmo_claim_resolution", r2)).total, 0);
  },

  // concurrency-proof: bridge_test_request_released (T1 doctor line "Mark done" x "Mark done": the second queues on the LINE, one JE, one PF accrual)
  async T1() {
    const l = await mkLine({ doc: true });
    const { o1, o2 } = await forced({
      whoA: "staff",
      whoB: "staff",
      first: (a) => markDone(a, l),
      second: (b) => markDone(b, l),
      rel: "test_requests",
      why: "the second Mark done queues on the line row",
    });
    expectOk(o1, "first Mark done");
    expectOk(o2, "second Mark done");
    eq("the second matched nothing", rowsOf(o2), 0);
    eq("line", await lineInvariants(l, "T1"), "released");
    eq("PF entries ever", await allPf(l.id), 1);
  },
  // concurrency-proof: bridge_test_request_released (T1b lab release x release through release_visit_results)
  async T1b() {
    const l = await mkLine({});
    const { o1, o2 } = await forced({
      whoA: "staff",
      whoB: "staff",
      first: (a) => releaseRpc(a, l.visit, [l.id]),
      second: (b) => releaseRpc(b, l.visit, [l.id]),
      rel: "test_requests",
      why: "the second release queues on the line row the first holds",
    });
    expectOk(o1, "first release");
    expectOk(o2, "second release");
    eq("line", await lineInvariants(l, "T1b"), "released");
  },
  // concurrency-proof: bridge_test_request_released (T2a release x undo of a doctor line: the undo queues, then reverses the JE once and voids the PF accrual)
  async T2a() {
    const l = await mkLine({ doc: true });
    const { o1, o2 } = await forced({
      whoA: "staff",
      whoB: "staff",
      first: (a) => markDone(a, l),
      second: (b) => undoRpc(b, l.visit, [l.id]),
      rel: "test_requests",
      why: "the undo queues on the line row the release holds",
    });
    expectOk(o1, "release");
    expectOk(o2, "undo");
    eq("line", await lineInvariants(l, "T2a"), "ready_for_release");
    await assertOneReversal("test_request", l.id, "release then undo");
    eq("PF entries ever / live", [await allPf(l.id), await livePf(l.id)], [1, 0]);
  },
  // concurrency-proof: bridge_test_request_released (T2b undo x an unguarded release of a doctor line: the release queues, then re-posts ONE new JE and ONE new PF accrual)
  // The app's Mark done carries `status in (requested, in_progress, ready_for_release)`: against a snapshot where the undo has
  // not committed the line is still 'released', matches nothing and returns at once, so it cannot queue. A writer without
  // that status guard (an operator's UPDATE) does queue, which is the interleaving this scenario needs.
  async T2b() {
    const l = await mkLine({ doc: true, release: true });
    const { o1, o2 } = await forced({
      whoA: "staff",
      whoB: "staff",
      first: (a) => undoRpc(a, l.visit, [l.id]),
      second: (b) => releaseUnguarded(b, l),
      rel: "test_requests",
      why: "the release queues on the line row the undo holds",
    });
    expectOk(o1, "undo");
    expectOk(o2, "release");
    eq("the re-release updated the line", rowsOf(o2), 1);
    eq("line", await lineInvariants(l, "T2b"), "released");
    const st = await jeState("test_request", l.id);
    eq("release JEs ever / reversals", [st.total, st.reversals], [2, 1]);
    eq("PF entries ever / live", [await allPf(l.id), await livePf(l.id)], [2, 1]);
  },
  // concurrency-proof: bridge_test_request_released (T2c lab release x undo and undo x release through the RPCs)
  async T2c() {
    const l = await mkLine({});
    const a = await forced({
      whoA: "staff",
      whoB: "staff",
      first: (x) => releaseRpc(x, l.visit, [l.id]),
      second: (y) => undoRpc(y, l.visit, [l.id]),
      rel: "test_requests",
      why: "the undo queues on the line row the release holds",
    });
    expectOk(a.o1, "release");
    expectOk(a.o2, "undo");
    eq("release then undo", await lineInvariants(l, "T2c-1"), "ready_for_release");
    // The line is released a second time by the same pair of calls, then an undo-first race on a RELEASED line.
    const d = await mkLine({ release: true });
    const e = await forced({
      whoA: "staff",
      whoB: "staff",
      first: (x) => undoRpc(x, d.visit, [d.id]),
      second: (y) => releaseRpc(y, d.visit, [d.id]),
      rel: "test_requests",
      why: "the release queues on the line row the undo holds",
    });
    expectOk(e.o1, "undo of a released line");
    expectOk(e.o2, "release behind the undo");
    eq("undo then release", await lineInvariants(d, "T2c-2"), "released");
    const st = await jeState("test_request", d.id);
    eq("release JEs ever / reversals", [st.total, st.reversals], [2, 1]);
  },
  // concurrency-proof: bridge_test_request_cancelled (T3a cancel x undo of a released doctor line: the undo queues; the line ends cancelled, one reversal)
  async T3a() {
    const l = await mkLine({ doc: true, release: true });
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "staff",
      first: (a) => cancelLine(a, l.id),
      second: (b) => undoRpc(b, l.visit, [l.id]),
      rel: "test_requests",
      why: "the undo queues on the line row the cancel holds",
    });
    expectOk(o1, "cancel");
    expect(o2.ok || o2.code === "P0081", `undo behind a cancel: ${JSON.stringify(o2)}`);
    eq("line", await lineInvariants(l, "T3a"), "cancelled");
    await assertOneReversal("test_request", l.id, "cancel then undo");
    eq("PF entries ever / live", [await allPf(l.id), await livePf(l.id)], [1, 0]);
  },
  // concurrency-proof: bridge_test_request_cancelled (T3b undo x an unguarded cancel: the cancel queues on the line, finds ready_for_release and fires no bridge)
  async T3b() {
    const l = await mkLine({ doc: true, release: true });
    const { o1, o2 } = await forced({
      whoA: "staff",
      whoB: "svc",
      first: (a) => undoRpc(a, l.visit, [l.id]),
      second: (b) => cancelLine(b, l.id),
      rel: "test_requests",
      why: "the cancel queues on the line row the undo holds",
    });
    expectOk(o1, "undo");
    expectOk(o2, "cancel");
    eq("line", await lineInvariants(l, "T3b"), "cancelled");
    await assertOneReversal("test_request", l.id, "undo then cancel");
    eq("PF entries ever / live", [await allPf(l.id), await livePf(l.id)], [1, 0]);
  },
  // concurrency-proof: bridge_test_request_cancelled (T4 cancel x cancel of a released line: the second queues on the LINE row, one reversal)
  async T4() {
    const l = await mkLine({ doc: true, release: true });
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => cancelLine(a, l.id),
      second: (b) => cancelLine(b, l.id),
      rel: "test_requests",
      why: "the second cancel queues on the line row",
      during: async (_a, b) => {
        const rels = await tupleRelations(b.pid);
        expect(!rels.includes("journal_entries"), `the waiter queued on journal_entries, not the line (${JSON.stringify(rels)})`);
      },
    });
    expectOk(o1, "first cancel");
    expectOk(o2, "second cancel");
    eq("line", await lineInvariants(l, "T4"), "cancelled");
    await assertOneReversal("test_request", l.id, "cancel then cancel");
  },
  // concurrency-proof: bridge_test_request_cancelled (T5 cancel x a direct JE writer holding the release entry: no second reversal)
  async T5() {
    const l = await mkLine({ doc: true, release: true });
    const [w, b] = [await actor("je-writer", "raw"), await actor("canceller", "svc")];
    await w.c.query("begin");
    const r1 = await jeWriter(w, "test_request", l.id);
    expectOk(r1, "je writer");
    eq("the writer touched one entry", rowsOf(r1), 1);
    await begin(b);
    const p2 = andEnd(b, cancelLine(b, l.id));
    await mustWait(b, "the cancel bridge queues on the journal entry the writer holds");
    const rels = await tupleRelations(b.pid);
    expectOk(await end(w, r1), "je writer end");
    const o2 = await p2;
    expectOk(o2, "cancel");
    eq("no second reversal of an entry the writer already reversed", (await jeState("test_request", l.id)).reversals, 0);
    eq("the line is cancelled", await lineStatus(l.id), "cancelled");
    eq("the PF accrual was voided by the not-found branch", await livePf(l.id), 0);
    expect(rels.includes("journal_entries"), `the canceller queued on ${JSON.stringify(rels)}, not journal_entries`);
  },
  // concurrency-proof: bridge_test_request_released (T6 release x a direct writer holding the waiver allocation: the share is folded into at most one entry)
  async T6() {
    const w = await mkWaived();
    const [aw, b] = [await actor("alloc-writer", "raw"), await actor("releaser", "staff")];
    await aw.c.query("begin");
    const r1 = await call(aw, "update public.visit_waiver_allocations set recognised_at = now() where test_request_id = $1 and recognised_at is null", [w.lines[0]]);
    expectOk(r1, "allocation writer");
    eq("the writer touched one allocation", rowsOf(r1), 1);
    await begin(b);
    const p2 = andEnd(b, releaseRpc(b, w.visit, [w.lines[0]]));
    await mustWait(b, "the release bridge queues on the waiver allocation the writer holds");
    const rels = await tupleRelations(b.pid);
    expectOk(await end(aw, r1), "allocation writer end");
    const o2 = await p2;
    expectOk(o2, "release");
    eq("the line is released", await lineStatus(w.lines[0]), "released");
    const folded = await num(
      `select count(*)::int as n from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
        where e.source_kind = 'test_request' and e.source_id = $1 and l.description = 'Balance waived'`,
      [w.lines[0]],
    );
    eq("the already-recognised share is NOT folded into the release entry again", folded, 0);
    const al = await q("select journal_entry_id from public.visit_waiver_allocations where test_request_id = $1", [w.lines[0]]);
    eq("the allocation was not re-pointed at the release entry", al.rows[0]!.journal_entry_id, null);
    expect(rels.includes("visit_waiver_allocations"), `the releaser queued on ${JSON.stringify(rels)}, not visit_waiver_allocations`);
  },

  // concurrency-proof: bridge_test_request_released (TW1 waive_visit_balance x release: the release queues on the line, then folds the committed waiver share into its entry exactly once)
  async TW1() {
    const w = await mkTwoLines();
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "staff",
      first: (a) => waiveRpc(a, w.visit),
      second: (b) => releaseRpc(b, w.visit, [w.lines[0]]),
      rel: "visits",
      why: "the release queues on the visit row the waiver holds",
    });
    expectOk(o1, "waive");
    expectOk(o2, "release");
    eq("the line is released", await lineStatus(w.lines[0]), "released");
    const je = await q("select id from public.journal_entries where source_kind = 'test_request' and source_id = $1 and status = 'posted'", [w.lines[0]]);
    eq("one release entry", je.rowCount, 1);
    const folded = await q(
      "select debit_php::float8 as d from public.journal_lines where entry_id = $1 and description = 'Balance waived'",
      [je.rows[0]!.id],
    );
    eq("the waived share folded into the release entry", folded.rows.map((r) => r.d), [500]);
    const al = await q("select test_request_id, recognised_at is not null as rec, journal_entry_id from public.visit_waiver_allocations where visit_id = $1 order by test_request_id", [w.visit]);
    const [first, second] = al.rows;
    eq("released line's allocation recognised by the release entry", [first!.test_request_id, first!.rec, first!.journal_entry_id], [w.lines[0], true, je.rows[0]!.id]);
    eq("the other line's allocation is untouched", [second!.test_request_id, second!.rec, second!.journal_entry_id], [w.lines[1], false, null]);
    eq(
      "no standalone waiver entry for the folded share",
      await num("select count(*)::int as n from public.journal_entries where source_kind = 'visit_waiver' and source_id in (select id from public.visit_waiver_allocations where visit_id = $1)", [w.visit]),
      0,
    );
  },

  // concurrency-proof: bridge_test_request_released (T8 free race: release / undo / cancel of one line from three sessions, lab and doctor lines, invariants only)
  // concurrency-proof: bridge_test_request_cancelled (T8 free race)
  async T8() {
    const kinds = ["release", "undo", "cancel"] as const;
    for (let i = 0; i < ROUNDS; i++) {
      const l = await mkLine({ doc: i % 2 === 1, release: Math.random() < 0.5 });
      const picks = [0, 1, 2].map(() => kinds[Math.floor(Math.random() * 3)]!);
      const acts = await Promise.all(picks.map((p, k) => actor(`r${k}`, p === "cancel" ? "svc" : "staff")));
      const outs = await Promise.all(
        acts.map(async (a, k) => {
          await begin(a);
          const p = picks[k];
          return andEnd(a, p === "release" ? releaseOf(a, l) : p === "undo" ? undoRpc(a, l.visit, [l.id]) : cancelLine(a, l.id));
        }),
      );
      // P0081 is the release / undo RPC refusing a call whose line is no longer in the state it needs (nothing is changed).
      outs.forEach((o, k) => {
        if (!o.ok) expect(o.code === "P0081", `round ${i} racer ${k} (${picks[k]}): ${o.code} ${o.msg}`);
      });
      await lineInvariants(l, `round ${i} [${picks.join(",")}]`);
      await closeAll();
    }
  },

  // concurrency-proof: bridge_test_request_cancelled (K1a KNOWN: cancel in flight x the PF payout's entry link - the link has no voided_at guard)
  async K1a() {
    const l = await mkLine({ doc: true, release: true });
    const entry = String((await q("select id from public.doctor_pf_entries where test_request_id = $1 and voided_at is null", [l.id])).rows[0]!.id);
    const disb = await mkDisbursement(600);
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => cancelLine(a, l.id),
      second: (b) => linkEntries(b, disb, [entry]),
      rel: "doctor_pf_entries",
      why: "the payout's link UPDATE queues on the PF entry row the cancel holds",
    });
    expectOk(o1, "cancel");
    expectOk(o2, "link");
    return pfPayoutVerdict(entry, disb, "cancel first, payout link second");
  },
  // concurrency-proof: bridge_test_request_cancelled (K1b KNOWN: the PF payout's entry link in flight x a cancel - the cancel's PF void has no disbursement_id guard)
  async K1b() {
    const l = await mkLine({ doc: true, release: true });
    const entry = String((await q("select id from public.doctor_pf_entries where test_request_id = $1 and voided_at is null", [l.id])).rows[0]!.id);
    const disb = await mkDisbursement(600);
    const { o1, o2 } = await forced({
      whoA: "svc",
      whoB: "svc",
      first: (a) => linkEntries(a, disb, [entry]),
      second: (b) => cancelLine(b, l.id),
      rel: "doctor_pf_entries",
      why: "the cancel bridge's PF void queues on the entry row the payout link holds",
    });
    expectOk(o1, "link");
    expectOk(o2, "cancel");
    return pfPayoutVerdict(entry, disb, "payout link first, cancel second");
  },

  // concurrency-proof: bridge_payment_insert (X1 free race: every bridge at once - payments, cash adjustments, HMO resolutions, releases and undos share the JE number counter and the visit)
  // concurrency-proof: bridge_payment_void (X1 free race)
  // concurrency-proof: bridge_cash_adjustment_insert (X1 free race)
  // concurrency-proof: bridge_cash_adjustment_void (X1 free race)
  // concurrency-proof: bridge_hmo_claim_resolution_insert (X1 free race)
  // concurrency-proof: bridge_hmo_claim_resolution_void (X1 free race)
  // concurrency-proof: bridge_test_request_released (X1 free race)
  async X1() {
    for (let i = 0; i < ROUNDS; i++) {
      // A visit of two lab lines (L1 ready, L2 released), paid in full by two payments of 1000.
      const visit = await mkVisit(2000, "x1");
      const [pa, pb] = [await mkPaymentOn(visit, 1000), await mkPaymentOn(visit, 1000)];
      const [l1, l2] = [mint(), mint()];
      for (const id of [l1, l2]) {
        await q(
          `insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
           values ($1, $2, $3, 'ready_for_release', $4, 1000, 1000)`,
          [id, visit, fx.svcLab, fx.admin],
        );
      }
      await q("update public.test_requests set status = 'released', released_at = now(), released_by = $2, release_medium = 'other' where id = $1", [l2, fx.admin]);
      const adj = await mkSrc(CASH);
      const hmo = await mkSrc(HMO);
      const newAdj = await CASH.fresh();
      const newRes = mint();
      const menu: Array<[string, Who, (a: Actor) => Promise<Out>]> = [
        ["void pa", "svc", (a) => call(a, ...PAY.voidSql({ id: pa, visit }))],
        ["void pb", "svc", (a) => call(a, ...PAY.voidSql({ id: pb, visit }))],
        ["release L1", "staff", (a) => releaseRpc(a, visit, [l1])],
        ["undo L2", "staff", (a) => undoRpc(a, visit, [l2])],
        ["void adj", "svc", (a) => call(a, ...CASH.voidSql(adj))],
        ["new adj", "svc", (a) => call(a, ...CASH.ins(newAdj))],
        ["void res", "svc", (a) => call(a, ...HMO.voidSql(hmo))],
        ["new res", "svc", (a) => call(a, ...hmoIns(newRes, hmo.item!, 30))],
      ];
      const picks = [0, 1, 2, 3, 4].map(() => menu[Math.floor(Math.random() * menu.length)]!);
      const acts = await Promise.all(picks.map((p, k) => actor(`r${k}`, p[1])));
      const outs = await Promise.all(
        acts.map(async (a, k) => {
          await begin(a);
          return andEnd(a, picks[k]![2](a));
        }),
      );
      for (const [k, o] of outs.entries()) {
        // A release after a payment void is refused by the payment gate (23514), and an undo / release RPC whose line
        // is no longer in the state it needs by P0081; nothing else is legal (40P01 / 23505 would be a real defect).
        // Two racers picking a "new ..." op insert the same id: the loser's 23505 is the unique index (P4 / C3 / H3).
        const dupInsert = o.ok ? false : o.code === "23505" && picks[k]![0].startsWith("new");
        if (!o.ok) expect(dupInsert || o.code === "23514" || o.code === "P0045" || o.code === "P0081", `round ${i} racer ${k} (${picks[k]![0]}): ${o.code} ${o.msg}`);
      }
      const label = `round ${i} [${picks.map((p) => p[0]).join(", ")}]`;
      for (const p of [pa, pb]) {
        const voided = (await q("select voided_at is not null as v from public.payments where id = $1", [p])).rows[0]!.v as boolean;
        const st = await jeState("payment", p);
        eq(`${label}: payment JE`, [st.posted, st.reversed, st.reversals], voided ? [0, 1, 1] : [1, 0, 0]);
      }
      for (const [s, c] of [[CASH, adj], [CASH, newAdj], [HMO, hmo]] as Array<[Src, Ctx]>) {
        const row = (await q(`select voided_at is not null as v from public.${s.table} where id = $1`, [c.id])).rows[0];
        if (!row) continue; // the "new" row was never inserted this round
        const st = await jeState(s.kind, c.id);
        eq(`${label}: ${s.name} JE`, [st.posted, st.reversed, st.reversals], row.v ? [0, 1, 1] : [1, 0, 0]);
      }
      if ((await q("select 1 from public.hmo_claim_resolutions where id = $1", [newRes])).rowCount) {
        const row = (await q("select voided_at is not null as v from public.hmo_claim_resolutions where id = $1", [newRes])).rows[0]!;
        const st = await jeState("hmo_claim_resolution", newRes);
        eq(`${label}: new resolution JE`, [st.posted, st.reversed, st.reversals], row.v ? [0, 1, 1] : [1, 0, 0]);
      }
      await lineInvariants({ id: l1, visit, doc: false }, label);
      await lineInvariants({ id: l2, visit, doc: false }, label);
      await closeAll();
    }
  },
};

// ---- the PF payout, step by step as createPfDisbursement issues it ------------
/** Step 2 of createPfDisbursement: the disbursement header (its bridge posts Dr 2110 / Cr cash), committed on its own. */
async function mkDisbursement(total: number): Promise<string> {
  const a = await actor("payout-header", "svc");
  await begin(a);
  const n = await call(a, "select public.next_pf_disbursement_batch_number(extract(year from (now() at time zone 'Asia/Manila'))::smallint) as n");
  expectOk(n, "batch number");
  const id = mint();
  const ins = await call(
    a,
    `insert into public.doctor_pf_disbursements (id, batch_number, physician_id, posted_date, method, total_php, recorded_by, notes)
     values ($1, $2, $3, ${today}, 'cash', $4, $5, $6)`,
    [id, val(n, "n"), fx.physician, total, fx.admin, TAG],
  );
  expectOk(await end(a, ins), "disbursement header");
  eq("the payout header posted its entry", (await jeState("doctor_pf_disbursement", id)).posted, 1);
  return id;
}
/** Step 3: `update doctor_pf_entries set disbursement_id = ... where id in (...)` - no voided_at / disbursement_id guard. */
const linkEntries = (a: Actor, disb: string, ids: string[]) =>
  call(a, "update public.doctor_pf_entries set disbursement_id = $1 where id = any($2::uuid[])", [disb, ids]);
/** A voided entry must never be (or stay) linked to a paid-out disbursement. Reproducing that is the KNOWN issue. */
async function pfPayoutVerdict(entry: string, disb: string, how: string): Promise<void> {
  const e = (await q("select voided_at is not null as voided, disbursement_id from public.doctor_pf_entries where id = $1", [entry])).rows[0]!;
  if (e.voided && e.disbursement_id === disb) {
    const net = await num(
      `select coalesce(sum(l.debit_php - l.credit_php), 0)::float8 as n
         from public.journal_lines l join public.chart_of_accounts a on a.id = l.account_id
        where a.code = '2110' and l.entry_id in (
          select id from public.journal_entries where (source_kind = 'doctor_pf_disbursement' and source_id = $1) or (source_kind = 'test_request' and source_id = (select test_request_id from public.doctor_pf_entries where id = $2))
          union select id from public.journal_entries where source_kind = 'reversal' and reverses in (select id from public.journal_entries where source_kind = 'test_request' and source_id = (select test_request_id from public.doctor_pf_entries where id = $2)))`,
      [disb, entry],
    );
    throw new Known(`${how}: the PF entry ends VOIDED and DISBURSED (the doctor was paid for a cancelled line); the line's 2110 accounts net to a ${net} debit instead of 0`);
  }
  throw new Fail(`${how}: no longer reproduces (entry voided=${String(e.voided)}, disbursement_id=${String(e.disbursement_id)}) - promote K1 to a real scenario`);
}

type Status = "pass" | "known" | "fixed" | "fail";
interface Verdict {
  status: Status;
  msg: string;
}

async function runAll(filter?: Set<string>): Promise<Record<string, Verdict>> {
  const result: Record<string, Verdict> = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    if (aborting) break;
    if (ONLY && !ONLY.has(name)) continue;
    if (filter && !filter.has(name)) continue;
    try {
      await fn();
      result[name] = KNOWN_IDS.has(name) ? { status: "fixed", msg: "did not reproduce" } : { status: "pass", msg: "" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Known) result[name] = { status: "known", msg };
      else result[name] = { status: KNOWN_IDS.has(name) ? "fixed" : "fail", msg };
    }
    const v = result[name]!;
    console.log(`  ${v.status === "pass" ? "ok   " : v.status === "known" ? "KNOWN" : v.status === "fixed" ? "FIXED" : "FAIL "} ${name}${v.msg ? `: ${v.msg}` : ""}`);
    await closeAll();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mutants
// ---------------------------------------------------------------------------
interface Fn {
  name: string;
  /** The migration holding its latest definition (the byte-for-byte fallback if the backup file is lost). */
  migration: string;
}
const FUNCS: Fn[] = [
  { name: "bridge_payment_insert", migration: "0140_manila_posting_dates.sql" },
  { name: "bridge_payment_void", migration: "0140_manila_posting_dates.sql" },
  { name: "bridge_cash_adjustment_insert", migration: "0152_cash_journal_descriptions.sql" },
  { name: "bridge_cash_adjustment_void", migration: "0141_manila_posting_dates_remainder.sql" },
  { name: "bridge_hmo_claim_resolution_insert", migration: "0141_manila_posting_dates_remainder.sql" },
  { name: "bridge_hmo_claim_resolution_void", migration: "0141_manila_posting_dates_remainder.sql" },
  { name: "bridge_test_request_released", migration: "0183_waived_balance_gl.sql" },
  { name: "bridge_test_request_cancelled", migration: "0183_waived_balance_gl.sql" },
];
const sigOf = (name: string) => `public.${name}()`;

type MutKind = "nolock" | "nostatus";
interface Mutant {
  id: string;
  fn: string;
  kind: MutKind;
  note: string;
  mustFail: string[];
  /** Scenarios that must still PASS against the mutant (the source-row lock already serialises them). */
  mustPass?: string[];
}
const NOLOCK = "the journal-entry FOR UPDATE removed";
const NOSTATUS = "the `status = 'posted'` filter removed";
const MUTANTS: Mutant[] = [
  { id: "MPVL", fn: "bridge_payment_void", kind: "nolock", note: NOLOCK, mustFail: ["P2"], mustPass: ["P1", "P3a"] },
  { id: "MPVS", fn: "bridge_payment_void", kind: "nostatus", note: NOSTATUS, mustFail: ["P2"], mustPass: ["P1"] },
  { id: "MPIL", fn: "bridge_payment_insert", kind: "nolock", note: NOLOCK, mustFail: ["P5"], mustPass: ["P4"] },
  { id: "MPIS", fn: "bridge_payment_insert", kind: "nostatus", note: NOSTATUS, mustFail: ["P5"], mustPass: ["P4"] },
  { id: "MCVL", fn: "bridge_cash_adjustment_void", kind: "nolock", note: NOLOCK, mustFail: ["C2"], mustPass: ["C1"] },
  { id: "MCVS", fn: "bridge_cash_adjustment_void", kind: "nostatus", note: NOSTATUS, mustFail: ["C2"], mustPass: ["C1"] },
  { id: "MCIL", fn: "bridge_cash_adjustment_insert", kind: "nolock", note: NOLOCK, mustFail: ["C4"], mustPass: ["C3"] },
  { id: "MCIS", fn: "bridge_cash_adjustment_insert", kind: "nostatus", note: NOSTATUS, mustFail: ["C4"], mustPass: ["C3"] },
  { id: "MHVL", fn: "bridge_hmo_claim_resolution_void", kind: "nolock", note: NOLOCK, mustFail: ["H2"], mustPass: ["H1"] },
  { id: "MHVS", fn: "bridge_hmo_claim_resolution_void", kind: "nostatus", note: NOSTATUS, mustFail: ["H2"], mustPass: ["H1"] },
  { id: "MHIL", fn: "bridge_hmo_claim_resolution_insert", kind: "nolock", note: NOLOCK, mustFail: ["H4"], mustPass: ["H3", "H5"] },
  { id: "MHIS", fn: "bridge_hmo_claim_resolution_insert", kind: "nostatus", note: NOSTATUS, mustFail: ["H4"], mustPass: ["H3", "H5"] },
  { id: "MTCL", fn: "bridge_test_request_cancelled", kind: "nolock", note: NOLOCK, mustFail: ["T5"], mustPass: ["T4", "T3b"] },
  { id: "MTCS", fn: "bridge_test_request_cancelled", kind: "nostatus", note: NOSTATUS, mustFail: ["T5"], mustPass: ["T4", "T3b"] },
  {
    id: "MRA",
    fn: "bridge_test_request_released",
    kind: "nolock",
    note: "the waiver-allocation FOR UPDATE removed (the line lock still serialises every real writer)",
    mustFail: ["T6"],
    mustPass: ["TW1"],
  },
];

async function liveDef(sig: string): Promise<string> {
  return (await monitor.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [sig])).rows[0]!.d;
}
/** The one lock-and-read statement each bridge starts from: `select .. into .. from public.<journal_entries|visit_waiver_allocations> .. for update;`. */
const TARGET = /select [^;]*? into [^;]*?from public\.(?:journal_entries|visit_waiver_allocations)[^;]*?for update;/;

/** The live definition with `kind` applied ONLY inside a transaction that set glb.tag = this run's tag. */
function mutate(def: string, m: Mutant): string {
  const hit = TARGET.exec(def);
  if (!hit) throw new Error(`${m.id}: the live ${m.fn} no longer holds a lock-and-read statement this runner knows - update TARGET`);
  const orig = hit[0];
  const variant = m.kind === "nolock" ? orig.replace(/\s*for update;$/, ";") : orig.replace(/\n\s*and status = 'posted'/, "");
  if (variant === orig) throw new Error(`${m.id}: the live ${m.fn} statement has nothing to remove for «${m.kind}» - update the mutant`);
  const wrapped = `if current_setting('glb.tag', true) = '${TAG}' then\n    ${variant}\n  else\n    ${orig}\n  end if;`;
  const out = def.replace(orig, () => wrapped).replace("AS $function$", () => `AS $function$ ${MARK}`);
  if (!out.includes(MARK) || out === def) throw new Error(`${m.id}: could not build the mutant`);
  return out;
}
function readBackup(): Record<string, string> {
  return existsSync(BACKUP) ? (JSON.parse(readFileSync(BACKUP, "utf8")) as Record<string, string>) : {};
}
async function swapIn(m: Mutant): Promise<void> {
  if (aborting) throw new Error(`aborting: not swapping ${m.fn}`);
  const sig = sigOf(m.fn);
  const def = await liveDef(sig);
  if (def.includes(MARK)) throw new Error(`${m.fn} is already a mutant (a crashed run?) - restore it first`);
  writeFileSync(BACKUP, JSON.stringify({ ...readBackup(), [sig]: def }));
  await monitor.query(mutate(def, m));
}
/** The statement from the migration that holds the function's latest definition (fallback when the backup is gone). */
function fromMigration(f: Fn): string {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations", f.migration), "utf8");
  const start = sql.indexOf(`create or replace function public.${f.name}()`);
  if (start < 0) throw new Error(`${f.migration} no longer defines ${f.name}`);
  const open = /\bas\s+(\$[a-z_]*\$)/i.exec(sql.slice(start));
  if (!open) throw new Error(`could not find the body of ${f.name} in ${f.migration}`);
  const bodyStart = start + open.index + open[0].length;
  const close = sql.indexOf(open[1]!, bodyStart);
  if (close < 0) throw new Error(`could not find the end of ${f.name} in ${f.migration}`);
  return sql.slice(start, close + open[1]!.length);
}
/** Put every bridge back (backup file first, the migration text if it is gone) and verify. */
async function restoreFunctions(): Promise<void> {
  const backup = readBackup();
  for (const f of FUNCS) {
    const sig = sigOf(f.name);
    const live = await liveDef(sig).catch(() => "");
    if (!live.includes(MARK)) continue;
    const original = backup[sig];
    if (original) {
      await monitor.query(original);
      if ((await liveDef(sig)) !== original) throw new Error(`${f.name} was not restored byte-for-byte`);
    } else {
      await monitor.query(fromMigration(f));
      if ((await liveDef(sig)).includes(MARK)) throw new Error(`fallback restore of ${f.name} failed`);
      console.error(`${f.name} restored from ${f.migration} (backup file was missing)`);
    }
  }
  if (existsSync(BACKUP)) unlinkSync(BACKUP);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function purge(): Promise<void> {
  const hasNotices = (await monitor.query("select to_regclass('public.release_notices') is not null as ok").catch(() => null))?.rows[0]?.ok === true;
  try {
    await monitor.query("begin");
    await monitor.query("set local session_replication_role = replica");
    const stmts = [
      `create temp table glb_staff on commit drop as select id from auth.users where email like 'glb-%@glb.example.test'`,
      `create temp table glb_pat on commit drop as select id from public.patients where drm_id like 'DRM-GLB-%'`,
      `create temp table glb_visit on commit drop as select id from public.visits where patient_id in (select id from glb_pat)`,
      `create temp table glb_tr on commit drop as select id from public.test_requests where visit_id in (select id from glb_visit)`,
      `create temp table glb_pay on commit drop as select id from public.payments where visit_id in (select id from glb_visit)`,
      `create temp table glb_alloc on commit drop as select id from public.visit_waiver_allocations where visit_id in (select id from glb_visit)`,
      `create temp table glb_adj on commit drop as select id from public.eod_cash_adjustments where notes like 'glb-%' or recorded_by in (select id from glb_staff)`,
      `create temp table glb_batch on commit drop as select id from public.hmo_claim_batches where provider_id in (select id from public.hmo_providers where name like 'glb-%')`,
      `create temp table glb_item on commit drop as select id from public.hmo_claim_items where batch_id in (select id from glb_batch) or test_request_id in (select id from glb_tr)`,
      `create temp table glb_res on commit drop as select id from public.hmo_claim_resolutions where item_id in (select id from glb_item)`,
      `create temp table glb_phys on commit drop as select id from public.physicians where slug like 'glb-%'`,
      `create temp table glb_pfe on commit drop as select id from public.doctor_pf_entries where test_request_id in (select id from glb_tr) or physician_id in (select id from glb_phys)`,
      `create temp table glb_disb on commit drop as select id from public.doctor_pf_disbursements where physician_id in (select id from glb_phys)`,
      `create temp table glb_je on commit drop as
         select id from public.journal_entries
          where created_by in (select id from glb_staff)
             or source_id in (select id from glb_tr union all select id from glb_pay union all select id from glb_adj
                              union all select id from glb_res union all select id from glb_alloc union all select id from glb_pfe
                              union all select id from glb_disb)`,
      `insert into glb_je
         select j.id from public.journal_entries j
          where (j.reverses in (select id from glb_je)
                 or j.id in (select o.reversed_by from public.journal_entries o where o.id in (select id from glb_je) and o.reversed_by is not null))
            and j.id not in (select id from glb_je)`,
      `delete from public.journal_lines where entry_id in (select id from glb_je)`,
      `delete from public.journal_entries where id in (select id from glb_je)`,
      `delete from public.audit_log
        where actor_id in (select id from glb_staff)
           or resource_id in (select id from glb_tr union all select id from glb_pay union all select id from glb_visit
                              union all select id from glb_alloc union all select id from glb_adj union all select id from glb_res
                              union all select id from glb_disb)`,
      ...(hasNotices ? [`delete from public.release_notices where visit_id in (select id from glb_visit)`] : []),
      `delete from public.doctor_pf_entries where id in (select id from glb_pfe)`,
      `delete from public.doctor_pf_disbursements where id in (select id from glb_disb)`,
      `delete from public.visit_waiver_allocations where id in (select id from glb_alloc)`,
      `delete from public.hmo_claim_resolutions where id in (select id from glb_res)`,
      `delete from public.hmo_claim_items where id in (select id from glb_item)`,
      `delete from public.hmo_claim_batches where id in (select id from glb_batch)`,
      `delete from public.hmo_providers where name like 'glb-%'`,
      `delete from public.eod_cash_adjustments where id in (select id from glb_adj)`,
      `delete from public.payments where id in (select id from glb_pay)`,
      `delete from public.test_requests where id in (select id from glb_tr)`,
      `delete from public.visits where id in (select id from glb_visit)`,
      `delete from public.patients where id in (select id from glb_pat)`,
      `delete from public.services where code like 'GLB-%'`,
      `delete from public.physicians where id in (select id from glb_phys)`,
      `delete from public.staff_profiles where id in (select id from glb_staff)`,
      `delete from auth.users where id in (select id from glb_staff)`,
    ];
    for (const sql of stmts) await monitor.query(sql);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    console.error(`  cleanup failed: ${(e as Error).message.split("\n")[0]}`);
  }
}
async function leftovers(): Promise<number> {
  const r = await monitor.query(
    `select (select count(*) from auth.users where email like 'glb-%@glb.example.test')
          + (select count(*) from public.staff_profiles where full_name like 'glb-%')
          + (select count(*) from public.patients where drm_id like 'DRM-GLB-%')
          + (select count(*) from public.services where code like 'GLB-%')
          + (select count(*) from public.physicians where slug like 'glb-%')
          + (select count(*) from public.hmo_providers where name like 'glb-%')
          + (select count(*) from public.eod_cash_adjustments where notes like 'glb-%')
          + (select count(*) from public.journal_entries where source_id = any($1::uuid[]) or created_by = $2) as n`,
    [made.ids, fx.admin],
  );
  return Number(r.rows[0]!.n);
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  monitor = await newClient();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('gl-bridge:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("another gl-bridge concurrency proof is running - exiting");
    process.exit(2);
  }
  let exit = 0;
  let cleanupP: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupP ??= (async () => {
      await closeAll();
      await restoreFunctions().catch((e) => {
        console.error(`FAIL: ${(e as Error).message}`);
        exit = 1;
      });
      await purge();
      const left = await leftovers().catch(() => -1);
      if (left !== 0) {
        console.error(`FAIL: ${left} tagged rows left behind`);
        exit = 1;
      }
    })();
    return cleanupP;
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      aborting = true;
      void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
    });
  }
  try {
    // A crashed earlier run may have left a mutant bridge or tagged rows.
    await restoreFunctions();
    await purge();
    console.log(`Server: ${(await monitor.query<{ v: string }>("select version() as v")).rows[0]!.v}`);
    await seed();
    console.log(`Real bridge functions (public), ${ROUNDS} free-race rounds:`);
    const real = await runAll();
    const all = Object.entries(real);
    const bad = all.filter(([, v]) => v.status === "fail" || v.status === "fixed");
    const known = all.filter(([, v]) => v.status === "known");
    const passed = all.filter(([, v]) => v.status === "pass").length;
    console.log(`${passed}/${all.length - known.length} scenarios passed${known.length ? `; ${known.length} KNOWN issue(s) reproduced (${known.map(([k]) => k).join(", ")})` : ""}.`);
    if (bad.length > 0) {
      exit = 1;
      console.log(`FAILED: ${bad.map(([k]) => k).join(", ")}`);
    }

    if (CONTROL) {
      let caught = 0;
      let ran = 0;
      for (const m of MUTANTS) {
        if (aborting) break;
        if (ONLY && !m.mustFail.every((x) => ONLY.has(x))) continue;
        ran += 1;
        console.log(`Control ${m.id}: ${m.fn} with ${m.note}`);
        try {
          await swapIn(m);
          const res = await runAll(new Set([...m.mustFail, ...(m.mustPass ?? [])]));
          if (aborting) break;
          const survived = m.mustFail.filter((x) => res[x]?.status === "pass");
          const broke = (m.mustPass ?? []).filter((x) => res[x]?.status !== "pass");
          if (survived.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: ${survived.join(", ")} still passed against the mutant - the proof cannot catch this bug`);
            exit = 1;
          } else if (broke.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: ${broke.join(", ")} should pass against this mutant but did not`);
            exit = 1;
          } else {
            caught += 1;
            console.log(`  control ${m.id} ok: ${m.mustFail.join(", ")} failed against the mutant${m.mustPass ? `; ${m.mustPass.join(", ")} still pass (the source row's lock serialises them)` : ""}`);
          }
        } finally {
          await restoreFunctions();
          await purge();
          if (!aborting) await seed(); // the purge removed the shared fixtures too
        }
      }
      console.log(`${caught}/${ran} mutants caught.`);
    }
  } finally {
    await cleanup();
    await monitor.query("select pg_advisory_unlock(hashtext('gl-bridge:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
