/**
 * smoke:locks — two-connection races for the patient lifecycle lock (0184).
 *
 * LOCAL ONLY. Creates its own staff/patients/visits/claims, runs each race
 * with two real connections (A = the lifecycle change, B = the writer), and
 * removes everything it created in `finally` (payments are hard-deleted, so
 * bridge_payment_delete leaves a net-zero reversal pair in the local ledger).
 *
 * Every race asserts BOTH that the second party waited and what it got.
 * Run: npm run smoke:locks   (needs the local stack with 0184 applied)
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd, hostOf, isLocalHost } from "./lib/env-guard";
import { randomUUID } from "node:crypto";
import pg from "pg";

requireLocalOrExplicitProd("smoke:locks", {
  writes:
    "creates and then removes temporary staff, patients, visits, lines, results, payments, appointments, one closure day it inserted itself and HMO claim rows (payment deletes leave net-zero reversal journal entries)",
});

const DB_URL =
  process.env.SMOKE_LOCKS_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!isLocalHost(hostOf(DB_URL))) {
  console.error("smoke:locks takes real locks and writes fixtures — it runs against the LOCAL stack only.");
  process.exit(1);
}

const ADMIN = randomUUID();
const RECEPTION = randomUUID();
const HMO = randomUUID();
const SERVICE = randomUUID();
const TAG = `LKR${Date.now().toString(36).toUpperCase()}`;
const made = {
  patients: [] as string[],
  batches: [] as string[],
  results: [] as string[],
  // closed_on values THIS run inserted (clinic_closures' PK is closed_on) —
  // cleanup deletes only these, never a closure that was already there (P2-7).
  closures: [] as string[],
};
let seq = 0;

type Client = pg.Client & { pid: number };
const results: { name: string; ok: boolean; detail: string }[] = [];

async function connect(): Promise<Client> {
  const c = new pg.Client({ connectionString: DB_URL }) as Client;
  await c.connect();
  await c.query("set lock_timeout = '15s'");
  c.pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  return c;
}

/** What connection `c` is waiting for right now, read from pg_locks by `s`. */
async function waitingOn(s: Client, c: Client): Promise<string> {
  const { rows } = await s.query(
    `select case when locktype = 'advisory' and classid = (hashtext('patient_lifecycle'))::oid then 'lifecycle'
                 when locktype = 'advisory' and classid = (hashtext('result_membership'))::oid then 'membership'
                 when locktype in ('transactionid', 'tuple') then 'row'
                 else locktype end as what
       from pg_locks where pid = $1 and not granted limit 1`,
    [c.pid],
  );
  return rows[0]?.what ?? "none";
}

/** A past Manila day with no closure and no appointment on it — verified, not assumed (P2-7). */
async function isolatedPastDay(s: Client): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const y = 1975 + Math.floor(Math.random() * 20);
    const m = 1 + Math.floor(Math.random() * 12);
    const d = 1 + Math.floor(Math.random() * 28);
    const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const { rows } = await s.query(
      `select exists (select 1 from public.clinic_closures where closed_on = $1::date)
           or exists (select 1 from public.appointments
                       where scheduled_at >= ($1::date)::timestamp at time zone 'Asia/Manila'
                         and scheduled_at <  ($1::date + 1)::timestamp at time zone 'Asia/Manila') as taken`,
      [day],
    );
    if (!rows[0].taken) return day;
  }
  throw new Error("could not find an empty past day for the closure race");
}

/** The appointment ids on a Manila day. */
async function appointmentsOn(s: Client, day: string): Promise<string[]> {
  const { rows } = await s.query(
    `select id from public.appointments
      where scheduled_at >= ($1::date)::timestamp at time zone 'Asia/Manila'
        and scheduled_at <  ($1::date + 1)::timestamp at time zone 'Asia/Manila' order by id`,
    [day],
  );
  return rows.map((r) => r.id as string);
}

/** SQLSTATE a promise rejected with, or "ok". */
async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? `error: ${(e as Error).message}`;
  }
}

/** True when `p` is still pending after `ms` — i.e. it is waiting on a lock. */
async function stillWaiting(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  return winner === pending;
}

function expectEq(label: string, got: unknown, want: unknown) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function race(name: string, fn: (a: Client, b: Client, s: Client) => Promise<void>) {
  const a = await connect();
  const b = await connect();
  const s = await connect();
  try {
    await fn(a, b, s);
    results.push({ name, ok: true, detail: "" });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
  } finally {
    for (const c of [a, b]) await c.query("rollback").catch(() => undefined);
    await Promise.all([a.end(), b.end(), s.end()]);
  }
}

// --- fixtures (setup client `s`, autocommit) ----------------------------------
async function mkPatient(s: Client, label: string): Promise<{ id: string; email: string; last: string }> {
  seq += 1;
  const last = `Lkr${seq}${label}`;
  const email = `${TAG.toLowerCase()}-${seq}@example.test`;
  const { rows } = await s.query(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, email)
     values ($1, 'Race', $2, '1990-01-01', $3) returning id`,
    [`DRM-${TAG}-${seq}`, last, email],
  );
  made.patients.push(rows[0].id);
  return { id: rows[0].id, email, last };
}
async function mkVisit(s: Client, patientId: string, hmo = false): Promise<string> {
  const { rows } = await s.query(
    `insert into public.visits (patient_id, payment_status, total_php, paid_php, hmo_provider_id)
     values ($1, 'unpaid', 0, 0, $2) returning id`,
    [patientId, hmo ? HMO : null],
  );
  return rows[0].id;
}
async function mkLine(s: Client, visitId: string, status: string, price: number): Promise<string> {
  const { rows } = await s.query(
    `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [visitId, SERVICE, status, ADMIN, price],
  );
  return rows[0].id;
}
async function mkPayment(s: Client, visitId: string, amount: number, method = "cash"): Promise<string> {
  const { rows } = await s.query(
    `insert into public.payments (visit_id, amount_php, method, received_by) values ($1, $2, $3, $4) returning id`,
    [visitId, amount, method, RECEPTION],
  );
  return rows[0].id;
}
/** A patient with one released, fully paid visit: kept history, nothing open. */
async function mkDeletable(s: Client, label: string) {
  const p = await mkPatient(s, label);
  const v = await mkVisit(s, p.id);
  await s.query(`update public.visits set total_php = 100 where id = $1`, [v]);
  const line = await mkLine(s, v, "released", 100);
  const pay = await mkPayment(s, v, 100);
  await assertDeletable(s, p.id);
  return { ...p, visit: v, line, pay };
}
async function assertDeletable(s: Client, patientId: string) {
  const { rows } = await s.query(`select public.patient_delete_blockers($1) as b`, [patientId]);
  const blockers = rows[0].b as unknown[];
  if (blockers.length > 0) {
    throw new Error(`fixture is not deletable — adjust it, blockers: ${JSON.stringify(blockers)}`);
  }
}
// concurrency-proof: delete_patient
const del = (c: Client, patientId: string) =>
  c.query(`select public.delete_patient($1, 'test_record', '', $2, '{}'::jsonb)`, [patientId, ADMIN]);
const tomorrowIso = () => new Date(Date.now() + 36 * 3600_000).toISOString();

async function setup(s: Client) {
  await s.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $3, '', now(), now(), now()),
            ($2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $4, '', now(), now(), now())`,
    [ADMIN, RECEPTION, `${TAG.toLowerCase()}-admin@example.test`, `${TAG.toLowerCase()}-rec@example.test`],
  );
  await s.query(
    `insert into public.staff_profiles (id, full_name, role, is_active)
     values ($1, 'Race Admin', 'admin', true), ($2, 'Race Reception', 'reception', true)`,
    [ADMIN, RECEPTION],
  );
  await s.query(`insert into public.services (id, code, name, price_php, kind) values ($1, $2, 'Race lab', 100, 'lab_test')`, [
    SERVICE,
    `${TAG}-LAB`,
  ]);
  await s.query(`insert into public.hmo_providers (id, name) values ($1, $2)`, [HMO, `${TAG} HMO`]);
}

async function cleanup(s: Client) {
  const ids = made.patients;
  if (ids.length === 0) return;
  // Restore anything we deleted, so the guards let the teardown through.
  await s.query(
    `select public.restore_patient(p.id, $2, '{}'::jsonb) from public.patients p
      where p.id = any($1::uuid[]) and p.deleted_at is not null`,
    [ids, ADMIN],
  );
  const steps = [
    `delete from public.hmo_payment_allocations where item_id in (select i.id from public.hmo_claim_items i join public.test_requests tr on tr.id = i.test_request_id join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[]))`,
    `delete from public.payments where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
    `delete from public.hmo_claim_items where test_request_id in (select tr.id from public.test_requests tr join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[]))`,
    `delete from public.test_requests where parent_id is not null and visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
    `delete from public.test_requests where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
    `delete from public.visits where patient_id = any($1::uuid[])`,
    `delete from public.appointments where patient_id = any($1::uuid[])`,
    `delete from public.audit_log where patient_id = any($1::uuid[])`,
    `delete from public.patients where id = any($1::uuid[])`,
  ];
  // Results first: their links reference test_requests with ON DELETE RESTRICT.
  if (made.results.length > 0) await s.query(`delete from public.results where id = any($1::uuid[])`, [made.results]);
  for (const sql of steps) await s.query(sql, [ids]);
  if (made.batches.length > 0) await s.query(`delete from public.hmo_claim_batches where id = any($1::uuid[])`, [made.batches]);
  // Only the days THIS run inserted (recorded from the insert that succeeded).
  if (made.closures.length > 0) await s.query(`delete from public.clinic_closures where closed_on = any($1::date[])`, [made.closures]);
  await s.query(`delete from public.audit_log where actor_id = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
  // Every payment insert/void this run triggers fires the op-GL bridge
  // (0030), posting a journal_entries row with created_by = the acting
  // staff — ADMIN or RECEPTION, always, since those are the only two staff
  // this script ever uses. journal_entries carries no FK back to payments,
  // so it survives the payment rows above; without deleting it here the
  // final staff_profiles delete fails on journal_entries_created_by_fkey
  // (found running this script: every settlement/void race leaves one).
  // session_replication_role = replica (local only, this transaction only)
  // skips je_lines_balance_check, which otherwise fires per-row as the lines
  // of an entry are deleted and rejects an entry left with zero lines mid-delete.
  await s.query("begin");
  await s.query("set local session_replication_role = replica");
  await s.query(
    `delete from public.journal_lines where entry_id in (select id from public.journal_entries where created_by = any($1::uuid[]))`,
    [[ADMIN, RECEPTION]],
  );
  await s.query(`delete from public.journal_entries where created_by = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
  await s.query("commit");
  await s.query(`delete from public.services where id = $1`, [SERVICE]);
  await s.query(`delete from public.hmo_providers where id = $1`, [HMO]);
  await s.query(`delete from public.staff_profiles where id = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
  await s.query(`delete from auth.users where id = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
}

// --- races ----------------------------------------------------------------------
async function main() {
  const s = await connect();
  try {
    await setup(s);

    await race("delete first → new visit refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DV");
      await a.query("begin");
      await del(a, p.id);
      await b.query("begin");
      const w = stateOf(b.query(`insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'unpaid', 0, 0)`, [p.id]));
      expectEq("writer waited", await stillWaiting(w), true);
      expectEq("…on the lifecycle lock (not a row)", await waitingOn(s2, b), "lifecycle");
      await a.query("commit");
      expectEq("writer outcome", await w, "P0058");
    });

    await race("new visit first → delete sees it (P0059)", async (a, b, s2) => {
      const p = await mkPatient(s2, "VD");
      await b.query("begin");
      await b.query(`insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'unpaid', 0, 0)`, [p.id]);
      await a.query("begin");
      const d = stateOf(del(a, p.id));
      expectEq("delete waited", await stillWaiting(d), true);
      expectEq("…on the lifecycle lock", await waitingOn(s2, a), "lifecycle");
      await b.query("commit");
      expectEq("delete outcome", await d, "P0059");
    });
    // concurrency-proof: appointments_insert_slot_guarded

    await race("delete first → booking RPC refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DA");
      await a.query("begin");
      await del(a, p.id);
      const rows = JSON.stringify([{ patient_id: p.id, status: "confirmed", scheduled_at: tomorrowIso() }]);
      const w = stateOf(b.query(`select public.appointments_insert_slot_guarded($1::jsonb)`, [rows]));
      expectEq("booking waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("booking outcome", await w, "P0058");
    });

    await race("booking first → delete sees the appointment (P0059)", async (a, b, s2) => {
      const p = await mkPatient(s2, "AD");
      const rows = JSON.stringify([{ patient_id: p.id, status: "confirmed", scheduled_at: tomorrowIso() }]);
      await b.query("begin");
      await b.query(`select public.appointments_insert_slot_guarded($1::jsonb)`, [rows]);
      await a.query("begin");
      const d = stateOf(del(a, p.id));
      expectEq("delete waited", await stillWaiting(d), true);
      await b.query("commit");
      expectEq("delete outcome", await d, "P0059");
    });

    await race("delete first → new line on an old visit refused", async (a, b, s2) => {
      const p = await mkDeletable(s2, "DL");
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php) values ($1, $2, 'requested', $3, 10, 10)`,
        [p.visit, SERVICE, ADMIN]));
      expectEq("writer waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("writer outcome", await w, "P0058");
    });

    await race("delete first → payment void refused", async (a, b, s2) => {
      const p = await mkDeletable(s2, "DP");
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `update public.payments set voided_at = now(), voided_by = $2, void_reason = 'race' where id = $1`, [p.pay, ADMIN]));
      expectEq("void waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("void outcome", await w, "P0058");
    });

    await race("delete first → visit restore refused", async (a, b, s2) => {
      const p = await mkDeletable(s2, "DR");
      const v2 = await mkVisit(s2, p.id);
      await s2.query(`update public.visits set deleted_at = now(), deleted_by = $2, delete_reason = 'race' where id = $1`, [v2, ADMIN]);
      await assertDeletable(s2, p.id);
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `update public.visits set deleted_at = null, deleted_by = null, delete_reason = null where id = $1`, [v2]));
      expectEq("restore waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("restore outcome", await w, "P0058");
    });

    await race("delete first → HMO batch reopen refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DH");
      const v = await mkVisit(s2, p.id, true);
      await s2.query(`update public.visits set total_php = 100 where id = $1`, [v]);
      const line = await mkLine(s2, v, "released", 100);
      await s2.query(`update public.test_requests set hmo_approved_amount_php = 100, hmo_provider_id = $2 where id = $1`, [line, HMO]);
      const b1 = (await s2.query(`insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO])).rows[0].id;
      const b2 = (await s2.query(`insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO])).rows[0].id;
      made.batches.push(b1, b2);
      await s2.query(`insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100)`, [b1, line]);
      await s2.query(`update public.hmo_claim_batches set voided_at = now(), voided_by = $2, void_reason = 'race', status = 'voided' where id = $1`, [b1, ADMIN]);
      const i2 = (await s2.query(`insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100) returning id`, [b2, line])).rows[0].id;
      const pay = await mkPayment(s2, v, 100, "hmo");
      await s2.query(`insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values ($1, $2, 100)`, [pay, i2]);
      await assertDeletable(s2, p.id);
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `update public.hmo_claim_batches set voided_at = null, voided_by = null, void_reason = null, status = 'submitted' where id = $1`, [b1]));
      expectEq("reopen waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("reopen outcome", await w, "P0058");
    });

    await race("delete first → patient edit refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DE");
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(`update public.patients set phone = '09170000000' where id = $1`, [p.id]));
      expectEq("edit waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("edit outcome", await w, "P0058");
    });

    // concurrency-proof: resolve_patient_guarded
    await race("resolver blocked behind a delete re-reads (P0072), retry gets a fresh record", async (a, b, s2) => {
      const p = await mkPatient(s2, "RB");
      const fields = JSON.stringify({ first_name: "Race", last_name: p.last, birthdate: "1990-01-01", email: p.email });
      await a.query("begin");
      await del(a, p.id);
      const resolve = () => b.query(`select * from public.resolve_patient_guarded($1, $2, '1990-01-01', $3::jsonb)`, [p.email, p.last, fields]);
      const w = stateOf(resolve());
      expectEq("resolver waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("resolver outcome", await w, "P0072");
      const again = await resolve();
      expectEq("retry reused", again.rows[0].reused, false);
      made.patients.push(again.rows[0].id);
      if (again.rows[0].id === p.id) throw new Error("retry reused the deleted record");
    });

    await race("two resolves of a deleted identity → one fresh record", async (a, b, s2) => {
      const p = await mkPatient(s2, "RR");
      await del(s2, p.id);
      const fields = JSON.stringify({ first_name: "Race", last_name: p.last, birthdate: "1990-01-01", email: p.email });
      const q = `select * from public.resolve_patient_guarded($1, $2, '1990-01-01', $3::jsonb)`;
      await a.query("begin");
      const first = await a.query(q, [p.email, p.last, fields]);
      await b.query("begin");
      const second = b.query(q, [p.email, p.last, fields]);
      expectEq("second waited on the identity lock", await stillWaiting(second), true);
      await a.query("commit");
      const got = await second;
      await b.query("commit");
      made.patients.push(first.rows[0].id);
      expectEq("first created", first.rows[0].reused, false);
      expectEq("second reused the same fresh record", `${got.rows[0].id}|${got.rows[0].reused}`, `${first.rows[0].id}|true`);
    });

    await race("delayed booking after resolution is refused once the record is deleted", async (a, b, s2) => {
      const p = await mkPatient(s2, "RL");
      const fields = JSON.stringify({ first_name: "Race", last_name: p.last, birthdate: "1990-01-01", email: p.email });
      const r = await b.query(`select * from public.resolve_patient_guarded($1, $2, '1990-01-01', $3::jsonb)`, [p.email, p.last, fields]);
      expectEq("resolved to the existing record", r.rows[0].id, p.id);
      await del(a, p.id);
      const rows = JSON.stringify([{ patient_id: p.id, status: "confirmed", scheduled_at: tomorrowIso() }]);
      expectEq("booking outcome", await stateOf(b.query(`select public.appointments_insert_slot_guarded($1::jsonb)`, [rows])), "P0058");
    });

    await race("a record moved to another patient while the writer waited → P0072", async (a, b, s2) => {
      const p = await mkPatient(s2, "MP");
      const q = await mkPatient(s2, "MQ");
      const v = await mkVisit(s2, p.id);
      await a.query("begin");
      await a.query(`update public.visits set patient_id = $2 where id = $1`, [v, q.id]);
      await b.query("begin");
      const w = stateOf(b.query(
        `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php) values ($1, $2, 'requested', $3, 10, 10)`,
        [v, SERVICE, ADMIN]));
      expectEq("writer waited", await stillWaiting(w), true);
      expectEq("…on the lifecycle lock", await waitingOn(s2, b), "lifecycle");
      await a.query("commit");
      expectEq("writer outcome", await w, "P0072");
    });

    await race("deadlock aborts the whole transaction; a retry succeeds", async (a, b, s2) => {
      const p = await mkPatient(s2, "KP");
      const q = await mkPatient(s2, "KQ");
      const v1 = await mkVisit(s2, p.id);
      const vx = await mkVisit(s2, p.id);
      const tr1 = await mkLine(s2, v1, "requested", 10);
      await a.query("begin");
      await a.query(`update public.test_requests set receptionist_remarks = 'A' where id = $1`, [tr1]); // shared p + row tr1
      await b.query("begin");
      const bMove = stateOf(b.query(`update public.visits set patient_id = $2 where id = $1`, [vx, q.id])); // row vx, waits EXCLUSIVE p
      expectEq("B waited", await stillWaiting(bMove), true);
      const aTouch = stateOf(a.query(`update public.visits set notes = 'A' where id = $1`, [vx])); // waits row vx → cycle
      // The victim settles first (deadlock_timeout); the survivor cannot finish
      // until the victim rolls back, so never await both together.
      const first = await Promise.race([
        aTouch.then((st) => ({ who: "A" as const, st })),
        bMove.then((st) => ({ who: "B" as const, st })),
      ]);
      expectEq("the first to settle is the deadlock victim", first.st, "40P01");
      if (first.who === "A") {
        await a.query("rollback");
        expectEq("B then completes", await bMove, "ok");
        await b.query("commit");
        const { rows } = await s2.query(`select receptionist_remarks from public.test_requests where id = $1`, [tr1]);
        expectEq("victim A's earlier statement was rolled back too", rows[0].receptionist_remarks, null);
        expectEq("A's retry (whole transaction) succeeds",
          await stateOf(a.query(`update public.test_requests set receptionist_remarks = 'A' where id = $1`, [tr1])), "ok");
      } else {
        await b.query("rollback");
        expectEq("A then completes", await aTouch, "ok");
        await a.query("commit");
        const { rows } = await s2.query(`select patient_id from public.visits where id = $1`, [vx]);
        expectEq("victim B's move was rolled back", rows[0].patient_id, p.id);
        expectEq("B's retry succeeds",
          await stateOf(b.query(`update public.visits set patient_id = $2 where id = $1`, [vx, q.id])), "ok");
      }
    });

    // HMO batch rollup (Codex plan review P2-5). Three separate scenarios:
    // both successful settlements COMMIT and the batch ends paid; a competing
    // settlement of one item is refused; and the rollup's own batch lock
    // (not only the RPC's) serialises two plain allocation inserts.
    async function mkBatchOfTwo(s2: Client, label: string) {
      const pa = await mkPatient(s2, `${label}A`);
      const pb = await mkPatient(s2, `${label}B`);
      const va = await mkVisit(s2, pa.id, true);
      const vb = await mkVisit(s2, pb.id, true);
      const bat = (await s2.query(`insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO])).rows[0].id as string;
      made.batches.push(bat);
      const item = async (v: string) =>
        (await s2.query(`insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100) returning id`,
          [bat, await mkLine(s2, v, "released", 100)])).rows[0].id as string;
      return { bat, va, vb, ia: await item(va), ib: await item(vb) };
    }
    // concurrency-proof: record_hmo_settlement
    const settle = (c: Client, bat: string, item: string) =>
      c.query(`select public.record_hmo_settlement($1, $2, 100, now(), $3::jsonb)`,
        [ADMIN, bat, JSON.stringify([{ item_id: item, amount_php: 100 }])]);
    async function batchState(s2: Client, bat: string) {
      const { rows } = await s2.query(
        `select b.status,
                (select count(*) from public.hmo_claim_items i where i.batch_id = b.id and i.paid_amount_php = i.billed_amount_php)::int as paid_items,
                (select count(*) from public.hmo_payment_allocations al join public.hmo_claim_items i on i.id = al.item_id
                  where i.batch_id = b.id and al.voided_at is null)::int as allocations,
                (select count(*) from public.payments p join public.hmo_payment_allocations al on al.payment_id = p.id
                  join public.hmo_claim_items i on i.id = al.item_id where i.batch_id = b.id and p.voided_at is null)::int as payments
           from public.hmo_claim_batches b where b.id = $1`, [bat]);
      return `${rows[0].status}|${rows[0].paid_items}|${rows[0].allocations}|${rows[0].payments}`;
    }

    await race("two settlements of the last two items of one batch BOTH commit → batch paid", async (a, b, s2) => {
      const f = await mkBatchOfTwo(s2, "S2");
      await a.query("begin");
      await settle(a, f.bat, f.ia);
      await b.query("begin");
      const other = stateOf(settle(b, f.bat, f.ib));
      expectEq("the second settlement waits for the first (batch row)", await stillWaiting(other), true);
      expectEq("…on a row lock, not a patient lock", await waitingOn(s2, b), "row");
      await a.query("commit");
      expectEq("B settled", await other, "ok");
      await b.query("commit");
      expectEq("durable: batch paid, 2 items paid, 2 allocations, 2 payments", await batchState(s2, f.bat), "paid|2|2|2");
    });

    await race("a competing settlement of the SAME item is refused (P0012)", async (a, b, s2) => {
      const f = await mkBatchOfTwo(s2, "SC");
      await a.query("begin");
      await settle(a, f.bat, f.ia);
      await b.query("begin");
      const same = stateOf(settle(b, f.bat, f.ia));
      expectEq("the same item waits", await stillWaiting(same), true);
      await a.query("commit");
      expectEq("the second settlement of that item", await same, "P0012");
      await b.query("rollback");
      expectEq("durable: only A's allocation", await batchState(s2, f.bat), "submitted|1|1|1");
    });

    await race("the rollup itself serialises: two plain allocation inserts on the last two items → batch paid", async (a, b, s2) => {
      const f = await mkBatchOfTwo(s2, "SR");
      const pa = await mkPayment(s2, f.va, 100, "hmo");
      const pb = await mkPayment(s2, f.vb, 100, "hmo");
      const alloc = (c: Client, pay: string, item: string) =>
        c.query(`insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values ($1, $2, 100)`, [pay, item]);
      await a.query("begin");
      await alloc(a, pa, f.ia);
      await b.query("begin");
      const second = stateOf(alloc(b, pb, f.ib));
      expectEq("the second rollup waits on the batch row", await stillWaiting(second), true);
      await a.query("commit");
      expectEq("B allocated", await second, "ok");
      await b.query("commit");
      expectEq("durable: batch paid (the rollup saw A's commit)", (await batchState(s2, f.bat)).split("|")[0], "paid");
    });

    // Mixed HMO writers (Codex recheck P2-2): the settlement RPC against the
    // EXISTING allocation action's plain insert, each going first, on
    // different items and on the SAME item. One lock order (batch → items)
    // means the second waits on the batch row and is never a deadlock victim.
    for (const sameItem of [false, true]) {
      for (const first of ["settlement", "allocation"] as const) {
        await race(`mixed HMO writers, ${first} first, ${sameItem ? "same" : "different"} item → no deadlock`, async (a, b, s2) => {
          const f = await mkBatchOfTwo(s2, `X${sameItem ? "S" : "D"}${first === "settlement" ? "S" : "A"}`);
          const allocItem = sameItem ? f.ia : f.ib;
          const allocPay = await mkPayment(s2, sameItem ? f.va : f.vb, 100, "hmo");
          const doSettle = (c: Client) => settle(c, f.bat, f.ia);
          const doAlloc = (c: Client) =>
            c.query(`insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values ($1, $2, 100)`, [allocPay, allocItem]);
          const [one, two] = first === "settlement" ? [doSettle, doAlloc] : [doAlloc, doSettle];
          await a.query("begin");
          await one(a);
          await b.query("begin");
          const w = stateOf(two(b));
          expectEq("the second writer waits", await stillWaiting(w), true);
          expectEq("…on a row (the batch), not in a deadlock", await waitingOn(s2, b), "row");
          await a.query("commit");
          const got = await w;
          expectEq("never a deadlock victim", got === "40P01", false);
          expectEq("second writer outcome", got, sameItem ? "P0012" : "ok");
          await b.query(sameItem ? "rollback" : "commit");
          expectEq("durable batch state", await batchState(s2, f.bat), sameItem ? "submitted|1|1|1" : "paid|2|2|2");
        });
      }
    }

    // Result membership (Codex plan review P1-2).
    async function mkResult(s2: Client): Promise<string> {
      const r = (await s2.query(`insert into public.results (generation_kind, uploaded_by) values ('structured', $1) returning id`, [ADMIN])).rows[0].id as string;
      made.results.push(r);
      return r;
    }
    const resultWrite = (c: Client, r: string) =>
      c.query(`update public.results set notes = 'race' where id = $1`, [r]);   // a results-family write (shared membership)
    const link = (c: Client, r: string, tr: string) =>
      c.query(`insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)`, [r, tr]);

    await race("membership: linking a result waits for a writer of that (still unlinked) result", async (a, b, s2) => {
      const p = await mkPatient(s2, "MU");
      const v = await mkVisit(s2, p.id);
      const tr = await mkLine(s2, v, "in_progress", 10);
      const r = await mkResult(s2);
      await a.query("begin");
      await resultWrite(a, r);                       // unlinked: patients {} — only the membership lock
      await b.query("begin");
      const l = stateOf(link(b, r, tr));
      expectEq("the link waited", await stillWaiting(l), true);
      expectEq("…on the membership lock", await waitingOn(s2, b), "membership");
      await a.query("commit");
      expectEq("link outcome", await l, "ok");
      await b.query("commit");
    });

    await race("membership: a writer queued behind a link then locks the NEW patient", async (a, b, s2) => {
      const q = await mkPatient(s2, "MQ2");
      const v = await mkVisit(s2, q.id);
      const tr = await mkLine(s2, v, "in_progress", 10);
      const r = await mkResult(s2);
      await b.query("begin");
      await link(b, r, tr);                          // exclusive membership on r, shared lifecycle on q
      await a.query("begin");
      const w = stateOf(resultWrite(a, r));
      expectEq("the writer waited", await stillWaiting(w), true);
      expectEq("…on the membership lock", await waitingOn(s2, a), "membership");
      await b.query("commit");
      expectEq("writer outcome", await w, "ok");
      const { rows } = await s2.query(
        `select exists (select 1 from pg_locks where pid = $1 and locktype = 'advisory' and granted
                         and classid = (hashtext('patient_lifecycle'))::oid and objid = (hashtext($2::text))::oid) as held`,
        [a.pid, q.id]);
      expectEq("the writer holds the lifecycle lock of the patient the result now belongs to", rows[0].held, true);
      await a.query("commit");
    });

    await race("cancel/no-show never wait for a delete in progress (no lock on the exception path)", async (a, b, s2) => {
      const p = await mkPatient(s2, "CN");
      // A PAST confirmed appointment does not block deletion.
      const ap = (await s2.query(
        `insert into public.appointments (patient_id, status, scheduled_at) values ($1, 'confirmed', now() - interval '10 days') returning id`,
        [p.id])).rows[0].id;
      await assertDeletable(s2, p.id);
      await a.query("begin");
      await del(a, p.id);                       // holds the EXCLUSIVE lifecycle lock
      const w = stateOf(b.query(`update public.appointments set status = 'no_show' where id = $1`, [ap]));
      expectEq("no-show did not wait", await stillWaiting(w, 300), false);
      expectEq("no-show outcome", await w, "ok");
      await a.query("commit");
    });

    await race("closure reschedule: a delete committed first is skipped; a cancel committed first is left alone", async (a, b, s2) => {
      // An ISOLATED past day (Codex plan review P2-7): the RPC acts on every
      // eligible appointment of the day, so the day must hold only ours —
      // checked BEFORE anything is changed. Past, so its confirmed
      // appointments do not block deletion. The closure is inserted with no
      // ON CONFLICT: if it already existed the insert fails and nothing of
      // anyone else's is touched or later deleted.
      const day = await isolatedPastDay(s2);
      await s2.query(`insert into public.clinic_closures (closed_on, reason, created_by) values ($1, 'race', $2)`, [day, ADMIN]);
      made.closures.push(day);                      // recorded only after OUR insert succeeded
      const pd = await mkPatient(s2, "CD");
      const pc = await mkPatient(s2, "CC");
      const pk = await mkPatient(s2, "CK");
      const ins = `insert into public.appointments (patient_id, status, scheduled_at) values ($1, 'confirmed', $2::timestamptz) returning id`;
      const apD = (await s2.query(ins, [pd.id, `${day} 09:00+08`])).rows[0].id as string;
      const apC = (await s2.query(ins, [pc.id, `${day} 10:00+08`])).rows[0].id as string;
      const apK = (await s2.query(ins, [pk.id, `${day} 11:00+08`])).rows[0].id as string;
      expectEq("the day holds exactly our three appointments", (await appointmentsOn(s2, day)).join(","), [apD, apC, apK].sort().join(","));
      await assertDeletable(s2, pd.id);
      await a.query("begin");
      await del(a, pd.id);
      await a.query(`update public.appointments set status = 'cancelled' where id = $1`, [apC]);
      // concurrency-proof: reschedule_closure_appointments
      const w = b.query(`select public.reschedule_closure_appointments($1, $2, false, null) as r`, [day, ADMIN]);
      expectEq("reschedule waited", await stillWaiting(w.then(() => undefined)), true);
      expectEq("…on the deleted patient's lifecycle lock", await waitingOn(s2, b), "lifecycle");
      await a.query("commit");
      const r = (await w).rows[0].r as { affected: number; skipped_inactive: number; skipped_changed: number };
      expectEq("only the untouched patient moved", r.affected, 1);
      expectEq("the deleted patient was skipped", r.skipped_inactive, 1);
      expectEq("the cancelled row counted as changed", r.skipped_changed, 1);
      const { rows: moved } = await s2.query(
        `select resource_id from public.audit_log where action = 'appointment.bulk_rescheduled_for_closure'
            and metadata ->> 'closed_on' = $1 order by 1`, [day]);
      expectEq("the moved row is ours and only ours", moved.map((m) => m.resource_id).join(","), apK);
    });

    // =========================================================================
    // Controller-added races (a)-(c) — beyond the plan's list.
    // =========================================================================

    // (a) HMO payment VOID vs record_hmo_settlement on the SAME batch AND the
    // SAME visit — the real deadlock fixed in d7bb490c. The void's chain is
    // payments (a_lifecycle_guard, patient shared) -> trg_payments_waived_visit_guard
    // (visit FOR UPDATE) -> [AFTER] hmo_payment_allocations UPDATE ->
    // a_lifecycle_hmo_batch_lock (batch FOR NO KEY UPDATE). The settlement's
    // chain is patient shared -> visit FOR UPDATE -> batch FOR NO KEY UPDATE ->
    // items FOR UPDATE -> payment insert. Both lock the visit before the
    // batch, so no cycle is possible; a mutation proof is not required here,
    // only that ~10 concurrent iterations never see 40P01.
    await race("HMO payment void vs settlement, same visit, same batch — never a deadlock (10 iterations)", async (a, b, s2) => {
      for (let i = 0; i < 10; i++) {
        const p = await mkPatient(s2, `VS${i}`);
        const v = await mkVisit(s2, p.id, true);
        await s2.query(`update public.visits set total_php = 200 where id = $1`, [v]);
        const tr1 = await mkLine(s2, v, "released", 100);
        const tr2 = await mkLine(s2, v, "released", 100);
        const bat = (await s2.query(
          `insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO],
        )).rows[0].id as string;
        made.batches.push(bat);
        const i1 = (await s2.query(
          `insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100) returning id`,
          [bat, tr1],
        )).rows[0].id as string;
        const i2 = (await s2.query(
          `insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100) returning id`,
          [bat, tr2],
        )).rows[0].id as string;
        // An earlier, already-recorded settlement of item 1 — the payment we
        // will now void, concurrently with settling item 2 of the same batch.
        const pay0 = await mkPayment(s2, v, 100, "hmo");
        await s2.query(`insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values ($1, $2, 100)`, [pay0, i1]);

        const voidOutcome = stateOf(
          a.query(`update public.payments set voided_at = now(), voided_by = $2, void_reason = 'race' where id = $1`, [pay0, ADMIN]),
        );
        const settleOutcome = stateOf(settle(b, bat, i2));
        const [rv, rs] = await Promise.all([voidOutcome, settleOutcome]);
        expectEq(`iteration ${i}: void did not deadlock`, rv === "40P01", false);
        expectEq(`iteration ${i}: settlement did not deadlock`, rs === "40P01", false);
        expectEq(`iteration ${i}: void outcome`, rv, "ok");
        expectEq(`iteration ${i}: settlement outcome`, rs, "ok");
      }
    });

    // concurrency-proof: result_edit_commit
    // (b) result_edit_commit's v_replay_first path: session 1 (here, the
    // pre-check) sees a COMMITTED amendment for attempt X. Before session 2's
    // own re-check runs, the amendment vanishes — its test is unlinked and
    // then hard-deleted, which ON DELETE CASCADEs the amendment away — while
    // the result itself lives on via a second, still-linked test. Session 2
    // is forced to observe this ordering by blocking on the results row lock
    // (a's "for update"), which is exactly where the v_replay_first branch
    // resumes after skipping both advisory locks.
    await race("result_edit_commit: an attempt whose amendment vanishes once locked → P0066 (v_replay_first path)", async (a, b, s2) => {
      const p = await mkPatient(s2, "RE");
      const v = await mkVisit(s2, p.id);
      const tr1 = await mkLine(s2, v, "in_progress", 10); // deleted mid-race
      const tr2 = await mkLine(s2, v, "in_progress", 10); // keeps the result non-empty
      const r = await mkResult(s2);
      await link(s2, r, tr1);
      await link(s2, r, tr2);
      const attempt = randomUUID();
      await s2.query(
        `insert into public.result_amendments
           (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at,
            reason, amended_by, amendment_seq, attempt_id)
         values ($1, $2, 'x/prior.pdf', $3, now(), 'race fixture attempt', $3, 1, $4)`,
        [r, tr1, ADMIN, attempt],
      );

      await a.query("begin");
      await a.query(`select * from public.results where id = $1 for update`, [r]);

      const call = stateOf(b.query(
        `select public.result_edit_commit($1, $2, 0, $3, 'race edit reason', $4, 'x/new.pdf', 1, null, null, null)`,
        [attempt, r, ADMIN, tr1],
      ));
      expectEq("the call waited on the results row lock", await stillWaiting(call), true);
      expectEq("…on a row (v_replay_first skipped both advisory locks)", await waitingOn(s2, b), "row");

      // Unlink then hard-delete tr1 while the call waits: ON DELETE CASCADE
      // removes the amendment the pre-check just saw, without touching the
      // results row (tr2 keeps it alive).
      await s2.query(`delete from public.result_test_requests where result_id = $1 and test_request_id = $2`, [r, tr1]);
      await s2.query(`delete from public.test_requests where id = $1`, [tr1]);

      await a.query("commit");
      expectEq("the call ends P0066 once it finds the attempt gone", await call, "P0066");
    });

    // concurrency-proof: lifecycle_lock, lifecycle_lock_and_assert
    // (c) Sorted lock acquisition (proves the sort in lifecycle_lock): two
    // sessions call lifecycle_lock_and_assert on the SAME two patients in
    // OPPOSITE array order, both EXCLUSIVE so they genuinely contend. Without
    // the sort inside lifecycle_lock, opposite caller orders could acquire in
    // opposite real orders and deadlock (classic AB-BA); with it, both always
    // acquire in the same (hash) order regardless of the array they passed.
    await race("sorted lock acquisition: opposite array order never deadlocks (10 iterations)", async (a, b, s2) => {
      const p1 = await mkPatient(s2, "SO1");
      const p2 = await mkPatient(s2, "SO2");
      for (let i = 0; i < 10; i++) {
        await a.query("begin");
        await b.query("begin");
        const ra = stateOf(a.query(`select public.lifecycle_lock_and_assert(array[$1,$2]::uuid[], true)`, [p1.id, p2.id]));
        const rb = stateOf(b.query(`select public.lifecycle_lock_and_assert(array[$1,$2]::uuid[], true)`, [p2.id, p1.id]));
        // Advisory XACT locks release at COMMIT, not at statement completion —
        // whichever call settles first must commit immediately, or the other
        // (legitimately blocked on the same, sorted, first key) waits forever
        // and trips lock_timeout instead of proving anything. This is a
        // property of the harness, not of lifecycle_lock: awaiting both
        // together before either commits self-deadlocks the TEST.
        const first = await Promise.race([
          ra.then((st) => ({ who: "a" as const, st })),
          rb.then((st) => ({ who: "b" as const, st })),
        ]);
        expectEq(`iteration ${i}: first settler did not deadlock`, first.st === "40P01", false);
        await (first.who === "a" ? a : b).query(first.st === "ok" ? "commit" : "rollback").catch(() => undefined);
        const [got_a, got_b] = await Promise.all([ra, rb]);
        expectEq(`iteration ${i}: A did not deadlock`, got_a === "40P01", false);
        expectEq(`iteration ${i}: B did not deadlock`, got_b === "40P01", false);
        expectEq(`iteration ${i}: both locked successfully`, `${got_a}|${got_b}`, "ok|ok");
        const second = first.who === "a" ? { conn: b, st: got_b } : { conn: a, st: got_a };
        await second.conn.query(second.st === "ok" ? "commit" : "rollback").catch(() => undefined);
      }
    });

    // (c-control) Control arm for the race above (fix round 7, task 4): the
    // sorted arm asserting "0 deadlocks over N iterations" only means
    // something if the harness genuinely makes the two sessions overlap on
    // the same two keys. Without a control, "0 deadlocks" could just as
    // easily mean the sort works OR that A and B's second statements never
    // actually raced in the first place (e.g. one always settles before the
    // other starts). This proves the overlap is real: the SAME two sessions
    // take two RAW pg_advisory_xact_lock calls — no lifecycle_lock, no sort —
    // on the SAME two keys in OPPOSITE order, using the identical key
    // derivation lifecycle_lock uses internally (section (1):
    // `hashtext('patient_lifecycle')` as classid, `hashtext(<id>::text)` as
    // objid — just called directly, unsorted). Over 20 iterations this MUST
    // produce at least one real 40P01: if it never does, the harness itself
    // is not overlapping the two sessions and the sorted arm's "0" above
    // proves nothing. Every lock taken here is xact-scoped and every
    // iteration ends in commit/rollback, so nothing leaks past this race.
    await race("control: unsorted raw advisory locks in opposite order DO deadlock (>=1 of 20) — proves the harness overlaps", async (a, b, s2) => {
      const p1 = await mkPatient(s2, "CTL1");
      const p2 = await mkPatient(s2, "CTL2");
      const rawLock = (c: Client, id: string) =>
        c.query(`select pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext($1::text))`, [id]);
      let deadlocks = 0;
      for (let i = 0; i < 20; i++) {
        await a.query("begin");
        await b.query("begin");
        // First lock of each session: different keys, uncontended — both grant
        // immediately, establishing "A holds p1" / "B holds p2" before either
        // reaches for the other's key.
        await rawLock(a, p1.id);
        await rawLock(b, p2.id);
        // Second lock of each, OPPOSITE order, fired concurrently: A now wants
        // p2 (held by B), B now wants p1 (held by A) — the classic AB-BA
        // shape. Never await one before starting the other, or there is
        // nothing left to overlap.
        const ra = stateOf(rawLock(a, p2.id));
        const rb = stateOf(rawLock(b, p1.id));
        const [got_a, got_b] = await Promise.all([ra, rb]);
        if (got_a === "40P01" || got_b === "40P01") deadlocks++;
        // Whichever side aborted must rollback (its transaction is already
        // dead); the other can commit or rollback freely — either releases
        // its xact-scoped advisory locks the same way.
        await a.query(got_a === "40P01" ? "rollback" : "commit").catch(() => undefined);
        await b.query(got_b === "40P01" ? "rollback" : "commit").catch(() => undefined);
      }
      console.log(`  (control arm: ${deadlocks}/20 iterations produced a real 40P01)`);
      expectEq("at least one of 20 iterations produced a real 40P01 (the harness overlaps the two sessions)", deadlocks >= 1, true);
    });
  } finally {
    await cleanup(s).catch((e) => console.error("cleanup failed:", (e as Error).message));
    await s.end();
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} races passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
