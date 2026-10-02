// Hand-run local CONCURRENCY proof for the six AP-subledger lock functions of 0049 that had none:
//   ap_void_bill_payment_cascade   void a bill payment (reversal JE + voided_at + allocation cascade)
//   ap_reallocate_bill_payment     delete-then-insert a payment's allocations (deferred P0030-P0033 check at commit)
//   ap_void_bill_with_guard        void a posted bill (reversal JE + the P0029 trigger guard)
//   ap_update_bill_draft           replace a draft bill's header + lines
//   ap_post_recurring_template     the cron's "create a draft bill from a due template + advance next_run_date"
//   ap_reverse_je_for_source       the shared "reverse the posted journal entry of a source" helper
//
// The sequential smoke (scripts/smoke-12.4.sql) cannot prove a race (a transaction never waits on itself), so this
// runner uses separate `pg` connections. DETERMINISTIC, NOT LUCKY: a forced scenario holds the first caller's
// transaction open, starts the second, and does not move on until pg_locks shows THAT backend queued on the expected
// lock (a row lock, on the expected relation). If the interleaving is not reached the scenario FAILS - it never
// degrades into a sequential run. Only the free-race rounds (F1-F4) rely on timing, and they assert invariants only.
//
// HOW EACH FUNCTION IS CALLED (as the app does)
//   all six        service_role, through the admin client (src/lib/actions/accounting/{bills,bill-payments}.ts and
//                  src/app/api/cron/recurring-bills/route.ts). They are SECURITY DEFINER, owned by postgres.
//   posting a draft   the app has NO function for it: postBillAction is a direct service_role UPDATE
//                  (wt_amount, status='posted', posted_at, posted_by ... where status = 'draft'), copied verbatim in B6/B7.
//   deleting a draft  deleteBillDraftAction's `delete from bills where id and status = 'draft'`, copied verbatim (B8).
//   fixtures       created by the real RPCs (ap_create_bill_and_post / ap_create_bill_draft /
//                  ap_create_bill_payment_with_allocations) as the test owner. Payments are bank_transfer into 1020
//                  so the cash-drawer trigger (0149, cash into 1010 only) stays out of the picture.
//
// SCENARIOS (A = first caller, whose transaction stays open; B = second, which must queue)
//   P1 void payment x void payment        P2 void payment, then reallocate it      P3 reallocate, then void
//   P4 reallocate x reallocate            P5 reallocate x reallocate with a bad sum (deferred P0030 at commit)
//   P6 two payments reallocated onto one bill that fits only one (deferred P0031 at commit)
//   B1 void bill x void bill              B2 void bill, then an allocation onto it (reallocate)
//   B3 allocation onto a bill, then void  B4 void payment, then void its bill
//   B5 update draft x update draft        B6 post a draft, then update it          B7 update a draft, then post it
//   B8 delete a draft, then update it
//   T1 post template x post template      T2 overdue template x2 (two legitimate months)   T3 deactivate, then post
//   J1 reverse x reverse (direct)         J2 a direct journal-entry writer, then reverse
//   F1 free race on one payment (void/void/reallocate)   F2 free race: three cron runs on one template
//   F3 free race on one bill (void/void/allocate)        F4 two payments reallocating over the same two bills in opposite order
//   KNOWN (reported, not asserted; a KNOWN scenario that stops reproducing or breaks exits 1):
//   D1 void a bill x void its payment: bill-row -> journal-entry-counter vs counter -> bill-row lock-order cycle (40P01)
//   K2 two payments reallocated onto one bill with room for both: the recompute trigger's stale sum overwrites paid_amount
//   K3 void one payment of a bill while a reallocation puts another on it: the same stale-sum overwrite, through the void cascade
//
// CONTROL ROUNDS (--control) prove the proof can fail. Each mutant removes ONE guard and the named scenarios must
// FAIL against it (a copy in a throwaway schema aps_ctl_<hex>, never public), for the mutant's stated REASON (a regexp over the
// failure message: the outcome the guard protects) - an infrastructure failure (interleaving not reached, a wait timeout, a statement
// timeout, a failed fixture) is never a catch, and every caught message is printed. During a mutant round the forced scenarios only
// require the second caller to be BLOCKED BY the first (not queued on the guard's own relation), so what fails is the OUTCOME the
// guard protects - a second reversal, a duplicate bill for one month, an active allocation on a voided payment, an edit of a
// posted bill - not merely where the waiter queued (the normal run checks the queue relation too):
//   MVP ap_void_bill_payment_cascade without the payment FOR UPDATE       (P1)
//   MRA ap_reallocate_bill_payment without the payment FOR UPDATE         (P2 P4)
//   MVB ap_void_bill_with_guard without the bill FOR UPDATE               (B1)
//   MUD ap_update_bill_draft without the bill FOR UPDATE                  (B6 B8)
//   MPR ap_post_recurring_template without the template FOR UPDATE        (T1 T2 T3)
//   MRJ ap_reverse_je_for_source without the journal-entry FOR UPDATE     (J1 J2)
// The mutants cover the six functions' own row locks. They do NOT cover ap_recompute_bill_paid_and_status (the K2/K3 defect: it is
// a trigger on bill_payment_allocations, fired for every session, and a trigger body cannot be isolated in a copy schema).
//
// Redundancy, stated honestly (the scenarios that STILL pass against a mutant check shared behaviour, not the dropped
// guard; they are asserted as mustPass so a later change that makes the lock matter shows up):
//   - ap_update_bill_draft: against a second updater the function's own `update bills` queues on the same row, so the
//     FOR UPDATE changes nothing (B5 passes without it). It matters only where the status or existence of the bill
//     can change under the caller: a post (B6) or a delete (B8).
//   - ap_void_bill_with_guard against an allocation that committed first (B3): the BEFORE UPDATE guard trigger takes
//     the row lock itself and re-reads the allocations after the wait, so P0029 still fires; the FOR UPDATE is what
//     makes void-vs-void idempotent (B1), without it the loser dies in ap_reverse_je_for_source with "No posted JE".
//   - ap_void_bill_payment_cascade against a reallocate that committed first (P3): the cascade UPDATE waits on the
//     payment row and its trigger reads the allocations with a fresh snapshot; the lock is what makes void-vs-void
//     idempotent (P1).
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows), tagged aps-<hex> (vendor names,
// template descriptions, one throwaway admin), swept at start, deleted in finally + SIGINT/SIGTERM (incl. the journal
// entries they posted and the audit rows), then counted: a tagged row left is a FAIL. The sweep runs under
// session_replication_role = replica (local stack only), the same as the sibling proofs. Local DB only.
// No plan modes: every locking statement addresses ONE row by primary key (the allocation delete is by payment_id on a
// handful of rows), so there is no plan shape to match.
//
// Run (local stack):
//   npm run ap-subledger:concurrency-proof [-- --control]
//   APS_ROUNDS=50 npm run ap-subledger:concurrency-proof        free-race rounds (default 15)
//   APS_ONLY=P1,B1 npm run ap-subledger:concurrency-proof       a subset while iterating
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

requireLocalOrExplicitProd("ap-subledger:concurrency-proof", {
  writes:
    "a throwaway admin (auth.users + staff_profiles), vendors, bills, bill payments, recurring templates and the journal entries / audit rows they post, tagged aps-<hex>, committed so two connections can race on them, then deleted; during --control it creates (and drops) copies of six functions in a schema aps_ctl_<hex>",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[ap-subledger:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const TAG = `aps-${randomBytes(3).toString("hex")}`;
const ROUNDS = Number(process.env.APS_ROUNDS ?? 15);
const ONLY = process.env.APS_ONLY ? new Set(process.env.APS_ONLY.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const CONTROL = process.argv.includes("--control");
const APP_NAME = `ap-subledger:${TAG}`;

// Which schema each function is called from (public, or a mutant's throwaway schema).
/** During a mutant round the forced scenarios only require the second caller to be BLOCKED BY the first (not queued on the real
 *  guard's relation), so what fails against a mutant is the OUTCOME the guard protects, not merely where the waiter queued. */
let relaxedWait = false;
const FN = { voidPay: "public", realloc: "public", voidBill: "public", updDraft: "public", postTpl: "public", revJe: "public" };
type Slot = keyof typeof FN;

let monitor: Client;
const open: Client[] = [];
let seq = 0;
/** Every id this run minted (vendors, bills, payments, templates): the leftover check looks them up by primary key as well as by tag. */
const madeIds: string[] = [];
const made = (id: string): string => {
  madeIds.push(id);
  return id;
};
/** Set by the SIGINT/SIGTERM handler: no new scenario or mutant may start once cleanup is under way. */
let aborting = false;

// Run-wide fixtures (set in setup()).
let ADMIN = "";
let TODAY = "";
let EXPENSE = "";
let BANK = "";

class Fail extends Error {}
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
type Actor = { c: Client; pid: number; name: string; settled: boolean };
type Out = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string; msg: string };
type Row = Record<string, unknown>;

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL, application_name: APP_NAME });
  c.on("error", () => undefined); // a backend terminated by the abort cleanup must not crash the process
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  open.push(c);
  return c;
}
async function actor(name: string): Promise<Actor> {
  const c = await newClient();
  const pid = (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  return { c, pid, name, settled: false };
}
/** begin + act as service_role, like the admin client. */
async function begin(a: Actor): Promise<void> {
  await a.c.query("begin");
  await a.c.query("set local role service_role");
}
/** begin as the test owner: a plain direct writer (no app role). */
async function beginPlain(a: Actor): Promise<void> {
  await a.c.query("begin");
}
function settle(p: Promise<{ rows: unknown[]; rowCount: number | null }>): Promise<Out> {
  return p.then(
    (r) => ({ ok: true as const, rows: r.rows as Row[], rowCount: r.rowCount ?? 0 }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code ?? "?", msg: e.message ?? String(e) }),
  );
}
/** Run one statement and track whether it has answered (for mustWait / mustNotWait). */
function call(a: Actor, sql: string, params: unknown[] = []): Promise<Out> {
  a.settled = false;
  return settle(a.c.query(sql, params)).then((o) => {
    a.settled = true;
    return o;
  });
}
/** End the transaction the moment its own call answers: commit on success, roll back on refusal. A deferred
 *  constraint trigger (P0030-P0033) fires inside COMMIT, so a refusal there is returned as the outcome. */
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

// ---------------------------------------------------------------------------
// Interleaving control (pg_locks, THIS backend only)
// ---------------------------------------------------------------------------
/** What `pid` is queued on right now: a row ("row"), another lock type ("other"), or nothing (null). */
async function waitingOn(pid: number): Promise<"row" | "other" | null> {
  const { rows } = await monitor.query<{ locktype: string }>("select locktype from pg_locks where pid = $1 and not granted", [pid]);
  if (rows.length === 0) return null;
  return rows.some((r) => r.locktype === "transactionid" || r.locktype === "tuple") ? "row" : "other";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Which relations' tuple locks `pid` holds or queues on (a row-lock waiter holds the tuple lock of the row it waits on). */
async function tupleRelations(pid: number): Promise<string[]> {
  const { rows } = await monitor.query<{ rel: string }>(
    "select distinct relation::regclass::text as rel from pg_locks where pid = $1 and locktype = 'tuple' and relation is not null",
    [pid],
  );
  return rows.map((r) => r.rel);
}

/** The actor's in-flight call must be seen queued on a row lock of `rel` within ~5s, and must not have answered. */
async function mustWait(a: Actor, rel: string, why: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = "no lock wait";
  while (Date.now() < deadline) {
    if (a.settled) throw new Fail(`interleaving not reached: ${a.name} answered without waiting (${why})`);
    const w = await waitingOn(a.pid);
    if (w === "row") {
      const rels = await tupleRelations(a.pid);
      if (rels.includes(rel)) return;
      last = `queued on ${JSON.stringify(rels)}`;
    } else if (w) last = `waiting on a ${w} lock`;
    await sleep(25);
  }
  const dbg = (await monitor.query("select locktype, relation::regclass::text as rel, mode, granted from pg_locks where pid = $1 and (not granted or locktype in ('tuple', 'transactionid'))", [a.pid])).rows;
  throw new Fail(`interleaving not reached: ${a.name} was never queued on a ${rel} row (${why}); saw ${last} ${JSON.stringify(dbg)}`);
}

/** The actor's in-flight call must be seen blocked BY `by` (pg_blocking_pids) within ~5s, and must not have answered. Used where the
 *  wait is on the other transaction's uncommitted row version rather than on a tuple lock of a known relation (a KEY SHARE foreign-key
 *  check following an in-flight UPDATE chain waits on the updater's transaction id with no tuple lock). */
async function mustBeBlockedBy(a: Actor, by: Actor, why: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (a.settled) throw new Fail(`interleaving not reached: ${a.name} answered without waiting (${why})`);
    const r = await monitor.query<{ b: boolean }>("select $2::int = any(pg_blocking_pids($1)) as b", [a.pid, by.pid]);
    if (r.rows[0]!.b) return;
    await sleep(25);
  }
  throw new Fail(`interleaving not reached: ${a.name} was never blocked by ${by.name} (${why})`);
}

/** First caller runs (its transaction stays open); second starts and must queue on `rel` (null: simply be blocked by the first); first ends; second ends. */
async function forced(opts: {
  first: (a: Actor) => Promise<Out>;
  second: (b: Actor) => Promise<Out>;
  rel: string | null;
  why: string;
  /** first caller is a plain owner session (a direct writer), not the service_role app session. */
  firstPlain?: boolean;
}): Promise<{ o1: Out; o2: Out }> {
  const [a, b] = [await actor("first"), await actor("second")];
  if (opts.firstPlain) await beginPlain(a);
  else await begin(a);
  const r1 = await opts.first(a);
  await begin(b);
  const p2 = andEnd(b, opts.second(b));
  if (opts.rel === null || relaxedWait) await mustBeBlockedBy(b, a, opts.why);
  else await mustWait(b, opts.rel, opts.why);
  const o1 = await end(a, r1);
  const o2 = await p2;
  return { o1, o2 };
}

// ---------------------------------------------------------------------------
// Fixtures (as the owner, through the real RPCs, committed)
// ---------------------------------------------------------------------------
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await monitor.query(sql, params)).rows as Row[];
}
async function mkAdmin(label: string): Promise<string> {
  seq += 1;
  const id = String((await q("select gen_random_uuid() as id"))[0]!.id);
  await monitor.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `${TAG}-${seq}@aps.example.test`],
  );
  await monitor.query(`insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, 'admin', true)`, [id, `${TAG} ${label}`]);
  return made(id);
}
async function mkVendor(): Promise<string> {
  seq += 1;
  return made(String((await q(`insert into public.vendors (name, is_active) values ($1, true) returning id`, [`${TAG} vendor ${seq}`]))[0]!.id));
}
function billInput(vendor: string, lines: number[]): string {
  seq += 1;
  return JSON.stringify({
    vendor_id: vendor,
    vendor_invoice_number: `${TAG}-${seq}`,
    bill_date: TODAY,
    due_date: TODAY,
    description: TAG,
    wt_exempt: true,
    lines: lines.map((amount, i) => ({ line_no: i + 1, description: "aps", amount_php: amount, account_id: EXPENSE })),
  });
}
/** A POSTED bill (net = gross = amount, no withholding) with its bill_post journal entry. */
async function mkBill(vendor: string, amount = 100): Promise<string> {
  const r = await q(`select (public.ap_create_bill_and_post($1::jsonb, $2::uuid, gen_random_uuid())->>'bill_id') as id`, [billInput(vendor, [amount]), ADMIN]);
  return made(String(r[0]!.id));
}
/** A DRAFT bill with the given line amounts. */
async function mkDraft(vendor: string, lines: number[]): Promise<string> {
  const r = await q(`select (public.ap_create_bill_draft($1::jsonb, $2::uuid, gen_random_uuid())->>'bill_id') as id`, [billInput(vendor, lines), ADMIN]);
  return made(String(r[0]!.id));
}
/** A bank-transfer payment (1020) allocated to the given bills, with its bill_payment journal entry. */
async function mkPayment(vendor: string, allocs: { bill: string; amount: number }[]): Promise<string> {
  const total = allocs.reduce((s, a) => s + a.amount, 0);
  const input = JSON.stringify({
    vendor_id: vendor,
    payment_date: TODAY,
    method: "bank_transfer",
    cash_account_id: BANK,
    amount_php: total,
    reference: TAG,
    allocations: allocs.map((a) => ({ bill_id: a.bill, allocated_amount: a.amount })),
  });
  const r = await q(`select (public.ap_create_bill_payment_with_allocations($1::jsonb, $2::uuid)->>'payment_id') as id`, [input, ADMIN]);
  return made(String(r[0]!.id));
}
async function mkTemplate(vendor: string, nextRunOffset: string, active = true): Promise<string> {
  seq += 1;
  const r = await q(
    `insert into public.recurring_bill_templates (vendor_id, description, due_day_of_month, amount_php, default_account_id, default_wt_exempt, next_run_date, is_active)
     values ($1, $2, 15, 50, $3, true, ((now() at time zone 'Asia/Manila')::date + $4::interval)::date, $5) returning id`,
    [vendor, `${TAG} template ${seq}`, EXPENSE, nextRunOffset, active],
  );
  return made(String(r[0]!.id));
}
const alloc = (bill: string, amount: number) => ({ bill_id: bill, allocated_amount: amount });

// ---------------------------------------------------------------------------
// State readers (always from the monitor connection)
// ---------------------------------------------------------------------------
type BillState = { status: string; paid: number; gross: number; net: number; voided: boolean; active: number };
async function bill(id: string): Promise<BillState> {
  const r = (
    await q(
      `select b.status, b.paid_amount, b.gross_amount, b.net_payable, b.voided_at is not null as voided,
              (select count(*) from public.bill_payment_allocations a join public.bill_payments p on p.id = a.payment_id
                where a.bill_id = b.id and a.voided_at is null and p.voided_at is null)::int as active
         from public.bills b where b.id = $1`,
      [id],
    )
  )[0];
  if (!r) throw new Fail(`bill ${id} is gone`);
  return { status: String(r.status), paid: Number(r.paid_amount), gross: Number(r.gross_amount), net: Number(r.net_payable), voided: Boolean(r.voided), active: Number(r.active) };
}
type PayState = { voided: boolean; amount: number; allocs: { bill: string; amount: number }[]; total: number };
async function payment(id: string): Promise<PayState> {
  const p = (await q(`select voided_at is not null as voided, amount_php from public.bill_payments where id = $1`, [id]))[0];
  if (!p) throw new Fail(`payment ${id} is gone`);
  const a = await q(`select bill_id, allocated_amount from public.bill_payment_allocations where payment_id = $1 and voided_at is null order by allocated_amount, bill_id`, [id]);
  const t = Number((await q(`select count(*)::int as n from public.bill_payment_allocations where payment_id = $1`, [id]))[0]!.n);
  return { voided: Boolean(p.voided), amount: Number(p.amount_php), allocs: a.map((r) => ({ bill: String(r.bill_id), amount: Number(r.allocated_amount) })), total: t };
}
/** The journal entries of a source: status of the original(s) and how many reversals point at them. */
async function je(kind: "bill_post" | "bill_payment", id: string): Promise<{ origs: string[]; reversals: number; reversedBy: (string | null)[] }> {
  const o = await q(`select status, reversed_by from public.journal_entries where source_kind = $1::public.je_source_kind and source_id = $2 order by created_at`, [kind, id]);
  const r = await q(
    `select count(*)::int as n from public.journal_entries r where r.source_kind = 'reversal'
        and r.reverses in (select id from public.journal_entries where source_kind = $1::public.je_source_kind and source_id = $2)`,
    [kind, id],
  );
  return { origs: o.map((x) => String(x.status)), reversals: Number(r[0]!.n), reversedBy: o.map((x) => (x.reversed_by ? String(x.reversed_by) : null)) };
}
async function audits(action: string, resource: string): Promise<Row[]> {
  return q(`select metadata from public.audit_log where action = $1 and resource_id = $2 order by created_at, id`, [action, resource]);
}
async function billsOfTemplate(tpl: string): Promise<{ n: number; dues: string[] }> {
  const r = await q(`select due_date::text as d from public.bills where template_id = $1 order by due_date`, [tpl]);
  return { n: r.length, dues: r.map((x) => String(x.d)) };
}
async function templateNext(tpl: string): Promise<string> {
  return String((await q(`select next_run_date::text as d from public.recurring_bill_templates where id = $1`, [tpl]))[0]!.d);
}
/** [d + 1 month, d + 1 month + 1 month] as the function chains them (Manila dates, computed in SQL: no JS Date arithmetic). */
async function monthsAfter(d: string): Promise<[string, string]> {
  const r = (await q(`select ($1::date + interval '1 month')::date::text as d1, (($1::date + interval '1 month')::date + interval '1 month')::date::text as d2`, [d]))[0]!;
  return [String(r.d1), String(r.d2)];
}
async function dateOffset(offset: string): Promise<string> {
  return String((await q(`select ((now() at time zone 'Asia/Manila')::date + $1::interval)::date::text as d`, [offset]))[0]!.d);
}

// ---------------------------------------------------------------------------
// Invariants every committed state must satisfy (used by the free races and as a closing check)
// ---------------------------------------------------------------------------
async function checkPayment(id: string, label: string): Promise<void> {
  const p = await payment(id);
  const j = await je("bill_payment", id);
  if (p.voided) {
    eq(`${label}: a voided payment keeps no active allocation`, p.allocs, []);
    eq(`${label}: a voided payment has exactly one reversal`, [j.origs, j.reversals], [["reversed"], 1]);
  } else {
    eq(`${label}: active allocations sum to the payment`, p.allocs.reduce((s, x) => s + x.amount, 0), p.amount);
    eq(`${label}: a live payment has no reversal`, [j.origs, j.reversals], [["posted"], 0]);
  }
}
async function checkBill(id: string, label: string): Promise<void> {
  const b = await bill(id);
  const paid = Number((await q(`select coalesce(sum(allocated_amount), 0) as s from public.bill_payment_allocations where bill_id = $1 and voided_at is null`, [id]))[0]!.s);
  eq(`${label}: paid_amount equals the active allocations`, b.paid, paid);
  const j = await je("bill_post", id);
  if (b.voided) {
    eq(`${label}: a voided bill has status voided (never paid)`, b.status, "voided");
    eq(`${label}: a voided bill has no active allocation`, b.active, 0);
    eq(`${label}: a voided bill has exactly one reversal`, [j.origs, j.reversals], [["reversed"], 1]);
  } else {
    const want = b.paid >= b.net && b.net > 0 ? "paid" : b.paid > 0 ? "partially_paid" : "posted";
    eq(`${label}: status follows the allocations`, b.status, want);
    eq(`${label}: a live bill has no reversal`, [j.origs, j.reversals], [["posted"], 0]);
  }
}

// ---------------------------------------------------------------------------
// Calls, exactly as the app issues them
// ---------------------------------------------------------------------------
const voidPay = (a: Actor, id: string, reason = "aps proof") =>
  call(a, `select ${FN.voidPay}.ap_void_bill_payment_cascade($1::uuid, $2::text, $3::uuid) as r`, [id, reason, ADMIN]);
const reallocate = (a: Actor, id: string, allocs: { bill_id: string; allocated_amount: number }[]) =>
  call(a, `select ${FN.realloc}.ap_reallocate_bill_payment($1::uuid, $2::jsonb, $3::uuid) as r`, [id, JSON.stringify(allocs), ADMIN]);
const voidBill = (a: Actor, id: string, reason = "aps proof") =>
  call(a, `select ${FN.voidBill}.ap_void_bill_with_guard($1::uuid, $2::text, $3::uuid) as r`, [id, reason, ADMIN]);
const updateDraft = (a: Actor, id: string, vendor: string, lines: number[], note: string) =>
  call(a, `select ${FN.updDraft}.ap_update_bill_draft($1::uuid, $2::jsonb, $3::uuid) as r`, [id, JSON.stringify({ ...JSON.parse(billInput(vendor, lines)), description: note }), ADMIN]);
const postTemplate = (a: Actor, id: string) => call(a, `select ${FN.postTpl}.ap_post_recurring_template($1::uuid) as r`, [id]);
const reverseJe = (a: Actor, kind: string, id: string) => call(a, `select ${FN.revJe}.ap_reverse_je_for_source($1::text, $2::uuid, $3::uuid) as r`, [kind, id, ADMIN]);
// postBillAction (src/lib/actions/accounting/bills.ts), verbatim WHERE guards; the fixtures are wt-exempt so wt = 0.
const postDraftDirect = (a: Actor, id: string) =>
  call(a, `update public.bills set wt_amount = 0, status = 'posted', posted_at = now(), posted_by = $2 where id = $1 and status = 'draft' returning id`, [id, ADMIN]);
// deleteBillDraftAction's delete, verbatim.
const deleteDraftDirect = (a: Actor, id: string) => call(a, `delete from public.bills where id = $1 and status = 'draft' returning id`, [id]);

const val = (o: Out, key: string): unknown => (o.ok ? o.rows[0]?.[key] : `${o.code}: ${o.msg}`);
const rj = (o: Out): Record<string, unknown> => (val(o, "r") as Record<string, unknown> | undefined) ?? {};
function expectOk(o: Out, label: string): void {
  if (!o.ok) throw new Fail(`${label}: refused ${o.code} (${o.msg})`);
}
function expectRefused(o: Out, label: string, code: string | null, msg?: RegExp): void {
  if (o.ok) throw new Fail(`${label}: expected a refusal, but it succeeded (${JSON.stringify(o.rows[0])})`);
  if (code && o.code !== code) throw new Fail(`${label}: expected ${code}, got ${o.code} (${o.msg})`);
  if (msg && !msg.test(o.msg)) throw new Fail(`${label}: expected /${msg.source}/, got ${o.code} (${o.msg})`);
}
const show = (o: Out) => (o.ok ? `ok ${JSON.stringify(o.rows[0] ?? {})}` : `${o.code}: ${o.msg.split("\n")[0]}`);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
type Verdict = void | "reproduced" | "not-reproduced";
type Scenario = () => Promise<Verdict>;
const KNOWN = new Set(["D1", "K2", "K3"]);
const scenarios: Record<string, Scenario> = {
  // concurrency-proof: ap_void_bill_payment_cascade (P1 void x void: the second queues on the payment row, re-reads voided_at, returns already_voided)
  // P1 - two admins void the same payment: one reversal JE, one audit row, the second is told it is already voided.
  async P1() {
    const v = await mkVendor();
    const b1 = await mkBill(v);
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => voidPay(a, p),
      second: (b) => voidPay(b, p),
      rel: "bill_payments",
      why: "the second void queues on the payment row the first locked",
    });
    expectOk(o1, "first void");
    expectOk(o2, "second void");
    expect(typeof rj(o1).reversal_je_id === "string", `first void should return its reversal, got ${show(o1)}`);
    eq("second answered already_voided", rj(o2).already_voided, true);
    await checkPayment(p, "P1");
    eq("void audit rows", (await audits("bill_payment.voided", p)).length, 1);
    eq("bill back to posted", [(await bill(b1)).status, (await bill(b1)).paid], ["posted", 0]);
  },
  // concurrency-proof: ap_void_bill_payment_cascade (P2 void then reallocate; P3 reallocate then void - both orders against ap_reallocate_bill_payment)
  // concurrency-proof: ap_reallocate_bill_payment (P2: the reallocate of a just-voided payment queues, re-reads voided_at and is refused P0004)
  // P2 - void first, reallocate second: the reallocate is refused (P0004) and NO active allocation lands on the voided payment.
  async P2() {
    const v = await mkVendor();
    const [b1, b2] = [await mkBill(v), await mkBill(v)];
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => voidPay(a, p),
      second: (b) => reallocate(b, p, [alloc(b2, 100)]),
      rel: "bill_payments",
      why: "the reallocate queues on the payment row the void holds",
    });
    expectOk(o1, "void");
    expectRefused(o2, "reallocate after void", "P0004", /voided payment/);
    await checkPayment(p, "P2");
    eq("b2 untouched", [(await bill(b2)).status, (await bill(b2)).paid], ["posted", 0]);
    eq("b1 released", [(await bill(b1)).status, (await bill(b1)).paid], ["posted", 0]);
    eq("no reallocate audit row", (await audits("bill_payment.reallocated", p)).length, 0);
  },
  // P3 - reallocate first, void second: the void queues, then voids the NEW allocations; nothing is left active.
  async P3() {
    const v = await mkVendor();
    const [b1, b2] = [await mkBill(v), await mkBill(v)];
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b2, 100)]),
      second: (b) => voidPay(b, p),
      rel: "bill_payments",
      why: "the void queues on the payment row the reallocate holds",
    });
    expectOk(o1, "reallocate");
    expectOk(o2, "void");
    await checkPayment(p, "P3");
    const st = await payment(p);
    eq("no active allocation; the reallocated one is kept, voided", [st.allocs.length, st.total], [0, 1]);
    for (const b of [b1, b2]) eq("bill released", [(await bill(b)).status, (await bill(b)).paid], ["posted", 0]);
    eq("reallocate audit row", (await audits("bill_payment.reallocated", p)).length, 1);
    eq("void audit row", (await audits("bill_payment.voided", p)).length, 1);
  },
  // concurrency-proof: ap_reallocate_bill_payment (P4 reallocate x reallocate, P5 the deferred P0030 check still bites the second)
  // P4 - two reallocations of one payment serialise: the final allocation is the SECOND caller's, and its audit "before" is the
  //      first caller's "after" (the second re-read the payment after the wait).
  async P4() {
    const v = await mkVendor();
    const [b1, b2, b3] = [await mkBill(v), await mkBill(v), await mkBill(v)];
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b2, 100)]),
      second: (b) => reallocate(b, p, [alloc(b3, 100)]),
      rel: "bill_payments",
      why: "the second reallocate queues on the payment row",
    });
    expectOk(o1, "first reallocate");
    expectOk(o2, "second reallocate");
    eq("final allocations are the second caller's", (await payment(p)).allocs, [{ bill: b3, amount: 100 }]);
    eq("b1 released", [(await bill(b1)).status, (await bill(b1)).paid], ["posted", 0]);
    eq("b2 released", [(await bill(b2)).status, (await bill(b2)).paid], ["posted", 0]);
    eq("b3 paid", [(await bill(b3)).status, (await bill(b3)).paid], ["paid", 100]);
    const aud = await audits("bill_payment.reallocated", p);
    eq("two reallocate audit rows", aud.length, 2);
    const before = (aud[1]!.metadata as { before: { bill_id: string }[] }).before.map((x) => x.bill_id);
    eq("the second audit's before is the first caller's result", before, [b2]);
    await checkPayment(p, "P4");
  },
  // P5 - the second reallocation names a total that is not the payment's: the deferred P0030 check refuses it AT COMMIT and
  //      the first caller's allocations stand.
  async P5() {
    const v = await mkVendor();
    const [b1, b2, b3] = [await mkBill(v), await mkBill(v), await mkBill(v)];
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b2, 100)]),
      second: (b) => reallocate(b, p, [alloc(b3, 60)]),
      rel: "bill_payments",
      why: "the second reallocate queues on the payment row",
    });
    expectOk(o1, "first reallocate");
    expectRefused(o2, "second reallocate (bad sum)", "P0030");
    eq("the first caller's allocations stand", (await payment(p)).allocs, [{ bill: b2, amount: 100 }]);
    eq("b3 untouched", [(await bill(b3)).status, (await bill(b3)).paid], ["posted", 0]);
    await checkPayment(p, "P5");
  },

  // concurrency-proof: ap_void_bill_with_guard (B1 void x void: the second queues on the bill row, re-reads the status, returns already_voided)
  // B1 - two admins void the same bill: one reversal, one audit row, the second is told it is already voided. Without the
  //      bill FOR UPDATE the loser reads the stale 'posted' and dies in ap_reverse_je_for_source ("No posted JE found").
  async B1() {
    const v = await mkVendor();
    const b = await mkBill(v);
    const { o1, o2 } = await forced({
      first: (a) => voidBill(a, b),
      second: (x) => voidBill(x, b),
      rel: "bills",
      why: "the second void queues on the bill row",
    });
    expectOk(o1, "first void");
    expectOk(o2, "second void");
    eq("second answered already_voided", rj(o2).already_voided, true);
    await checkBill(b, "B1");
    eq("void audit rows", (await audits("bill.voided", b)).length, 1);
  },
  // concurrency-proof: ap_void_bill_with_guard (B2/B3 void vs an allocation onto the bill, both orders; B4 void vs the payment's own void)
  // B2 - void first, an allocation onto that bill second (a reallocate moving a payment onto it): the bill must end voided with
  //      NO active allocation and never in a paid status; the payment stays where it was.
  async B2() {
    const v = await mkVendor();
    const [b1, b2] = [await mkBill(v), await mkBill(v)];
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => voidBill(a, b2),
      second: (b) => reallocate(b, p, [alloc(b2, 100)]),
      rel: "bills",
      why: "the allocation insert / recompute queues on the bill row the void holds",
    });
    expectOk(o1, "void");
    expectRefused(o2, "allocation onto a voided bill", "P0033");
    await checkBill(b2, "B2 voided bill");
    await checkBill(b1, "B2 original bill");
    eq("the payment stays on b1", (await payment(p)).allocs, [{ bill: b1, amount: 100 }]);
    await checkPayment(p, "B2");
  },
  // B3 - the allocation first, the void second: the void queues on the bill row, then the P0029 guard refuses it (nothing voided,
  //      no reversal JE left behind).
  async B3() {
    const v = await mkVendor();
    const [b1, b2] = [await mkBill(v), await mkBill(v)];
    const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b2, 100)]),
      second: (b) => voidBill(b, b2),
      rel: "bills",
      why: "the void queues on the bill row the allocation's recompute updated",
    });
    expectOk(o1, "reallocate");
    expectRefused(o2, "void of a bill that now has a payment", "P0029");
    eq("b2 stays paid", [(await bill(b2)).status, (await bill(b2)).paid], ["paid", 100]);
    await checkBill(b2, "B3");
    eq("no reversal JE survived the refusal", (await je("bill_post", b2)).reversals, 0);
  },
  // B4 - void the payment, then void its bill (the order the P0029 message tells an admin to use): the bill void queues on the bill
  //      row the payment's cascade updated, then both succeed.
  async B4() {
    const v = await mkVendor();
    const b = await mkBill(v);
    const p = await mkPayment(v, [{ bill: b, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => voidPay(a, p),
      second: (x) => voidBill(x, b),
      rel: "bills",
      why: "the bill void queues on the bill row the payment cascade updated",
    });
    expectOk(o1, "void payment");
    expectOk(o2, "void bill");
    await checkPayment(p, "B4 payment");
    await checkBill(b, "B4 bill");
  },

  // concurrency-proof: ap_update_bill_draft (B5 update x update; B6 update vs a post; B7 post then update; B8 update vs a delete)
  // B5 - two edits of one draft serialise: the lines are the SECOND caller's, no duplicated or interleaved line, gross follows.
  async B5() {
    const v = await mkVendor();
    const d = await mkDraft(v, [10]);
    const { o1, o2 } = await forced({
      first: (a) => updateDraft(a, d, v, [10, 20], "first edit"),
      second: (b) => updateDraft(b, d, v, [5], "second edit"),
      rel: "bills",
      why: "the second edit queues on the bill row",
    });
    expectOk(o1, "first edit");
    expectOk(o2, "second edit");
    const lines = await q(`select line_no, amount_php::float8 as a from public.bill_lines where bill_id = $1 order by line_no`, [d]);
    eq("the lines are the second caller's", lines.map((l) => [Number(l.line_no), Number(l.a)]), [[1, 5]]);
    eq("gross is the second caller's", (await bill(d)).gross, 5);
    eq("header is the second caller's", String((await q(`select description from public.bills where id = $1`, [d]))[0]!.description), "second edit");
    eq("both audited", (await audits("bill.updated", d)).length, 2);
  },
  // B6 - the draft is POSTED first (postBillAction's update), the edit second: the edit queues, re-reads 'posted' and is refused
  //      (P0004) - a posted bill's lines and header never change. Without the FOR UPDATE the edit reads the stale 'draft', its
  //      bills UPDATE waits and then rewrites a posted bill under its journal entry.
  async B6() {
    const v = await mkVendor();
    const d = await mkDraft(v, [10, 20]);
    const { o1, o2 } = await forced({
      first: (a) => postDraftDirect(a, d),
      second: (b) => updateDraft(b, d, v, [999], "edit after post"),
      rel: "bills",
      why: "the edit queues on the bill row the post holds",
    });
    expectOk(o1, "post");
    expectRefused(o2, "edit of a posted bill", "P0004", /Cannot edit bill in status posted/);
    const lines = await q(`select amount_php::float8 as a from public.bill_lines where bill_id = $1 order by line_no`, [d]);
    eq("the posted lines are untouched", lines.map((l) => Number(l.a)), [10, 20]);
    const b = await bill(d);
    eq("posted at the lines' total", [b.status, b.gross], ["posted", 30]);
    const dr = Number((await q(`select coalesce(sum(l.debit_php), 0) as s from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.source_kind = 'bill_post' and e.source_id = $1`, [d]))[0]!.s);
    eq("the bill_post journal entry matches the bill", dr, 30);
  },
  // B7 - the edit first, the post second: the post queues on the bill row, still finds a draft, and posts the EDITED bill - the
  //      journal entry equals the edited lines.
  async B7() {
    const v = await mkVendor();
    const d = await mkDraft(v, [10, 20]);
    const { o1, o2 } = await forced({
      first: (a) => updateDraft(a, d, v, [7, 8, 9], "edit before post"),
      second: (b) => postDraftDirect(b, d),
      rel: "bills",
      why: "the post queues on the bill row the edit holds",
    });
    expectOk(o1, "edit");
    expectOk(o2, "post");
    eq("the post matched the draft", o2.ok ? o2.rowCount : -1, 1);
    const b = await bill(d);
    eq("posted at the edited total", [b.status, b.gross], ["posted", 24]);
    const dr = Number((await q(`select coalesce(sum(l.debit_php), 0) as s from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.source_kind = 'bill_post' and e.source_id = $1`, [d]))[0]!.s);
    eq("the bill_post journal entry equals the edited lines", dr, 24);
  },
  // B8 - the draft is DELETED first (deleteBillDraftAction), the edit second: the edit queues and answers "not found" (P0002); no
  //      orphan lines, no audit row. Without the FOR UPDATE the edit's UPDATE matches nothing and its line insert dies on the
  //      foreign key (23503) instead.
  async B8() {
    const v = await mkVendor();
    const d = await mkDraft(v, [10]);
    const { o1, o2 } = await forced({
      first: (a) => deleteDraftDirect(a, d),
      second: (b) => updateDraft(b, d, v, [5], "edit after delete"),
      rel: "bills",
      why: "the edit queues on the bill row the delete holds",
    });
    expectOk(o1, "delete");
    expectRefused(o2, "edit of a deleted draft", "P0002", /not found/);
    eq("bill gone", (await q(`select 1 from public.bills where id = $1`, [d])).length, 0);
    eq("no orphan lines", (await q(`select 1 from public.bill_lines where bill_id = $1`, [d])).length, 0);
    eq("no update audit row", (await audits("bill.updated", d)).length, 0);
  },

  // concurrency-proof: ap_post_recurring_template (T1 post x post; T2 two legitimate months; T3 deactivate vs post)
  // T1 - two overlapping cron runs on a template due once: the second queues on the template row, RE-READS next_run_date (the
  //      FOR UPDATE returns the latest committed row) and answers skipped. One bill, next_run_date advanced once, one audit row.
  async T1() {
    const v = await mkVendor();
    const t = await mkTemplate(v, "0 days");
    const { o1, o2 } = await forced({
      first: (a) => postTemplate(a, t),
      second: (b) => postTemplate(b, t),
      rel: "recurring_bill_templates",
      why: "the second run queues on the template row",
    });
    expectOk(o1, "first run");
    expectOk(o2, "second run");
    expect(typeof rj(o1).bill_id === "string", `first run should create a bill, got ${show(o1)}`);
    eq("second run skipped", rj(o2).skipped, true);
    eq("one bill", (await billsOfTemplate(t)).n, 1);
    eq("next_run_date advanced exactly once", await templateNext(t), await dateOffset("1 month"));
    eq("one fired audit row", (await audits("recurring_template.fired", t)).length, 1);
  },
  // T2 - a template two months behind, two overlapping runs: BOTH are legitimate (each takes the next month), each waits for the
  //      other's committed next_run_date, so the two bills carry two DIFFERENT months and next_run_date moved twice.
  async T2() {
    const v = await mkVendor();
    const t = await mkTemplate(v, "-1 month");
    // The function advances next_run_date by `+ interval '1 month'` PER RUN (Jan 31 -> Feb 28 -> Mar 28, not Mar 31), and the bill's
    // due_date is the next_run_date it ran on. So the expected dates are chained in SQL from the committed next_run_date; "today" is
    // never one of them (on the 29th-31st today - 1 month + 1 month is not today).
    const d0 = await templateNext(t);
    const [d1, d2] = await monthsAfter(d0);
    const { o1, o2 } = await forced({
      first: (a) => postTemplate(a, t),
      second: (b) => postTemplate(b, t),
      rel: "recurring_bill_templates",
      why: "the second run queues on the template row",
    });
    expectOk(o1, "first run");
    expectOk(o2, "second run");
    expect(typeof rj(o1).bill_id === "string" && typeof rj(o2).bill_id === "string", `both runs should create a bill: ${show(o1)} / ${show(o2)}`);
    const got = await billsOfTemplate(t);
    eq("two bills for two different months", got.dues, [d0, d1]);
    eq("next_run_date advanced twice", await templateNext(t), d2);
  },
  // T3 - an admin deactivates the template while the cron fires: the run queues, re-checks is_active and finds nothing (P0002); no
  //      bill from a switched-off template.
  async T3() {
    const v = await mkVendor();
    const t = await mkTemplate(v, "0 days");
    const { o1, o2 } = await forced({
      first: (a) => call(a, `update public.recurring_bill_templates set is_active = false where id = $1`, [t]),
      second: (b) => postTemplate(b, t),
      rel: "recurring_bill_templates",
      why: "the run queues on the template row the deactivation holds",
    });
    expectOk(o1, "deactivate");
    expectRefused(o2, "run of a deactivated template", "P0002", /not found or inactive/);
    eq("no bill", (await billsOfTemplate(t)).n, 0);
    eq("next_run_date unchanged", await templateNext(t), TODAY);
  },

  // concurrency-proof: ap_reverse_je_for_source (J1 reverse x reverse; J2 a direct journal-entry writer, then reverse)
  // J1 - two direct reversals of one source: the second queues on the journal entry, re-checks status = 'posted' and finds none
  //      ("No posted JE found" - a bare raise, frozen by pg-error-coverage). Exactly one reversal; the original points at it.
  async J1() {
    const v = await mkVendor();
    const b = await mkBill(v);
    const p = await mkPayment(v, [{ bill: b, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => reverseJe(a, "bill_payment", p),
      second: (x) => reverseJe(x, "bill_payment", p),
      rel: "journal_entries",
      why: "the second reversal queues on the payment's journal entry",
    });
    expectOk(o1, "first reversal");
    expectRefused(o2, "second reversal", null, /No posted JE found for source bill_payment/);
    const j = await je("bill_payment", p);
    eq("one reversal", [j.origs, j.reversals], [["reversed"], 1]);
    eq("the original points at the first reversal", j.reversedBy, [o1.ok ? String(o1.rows[0]!.r) : null]);
  },
  // J2 - a direct ledger writer (the shape of reverseJournalEntryBySource-style code) holds the payment's entry and flips it to
  //      'reversed'; the reversal queues on it, re-checks and adds NO reversal of an already-reversed entry.
  async J2() {
    const v = await mkVendor();
    const b = await mkBill(v);
    const p = await mkPayment(v, [{ bill: b, amount: 100 }]);
    const { o1, o2 } = await forced({
      first: (a) => call(a, `update public.journal_entries set status = 'reversed' where source_kind = 'bill_payment' and source_id = $1 and status = 'posted'`, [p]),
      firstPlain: true,
      second: (x) => reverseJe(x, "bill_payment", p),
      rel: "journal_entries",
      why: "the reversal queues on the journal entry the writer holds",
    });
    expectOk(o1, "direct writer");
    eq("the writer touched one entry", o1.ok ? o1.rowCount : -1, 1);
    expectRefused(o2, "reversal behind the writer", null, /No posted JE found for source bill_payment/);
    eq("no reversal of an already-reversed entry", (await je("bill_payment", p)).reversals, 0);
  },

  // P6 - two DIFFERENT payments reallocated onto one bill whose room fits only one of them: the second queues on the bill row and the
  //      deferred P0031 check refuses it AT COMMIT, so the bill is never over-allocated and the second payment stays where it was.
  // concurrency-proof: ap_reallocate_bill_payment (P6 two payments onto one bill: the deferred P0031 check holds under the race)
  async P6() {
    const v = await mkVendor();
    const [b1, b2, b3] = [await mkBill(v), await mkBill(v), await mkBill(v)];
    const [p, r] = [await mkPayment(v, [{ bill: b1, amount: 100 }]), await mkPayment(v, [{ bill: b2, amount: 100 }])];
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b3, 100)]),
      second: (b) => reallocate(b, r, [alloc(b3, 100)]),
      rel: null,
      why: "the second allocation waits on the first's uncommitted update of the shared bill row",
    });
    expectOk(o1, "first reallocate");
    expectRefused(o2, "second reallocate (bill already full)", "P0031");
    eq("b3 holds the first payment only", (await payment(p)).allocs, [{ bill: b3, amount: 100 }]);
    eq("the second payment stays on b2", (await payment(r)).allocs, [{ bill: b2, amount: 100 }]);
    eq("b3 paid", [(await bill(b3)).status, (await bill(b3)).paid], ["paid", 100]);
    await checkBill(b3, "P6 b3");
    await checkBill(b2, "P6 b2");
  },
  // K2 (KNOWN) - two DIFFERENT payments reallocated onto one bill that has room for both. ap_recompute_bill_paid_and_status (the
  //      per-row allocation trigger) SUMS the active allocations in one statement and only then UPDATEs the bill: the second writer
  //      summed before the first committed (it saw only its own 50), waits on the bill row, and then writes paid_amount = 50 over
  //      the first writer's committed row. Final: 100 allocated, paid_amount 50, status partially_paid. (The deferred P0031 check
  //      only bounds the sum from above, so nothing refuses it; the next allocation change on the bill repairs the figure.) The
  //      void / create paths do not show it because each posts a journal entry and is serialised globally on the journal-entry
  //      counter (je_next_number); a reallocation posts none.
  // concurrency-proof: ap_reallocate_bill_payment (K2 - KNOWN: two payments onto one bill, the recompute trigger's stale sum overwrites paid_amount)
  async K2() {
    const v = await mkVendor();
    const [b1, b2, b3] = [await mkBill(v), await mkBill(v), await mkBill(v)];
    const [p, r] = [await mkPayment(v, [{ bill: b1, amount: 50 }]), await mkPayment(v, [{ bill: b2, amount: 50 }])];
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b3, 50)]),
      second: (b) => reallocate(b, r, [alloc(b3, 50)]),
      rel: null,
      why: "the second allocation waits on the first's uncommitted update of the shared bill row",
    });
    expectOk(o1, "first reallocate");
    expectOk(o2, "second reallocate");
    const b = await bill(b3);
    const active = Number((await q(`select coalesce(sum(allocated_amount), 0) as s from public.bill_payment_allocations where bill_id = $1 and voided_at is null`, [b3]))[0]!.s);
    console.log(`    evidence K2: bill has ${active} actively allocated, paid_amount ${b.paid}, status ${b.status} (net ${b.net})`);
    expect(active === 100, `both allocations should be on the bill, got ${active}`);
    return b.paid === 100 && b.status === "paid" ? "not-reproduced" : "reproduced";
  },

  // K3 (KNOWN) - the same lost update through the VOID path: a reallocation puts a second payment on a bill while another payment of
  //      that bill is being voided. The cascade's allocation UPDATE fires the recompute trigger, which sums the allocations in its
  //      snapshot (the reallocation's new row is invisible), waits on the bill row, and then writes paid_amount = 0 / 'posted' over
  //      the reallocation's committed 100 / 'paid'. Final: one active 50 allocation, paid_amount 0.
  // concurrency-proof: ap_void_bill_payment_cascade (K3 - KNOWN: void of one payment x a reallocation onto the same bill, the recompute trigger's stale sum overwrites paid_amount)
  async K3() {
    const v = await mkVendor();
    const [b1, b3] = [await mkBill(v), await mkBill(v)];
    const [p, qy] = [await mkPayment(v, [{ bill: b1, amount: 50 }]), await mkPayment(v, [{ bill: b3, amount: 50 }])];
    const { o1, o2 } = await forced({
      first: (a) => reallocate(a, p, [alloc(b3, 50)]),
      second: (b) => voidPay(b, qy),
      rel: null,
      why: "the void's allocation recompute waits on the first's uncommitted update of the shared bill row",
    });
    expectOk(o1, "reallocate");
    expectOk(o2, "void");
    await checkPayment(p, "K3 reallocated payment");
    await checkPayment(qy, "K3 voided payment");
    const b = await bill(b3);
    const active = Number((await q(`select coalesce(sum(allocated_amount), 0) as s from public.bill_payment_allocations where bill_id = $1 and voided_at is null`, [b3]))[0]!.s);
    console.log(`    evidence K3: bill has ${active} actively allocated, paid_amount ${b.paid}, status ${b.status} (net ${b.net})`);
    expect(active === 50, `the reallocated payment's 50 should be the only active allocation, got ${active}`);
    return b.paid === 50 && b.status === "partially_paid" ? "not-reproduced" : "reproduced";
  },

  // F1 - free race on ONE payment: void / void / reallocate to a second bill, in random order, ROUNDS times. Whatever commits, the
  //      payment, its allocations, both bills and the ledger agree (a voided payment keeps no active allocation; exactly one
  //      reversal; paid amounts follow the allocations). Refusals must be the documented ones.
  // concurrency-proof: ap_void_bill_payment_cascade (F1 free race: void x void x reallocate on one payment, invariants only)
  // concurrency-proof: ap_reallocate_bill_payment (F1 free race: void x void x reallocate on one payment, invariants only)
  async F1() {
    const v = await mkVendor();
    let deadlocks = 0;
    for (let i = 0; i < ROUNDS; i++) {
      if (aborting) break;
      const [b1, b2] = [await mkBill(v), await mkBill(v)];
      const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
      const acts = await Promise.all([actor("r1"), actor("r2"), actor("r3")]);
      const ops = [(a: Actor) => voidPay(a, p), (a: Actor) => voidPay(a, p), (a: Actor) => reallocate(a, p, [alloc(b2, 100)])];
      const order = ops.map((_, k) => k).sort(() => Math.random() - 0.5);
      const outs = await Promise.all(
        acts.map(async (a, k) => {
          await begin(a);
          return andEnd(a, ops[order[k]!]!(a));
        }),
      );
      for (const o of outs) {
        if (o.ok) continue;
        if (o.code === "40P01") deadlocks += 1;
        else expect(o.code === "P0004", `round ${i}: unexpected refusal ${show(o)}`);
      }
      await checkPayment(p, `round ${i}`);
      await checkBill(b1, `round ${i} b1`);
      await checkBill(b2, `round ${i} b2`);
      await closeAll();
    }
    // No KNOWN cycle can form here: D1 needs a bill void AND a payment void, and F1 races payment voids / a reallocation only (all take the
    // payment row first). A 40P01 is therefore an unexplained deadlock, not an accepted abort.
    console.log(`    F1: ${deadlocks} of ${ROUNDS} rounds ended one side as a 40P01 abort (expected 0: no KNOWN cycle applies)`);
    expect(deadlocks === 0, `F1: ${deadlocks} unexplained 40P01 deadlock(s) - the only KNOWN cycle (D1) needs a bill void next to a payment void, which F1 never races`);
  },
  // F2 - free race: three overlapping cron runs on a template due once, ROUNDS times: exactly one bill, one advance, two skips.
  // concurrency-proof: ap_post_recurring_template (F2 free race: three overlapping runs on one template, invariants only)
  async F2() {
    const v = await mkVendor();
    for (let i = 0; i < ROUNDS; i++) {
      if (aborting) break;
      const t = await mkTemplate(v, "0 days");
      const acts = await Promise.all([actor("r1"), actor("r2"), actor("r3")]);
      const outs = await Promise.all(
        acts.map(async (a) => {
          await begin(a);
          return andEnd(a, postTemplate(a, t));
        }),
      );
      outs.forEach((o, k) => expectOk(o, `round ${i} racer ${k}`));
      eq(`round ${i}: one bill`, (await billsOfTemplate(t)).n, 1);
      eq(`round ${i}: one skip per extra run`, outs.filter((o) => rj(o).skipped === true).length, 2);
      eq(`round ${i}: next_run_date advanced once`, await templateNext(t), await dateOffset("1 month"));
      await closeAll();
    }
  },
  // F3 - free race on ONE bill: void / void / a reallocation moving a payment onto it, ROUNDS times. Never a voided bill with an
  //      active allocation, never a paid status on a voided bill, one reversal.
  // concurrency-proof: ap_void_bill_with_guard (F3 free race: void x void x allocation onto the bill, invariants only)
  async F3() {
    const v = await mkVendor();
    let deadlocks = 0;
    for (let i = 0; i < ROUNDS; i++) {
      if (aborting) break;
      const [b1, b2] = [await mkBill(v), await mkBill(v)];
      const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
      const acts = await Promise.all([actor("r1"), actor("r2"), actor("r3")]);
      const ops = [(a: Actor) => voidBill(a, b2), (a: Actor) => voidBill(a, b2), (a: Actor) => reallocate(a, p, [alloc(b2, 100)])];
      const order = ops.map((_, k) => k).sort(() => Math.random() - 0.5);
      const outs = await Promise.all(
        acts.map(async (a, k) => {
          await begin(a);
          return andEnd(a, ops[order[k]!]!(a));
        }),
      );
      for (const o of outs) {
        if (o.ok) continue;
        if (o.code === "40P01") deadlocks += 1;
        else expect(["P0029", "P0033"].includes(o.code), `round ${i}: unexpected refusal ${show(o)}`);
      }
      await checkBill(b2, `round ${i} b2`);
      await checkBill(b1, `round ${i} b1`);
      await checkPayment(p, `round ${i} payment`);
      await closeAll();
    }
    // D1 (bill row -> journal-entry counter against payment row -> counter -> bill row) needs a PAYMENT VOID. F3 races bill voids and a
    // reallocation (which posts no journal entry), so no KNOWN cycle explains a 40P01 here.
    console.log(`    F3: ${deadlocks} of ${ROUNDS} rounds ended one side as a 40P01 abort (expected 0: D1 needs a payment void, which F3 never races)`);
    expect(deadlocks === 0, `F3: ${deadlocks} unexplained 40P01 deadlock(s) - D1 needs a payment void next to a bill void, which F3 never races`);
  },
  // F4 - free race: two payments reallocating over the same two bills in OPPOSITE order (each insert's recompute updates a bill
  //      row, so the order of the caller's array is the lock order). A cycle, if it forms, must end as a clean 40P01 abort with
  //      every invariant intact - never a half-applied reallocation. The number of aborts seen is reported, not asserted.
  async F4() {
    const v = await mkVendor();
    let deadlocks = 0;
    let drift = 0;
    for (let i = 0; i < ROUNDS; i++) {
      if (aborting) break;
      const [b1, b2, b3, b4] = [await mkBill(v), await mkBill(v), await mkBill(v), await mkBill(v)];
      const p = await mkPayment(v, [{ bill: b1, amount: 100 }]);
      const r = await mkPayment(v, [{ bill: b2, amount: 100 }]);
      const [a1, a2] = await Promise.all([actor("p"), actor("r")]);
      const outs = await Promise.all([
        (async () => (await begin(a1), andEnd(a1, reallocate(a1, p, [alloc(b3, 50), alloc(b4, 50)]))))(),
        (async () => (await begin(a2), andEnd(a2, reallocate(a2, r, [alloc(b4, 50), alloc(b3, 50)]))))(),
      ]);
      for (const o of outs) {
        if (!o.ok) {
          expect(o.code === "40P01", `round ${i}: unexpected refusal ${show(o)}`);
          deadlocks += 1;
        }
      }
      // The payments and the ledger must agree whatever happened; a bill's paid_amount may drift only the K2 way (reported).
      for (const pp of [p, r]) await checkPayment(pp, `round ${i} payment`);
      for (const x of [b1, b2, b3, b4]) {
        const bs = await bill(x);
        const act = Number((await q(`select coalesce(sum(allocated_amount), 0) as s from public.bill_payment_allocations where bill_id = $1 and voided_at is null`, [x]))[0]!.s);
        expect(bs.paid <= act && !bs.voided, `round ${i}: bill paid_amount ${bs.paid} against ${act} actively allocated (voided ${bs.voided})`);
        if (bs.paid !== act) drift += 1;
      }
      await closeAll();
    }
    console.log(`    F4: ${deadlocks} of ${ROUNDS} rounds ended one side as a clean 40P01 abort (accepted: atomic, retryable); ${drift} bill paid_amount drift(s) (the K2 lost update)`);
  },

  // D1 (KNOWN) - void a bill x void its payment. ap_void_bill_with_guard takes the BILL row, then the journal-entry counter (the
  //      reversal's number, je_next_number); ap_void_bill_payment_cascade takes the PAYMENT row, the same counter, then the BILL row
  //      (its allocation recompute updates the bill). Opposite order -> a cycle. A direct writer parks the bill void on the bill_post
  //      entry AFTER it holds the bill row, so the payment void can run to its own wait on the bill row (holding the counter);
  //      releasing the writer then closes the cycle. Both callers are the real functions. Postgres breaks it with 40P01: atomic and
  //      retryable, but a void that could have succeeded is aborted. Reproduced = a 40P01 observed (every ledger invariant must
  //      hold and re-running the loser must converge).
  // concurrency-proof: ap_void_bill_with_guard (D1 - KNOWN: bill row -> journal-entry counter, against the payment cascade's counter -> bill row)
  // concurrency-proof: ap_void_bill_payment_cascade (D1 - KNOWN: payment row -> journal-entry counter -> bill row, against the bill void's bill row -> counter)
  async D1() {
    const v = await mkVendor();
    const b = await mkBill(v);
    const p = await mkPayment(v, [{ bill: b, amount: 100 }]);
    const [h, a, x] = [await actor("writer"), await actor("void-payment"), await actor("void-bill")];
    await beginPlain(h);
    expectOk(await call(h, `update public.journal_entries set notes = notes where source_kind = 'bill_post' and source_id = $1 and status = 'posted'`, [b]), "writer");
    await begin(x);
    const px = andEnd(x, voidBill(x, b));
    await mustWait(x, "journal_entries", "the bill void holds the bill row and queues on the bill_post entry the writer holds");
    await begin(a);
    const pa = andEnd(a, voidPay(a, p));
    await mustWait(a, "bills", "the payment void (counter already held) queues on the bill row the bill void holds");
    await h.c.query("commit");
    const [oa, ox] = await Promise.all([pa, px]);
    console.log(`    evidence D1: void payment -> ${show(oa)}; void bill -> ${show(ox)}`);
    const dead = [oa, ox].filter((o) => !o.ok && o.code === "40P01").length;
    // Atomic whichever side lost: every invariant holds after re-running what was refused (the bill can only be voided once its
    // payment is, so a P0029 on the bill void is the expected refusal when the payment void was the one aborted).
    const [a2, x2] = [await actor("retry-payment"), await actor("retry-bill")];
    if (!oa.ok) {
      await begin(a2);
      expectOk(await andEnd(a2, voidPay(a2, p)), "retry of the payment void");
    }
    if (!ox.ok) {
      await begin(x2);
      expectOk(await andEnd(x2, voidBill(x2, b)), "retry of the bill void (the payment is voided now)");
    }
    await checkPayment(p, "D1 payment");
    await checkBill(b, "D1 bill");
    return dead > 0 ? "reproduced" : "not-reproduced";
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
type Status = "pass" | "fail" | "infra" | "known" | "fixed";
type Result = { status: Status; msg: string | null };
async function runAll(only: string[] | null): Promise<Record<string, Result>> {
  const result: Record<string, Result> = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    if (aborting) break;
    if (only && !only.includes(name)) continue;
    if (ONLY && !ONLY.has(name)) continue;
    let r: Result;
    try {
      const v = await fn();
      if (KNOWN.has(name)) r = v === "reproduced" ? { status: "known", msg: "reproduced" } : { status: "fixed", msg: "no longer reproduces" };
      else r = { status: "pass", msg: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A Fail is the behaviour under test being wrong; anything else (a fixture RPC, a dropped connection) is the proof's own plumbing.
      r = e instanceof Fail ? { status: "fail", msg } : { status: "infra", msg: `INFRA: ${msg}` };
    }
    result[name] = r;
    const tag = r.status === "pass" ? "ok   " : r.status === "known" ? "KNOWN" : r.status === "fixed" ? "FIXED" : "FAIL ";
    console.log(`  ${tag} ${name}${r.msg ? `: ${r.msg}` : ""}`);
    await closeAll();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mutants (copies in a throwaway schema; public is never touched)
// ---------------------------------------------------------------------------
type Mutant = {
  id: string;
  note: string;
  fn: string; // regprocedure
  slot: Slot;
  mustFail: string[];
  /** The failure every mustFail scenario must show: the OUTCOME the dropped guard protects (not merely a failure of some kind). */
  reason: RegExp;
  /** Scenarios that must still PASS against the mutant: they check shared behaviour, not the dropped guard. */
  mustPass?: string[];
};
/** Failures that say nothing about the guard: the interleaving was not reached, a wait or statement timed out, a fixture or setup call
 *  failed, a connection died. Never a catch, whatever the mutant's reason says. */
const INFRA_RE =
  /interleaving not reached|never blocked by|never waited|answered without waiting|statement timeout|canceling statement|57014|timed out|Connection terminated|terminating connection|^INFRA:/i;
const MUTANTS: Mutant[] = [
  { id: "MVP", note: "ap_void_bill_payment_cascade without the payment FOR UPDATE", fn: "public.ap_void_bill_payment_cascade(uuid,text,uuid)", slot: "voidPay", mustFail: ["P1"], reason: /second void: refused P0001 \(No posted JE found for source bill_payment/, mustPass: ["P3"] },
  { id: "MRA", note: "ap_reallocate_bill_payment without the payment FOR UPDATE", fn: "public.ap_reallocate_bill_payment(uuid,jsonb,uuid)", slot: "realloc", mustFail: ["P2", "P4"], reason: /reallocate after void: expected a refusal, but it succeeded|second reallocate: refused P0030 \(Allocation total/ },
  { id: "MVB", note: "ap_void_bill_with_guard without the bill FOR UPDATE", fn: "public.ap_void_bill_with_guard(uuid,text,uuid)", slot: "voidBill", mustFail: ["B1"], reason: /second void: refused P0001 \(No posted JE found for source bill_post/, mustPass: ["B3"] },
  { id: "MUD", note: "ap_update_bill_draft without the bill FOR UPDATE", fn: "public.ap_update_bill_draft(uuid,jsonb,uuid)", slot: "updDraft", mustFail: ["B6", "B8"], reason: /edit of a posted bill: expected a refusal, but it succeeded|edit of a deleted draft: expected P0002, got 23503/, mustPass: ["B5"] },
  { id: "MPR", note: "ap_post_recurring_template without the template FOR UPDATE", fn: "public.ap_post_recurring_template(uuid)", slot: "postTpl", mustFail: ["T1", "T2", "T3"], reason: /second run skipped: got|two bills for two different months: got|run of a deactivated template: expected a refusal, but it succeeded/ },
  { id: "MRJ", note: "ap_reverse_je_for_source without the journal-entry FOR UPDATE", fn: "public.ap_reverse_je_for_source(text,uuid,uuid)", slot: "revJe", mustFail: ["J1", "J2"], reason: /(second reversal|reversal behind the writer): expected a refusal, but it succeeded/ },
];

async function liveDef(sig: string): Promise<string> {
  return String((await q("select pg_get_functiondef($1::regprocedure) as d", [sig]))[0]!.d);
}
/** Copy the live function into `schema` with its one FOR UPDATE removed (throws if the live text no longer has exactly one). */
async function makeSchemaMutant(schema: string, m: Mutant): Promise<void> {
  const def = await liveDef(m.fn);
  const hits = def.match(/\s+for update;/g) ?? [];
  if (hits.length !== 1) throw new Error(`${m.id}: the live function has ${hits.length} «for update;» (want exactly 1) - update MUTANTS`);
  const name = m.fn.slice(m.fn.indexOf(".") + 1, m.fn.indexOf("("));
  const args = m.fn.slice(m.fn.indexOf("("));
  const body = def.replace(`public.${name}`, () => `${schema}.${name}`).replace(/\s+for update;/, () => ";");
  if (body === def) throw new Error(`${m.id}: mutation did not apply`);
  await monitor.query(`create schema ${schema}`);
  await monitor.query(body);
  await monitor.query(`grant usage on schema ${schema} to service_role`);
  await monitor.query(`grant execute on function ${schema}.${name}${args} to service_role`);
}

// ---------------------------------------------------------------------------
// Setup + cleanup
// ---------------------------------------------------------------------------
async function setup(): Promise<void> {
  ADMIN = await mkAdmin("admin");
  TODAY = String((await q(`select (now() at time zone 'Asia/Manila')::date::text as d`))[0]!.d);
  EXPENSE = String((await q(`select public.coa_uuid_for_code('6400') as id`))[0]!.id);
  BANK = String((await q(`select public.coa_uuid_for_code('1020') as id`))[0]!.id);
}

const TAG_RE = "(^|[^a-z0-9])aps-[0-9a-f]{6}";
const CTL_SCHEMA_RE = "^aps_ctl_[0-9a-f]{6}$";
/** Sweep every aps-tagged row (this run's and any crashed earlier run's). Returns how many cleanup steps FAILED (0 = clean). */
async function purge(c: Client = monitor): Promise<number> {
  let failed = 0;
  const step = async (sql: string, params: unknown[] = []) => {
    try {
      return await c.query(sql, params);
    } catch (e) {
      failed += 1;
      console.error("  cleanup step failed: " + (e as Error).message.split("\n")[0]);
      return null;
    }
  };
  const ids = async (sql: string) => ((await step(sql))?.rows ?? []).map((r) => r.id as string);
  const vendors = await ids("select id from public.vendors where name like 'aps-%'");
  const staff = await ids("select id from public.staff_profiles where full_name like 'aps-%'");
  const bills = (await step("select id from public.bills where vendor_id = any($1::uuid[]) or vendor_invoice_number ~ $2 or description ~ $2", [vendors, TAG_RE]))?.rows.map((r) => r.id as string) ?? [];
  const pays = (await step("select id from public.bill_payments where vendor_id = any($1::uuid[]) or reference ~ $2", [vendors, TAG_RE]))?.rows.map((r) => r.id as string) ?? [];
  const tpls = (await step("select id from public.recurring_bill_templates where vendor_id = any($1::uuid[]) or description like 'aps-%'", [vendors]))?.rows.map((r) => r.id as string) ?? [];
  // Triggers skipped (local only, this transaction only): je_status_balance_check would reject entries emptied line by line,
  // and the bills/payments triggers would post yet more journal entries.
  await step("begin");
  await step("set local session_replication_role = replica");
  await step(
    `with orig as (select id from public.journal_entries
                    where created_by = any($3::uuid[])
                       or (source_kind in ('bill_post', 'bill_payment') and source_id = any($1::uuid[] || $2::uuid[]))
                       or description ~ $4),
          allje as (select id from orig union select id from public.journal_entries where reverses in (select id from orig)),
          dl as (delete from public.journal_lines where entry_id in (select id from allje))
     delete from public.journal_entries where id in (select id from allje)`,
    [bills, pays, staff, TAG_RE],
  );
  await step("delete from public.bill_payment_allocations where payment_id = any($1::uuid[]) or bill_id = any($2::uuid[])", [pays, bills]);
  await step("delete from public.bill_payments where id = any($1::uuid[])", [pays]);
  await step("delete from public.bill_lines where bill_id = any($1::uuid[])", [bills]);
  await step("delete from public.bill_attachments where bill_id = any($1::uuid[])", [bills]);
  await step("delete from public.bills where id = any($1::uuid[])", [bills]);
  await step("delete from public.recurring_bill_templates where id = any($1::uuid[])", [tpls]);
  await step("delete from public.vendors where id = any($1::uuid[])", [vendors]);
  await step(
    "delete from public.audit_log where resource_id = any($1::uuid[] || $2::uuid[] || $3::uuid[]) or actor_id = any($4::uuid[])",
    [bills, pays, tpls, staff],
  );
  await step("commit");
  await step("delete from public.staff_profiles where id = any($1::uuid[])", [staff]);
  await step("delete from auth.users where email like '%@aps.example.test'");
  const schemas = (await step("select nspname from pg_namespace where nspname ~ '" + CTL_SCHEMA_RE + "'"))?.rows ?? [];
  for (const sc of schemas) await step("drop schema " + sc.nspname + " cascade");
  return failed;
}
/** Tagged rows still present: the fixtures by tag, and everything they posted (bills, payments, allocations, lines, audit rows,
 *  journal entries incl. reversals) by tag, by this run's minted ids and by its admin. */
async function leftovers(c: Client = monitor): Promise<number> {
  const r = await c.query<{ n: string }>(
    `select (select count(*) from public.vendors where name like 'aps-%')
          + (select count(*) from public.recurring_bill_templates where description like 'aps-%' or id = any($2::uuid[]))
          + (select count(*) from public.staff_profiles where full_name like 'aps-%')
          + (select count(*) from auth.users where email like '%@aps.example.test')
          + (select count(*) from public.bills where vendor_invoice_number ~ $1 or description ~ $1 or id = any($2::uuid[]))
          + (select count(*) from public.bill_lines where bill_id = any($2::uuid[]))
          + (select count(*) from public.bill_payments where reference ~ $1 or id = any($2::uuid[]))
          + (select count(*) from public.bill_payment_allocations where payment_id = any($2::uuid[]) or bill_id = any($2::uuid[]))
          + (select count(*) from public.audit_log where resource_id = any($2::uuid[]) or actor_id = nullif($3::text, '')::uuid)
          + (select count(*) from public.journal_entries where description ~ $1 or created_by = nullif($3::text, '')::uuid or source_id = any($2::uuid[]))
          + (select count(*) from pg_namespace where nspname ~ $4) as n`,
    [TAG_RE, madeIds, ADMIN, CTL_SCHEMA_RE],
  );
  return Number(r.rows[0]!.n);
}
/** SIGINT / SIGTERM: stop every backend of THIS run (by application_name) from a dedicated client - the actors may be parked on a lock
 *  and a queued ROLLBACK on their own connection would wait behind it - then sweep and count on that client. Returns the exit code. */
async function abortCleanup(sig: string, code: number): Promise<number> {
  aborting = true;
  console.log("\n  " + sig + " received - tearing down");
  const cleaner = new Client({ connectionString: DB_URL });
  cleaner.on("error", () => undefined);
  await cleaner.connect();
  await cleaner.query("select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and application_name = $1", [APP_NAME]);
  await sleep(300);
  const failedSteps = await purge(cleaner);
  const left = await leftovers(cleaner).catch(() => -1);
  await cleaner.end().catch(() => undefined);
  if (left !== 0 || failedSteps > 0) {
    console.log("  FAIL     teardown - " + left + " tagged rows left behind, " + failedSteps + " cleanup step(s) failed");
    return 1;
  }
  console.log("  teardown: every tagged row removed");
  return code;
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  monitor = await newClient();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('ap-subledger:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("another ap-subledger concurrency proof is running - exiting");
    process.exit(2);
  }
  let exit = 0;
  const cleanup = async (): Promise<void> => {
    await closeAll();
    const failedSteps = await purge();
    if (failedSteps > 0) {
      console.error(`FAIL: ${failedSteps} cleanup step(s) failed`);
      exit = 1;
    }
    const left = await leftovers().catch(() => -1);
    if (left !== 0) {
      console.error(`FAIL: ${left} tagged rows left behind`);
      exit = 1;
    }
  };
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      abortCleanup(sig, code)
        .catch((e) => {
          console.error(e);
          return 1;
        })
        .then((c) => process.exit(c));
    });
  }
  try {
    const have = Number(
      (
        await q(
          `select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1::text[])`,
          [["ap_void_bill_payment_cascade", "ap_reallocate_bill_payment", "ap_void_bill_with_guard", "ap_update_bill_draft", "ap_post_recurring_template", "ap_reverse_je_for_source", "ap_create_bill_and_post", "ap_create_bill_draft", "ap_create_bill_payment_with_allocations"]],
        )
      )[0]!.n,
    );
    if (have !== 9) throw new Error(`prerequisites missing by object: found ${have} of 9 AP functions (0049 must be applied)`);
    // A crashed earlier run may have left tagged rows or a control schema.
    if ((await purge()) > 0) throw new Error("the start-of-run sweep failed - not starting on a dirty stack");
    await setup();
    console.log(`Server: ${String((await q("select version() as v"))[0]!.v).split(",")[0]}; tag ${TAG}; ${ROUNDS} free-race rounds`);
    console.log("Real functions (public):");
    const real = await runAll(null);
    const asserted = Object.entries(real).filter(([id]) => !KNOWN.has(id));
    const passed = asserted.filter(([, r]) => r.status === "pass").length;
    const known = Object.values(real).filter((r) => r.status === "known").length;
    console.log(`${passed}/${asserted.length} scenarios passed; ${known} known issue(s) reproduced.`);
    if (passed !== asserted.length) exit = 1;
    // A KNOWN scenario must keep reproducing: a vanished bug (FIXED) or a broken scenario (FAIL) forces action.
    const knownBad = Object.entries(real).filter(([id, r]) => KNOWN.has(id) && r.status !== "known");
    if (knownBad.length) {
      console.log(`KNOWN scenario(s) no longer reproduce or broke: ${knownBad.map(([id, r]) => `${id} (${r.status})`).join(", ")} - promote or repair them`);
      exit = 1;
    }

    if (CONTROL && !aborting) {
      let caught = 0;
      let ran = 0;
      for (const m of MUTANTS) {
        if (aborting) break;
        if (ONLY && ![...m.mustFail, ...(m.mustPass ?? [])].some((s) => ONLY.has(s))) continue;
        ran += 1;
        console.log(`Control ${m.id}: ${m.note}`);
        const schema = `aps_ctl_${randomBytes(3).toString("hex")}`;
        try {
          await makeSchemaMutant(schema, m);
          FN[m.slot] = schema;
          relaxedWait = true;
          const res = await runAll([...m.mustFail, ...(m.mustPass ?? [])]);
          if (aborting) break;
          const wanted = m.mustFail.filter((x) => !ONLY || ONLY.has(x));
          const survived = wanted.filter((x) => res[x]?.status === "pass" || res[x]?.status === "known" || res[x]?.status === "fixed");
          // A failure counts as a catch only when it is a GUARD failure: not infrastructure, and the stated outcome.
          const infra = wanted.filter((x) => !res[x] || res[x]!.status === "infra" || (res[x]!.status === "fail" && INFRA_RE.test(res[x]!.msg ?? "")));
          const wrong = wanted.filter((x) => res[x]?.status === "fail" && !INFRA_RE.test(res[x]!.msg ?? "") && !m.reason.test(res[x]!.msg ?? ""));
          const broke = (m.mustPass ?? []).filter((x) => (!ONLY || ONLY.has(x)) && res[x]?.status !== "pass");
          if (survived.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: scenarios ${survived.join(", ")} still passed against the mutant - the proof cannot catch this bug`);
            exit = 1;
          } else if (infra.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: ${infra.map((x) => `${x} (${(res[x]?.msg ?? "not run").slice(0, 160)})`).join("; ")} failed for an infrastructure reason, which is not a catch`);
            exit = 1;
          } else if (wrong.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: failed for the wrong reason (wanted ${m.reason}): ${wrong.map((x) => `${x} ${(res[x]!.msg ?? "").slice(0, 160)}`).join("; ")}`);
            exit = 1;
          } else if (broke.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: ${broke.join(", ")} should pass against this mutant but ${broke.map((x) => res[x]?.msg).join("; ")}`);
            exit = 1;
          } else {
            caught += 1;
            console.log(`  control ${m.id} ok: ${wanted.join(", ")} failed against the mutant for the stated reason${m.mustPass ? `; ${m.mustPass.join(", ")} still pass (shared behaviour, see the header)` : ""}`);
            for (const x of wanted) console.log(`        ${x}: ${(res[x]!.msg ?? "").split("\n")[0]!.slice(0, 190)}`);
          }
        } finally {
          relaxedWait = false;
          for (const k of Object.keys(FN) as Slot[]) FN[k] = "public";
          if (!aborting) {
            await closeAll();
            await monitor.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
          }
        }
      }
      console.log(`${caught}/${ran} mutants caught.`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    exit = 1;
  } finally {
    if (aborting) await sleep(60000); // the signal handler is cleaning up and will exit
    await cleanup();
    const left = await leftovers().catch(() => -1);
    if (left === 0) console.log("Leftovers: 0");
    await monitor.query("select pg_advisory_unlock(hashtext('ap-subledger:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

main().catch(async (e) => {
  if (aborting) await sleep(60000);
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
