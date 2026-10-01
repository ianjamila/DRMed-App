// Hand-run local CONCURRENCY proof for five lock functions that had none:
//   view_as_transition / view_as_expire (0187) and view_as_end_for (0190) - the admin
//     "View as role" override on staff_profiles + its staff.view_as.* audit rows;
//   restore_patient (0184) - un-deleting a patient under the exclusive lifecycle lock;
//   bridge_payment_delete (0141) - the BEFORE DELETE trigger on payments that reverses
//     the payment's journal entry.
//
// The sequential smokes cannot prove a race (a transaction never waits on itself), so
// this runner uses separate `pg` connections. DETERMINISTIC, NOT LUCKY: a forced
// scenario holds the first caller's transaction open, starts the second, and does not
// move on until pg_locks shows THAT backend waiting on the expected lock (a row lock, or
// the patient's lifecycle advisory lock). If the interleaving is not reached the
// scenario FAILS - it never degrades into a sequential run. Only the free-race rounds
// (V5, R4, R5) rely on timing, and they assert invariants only.
//
// HOW EACH FUNCTION IS CALLED (as the app does)
//   view_as_*      service_role, through the admin client (src/lib/auth/view-as-switch.ts:
//                  the admin's own row is hidden from them by RLS while simulating).
//   restore_patient / delete_patient   service_role (src/lib/actions/patients/lifecycle.ts).
//   visit insert   service_role, the way the reception server action writes a visit.
//   payments       the app has NO hard-delete path (it only voids). The DELETE here is a
//                  service_role `delete from payments`, which is what the repo's scripts and
//                  the lifecycle smoke cleanup do - the trigger fires for any DELETE. The
//                  void is the app's own UPDATE (payments/[id]/void/actions.ts, verbatim).
//
// SCENARIOS
//   V1 start vs start (same admin)       V2 start vs stop        V3 stop vs stop
//   V4 two different admins              no wait, both complete   V5 free races, invariants
//   E1 transition vs expire              E2 expire then transition
//   E3 stop vs expire on a stale view    E4 expire vs expire
//   F1 end-for vs the target's own stop  F2 end-for then the target's stop
//   F3 end-for then the target's start   F4 end-for vs expire (both orders)
//   F5 end-for vs end-for                F6 simulating caller refused (P0076)
//   F7 a caller whose own start is still in flight (end-for does not lock the caller)
//   R1 restore vs restore                R2 restore vs delete_patient, both orders
//   R3 restore vs a visit insert (the shared-lock writer), both orders
//   R4 free race restore x2              R5 free race restore vs delete
//   B1 payment delete then void          B2 void then payment delete
//   B3 delete vs delete    B4 delete vs a direct journal-entry writer (no reversal of a reversed entry)
//
// CONTROL ROUNDS (--control) prove the proof can fail. Each mutant removes ONE guard and
// the named scenarios must FAIL against it:
//   MT view_as_transition without FOR UPDATE   (V1 V2 V3 E2 F2 F3)
//   ME view_as_expire without FOR UPDATE       (E1 E3 E4)
//   MF view_as_end_for target without FOR UPDATE (F1 F4 F5)
//   MR restore_patient without the lifecycle advisory lock (R1 R2 R3)
//   MS bridge_payment_delete without `status = 'posted'`     (B2)
//   ML bridge_payment_delete without the journal-entry FOR UPDATE (B4 must fail; B1-B3 still pass)
//      Writers that reach the entry THROUGH the payment row (delete, void) are already serialised by the payment
//      row lock, taken before the trigger body runs - B1-B3 assert the waiter queued on the payments tuple, and
//      they keep passing without the journal lock. B2 is the discriminating scenario for the posted re-check
//      (MS); B1/B3 check serialisation. The journal-entry lock matters only against a writer that updates the
//      entry directly, which is what B4 does: it holds the entry, the delete waits on journal_entries and re-checks.
// view_as_* and restore_patient mutants are copies in a throwaway schema (vrp_ctl_<hex>),
// never public. A trigger function cannot live in another schema, so MS/ML swap
// public.bridge_payment_delete for the same body whose mutation is conditional on
// payments.notes = '<run tag>': every other session's deletes behave exactly as before.
// The original is restored in finally / SIGINT / SIGTERM and verified byte-for-byte.
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows),
// tagged vrp-<hex>, swept at start, deleted in finally (incl. auth users and the
// journal entries the payments posted) and then counted: a tagged row left is a FAIL.
// Local DB only. No plan modes: every statement locks ONE row by primary key, so there
// is no plan shape to match.
//
// Run (local stack):
//   npm run view-as-restore:concurrency-proof [-- --control]
//   VRP_ROUNDS=50 npm run view-as-restore:concurrency-proof
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

requireLocalOrExplicitProd("view-as-restore:concurrency-proof", {
  writes:
    "throwaway admins (auth.users + staff_profiles), patients, visits and payments tagged vrp-<hex>, committed so two connections can race on them, then deleted; during --control it briefly swaps public.bridge_payment_delete for a variant that deviates only for rows tagged with this run",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[view-as-restore:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const TAG = `vrp-${randomBytes(3).toString("hex")}`;
const ROUNDS = Number(process.env.VRP_ROUNDS ?? 15);
const CONTROL = process.argv.includes("--control");
const BRIDGE_BACKUP = join(tmpdir(), "vrp-bridge-payment-delete-original.sql");
const MUTANT_MARK = "/* vrp-mutant */";

// Which schema each function is called from (public, or a mutant's throwaway schema).
const FN = { transition: "public", expire: "public", endFor: "public", restore: "public" };

let monitor: Client;
const open: Client[] = [];
let seq = 0;
/** Set by the SIGINT/SIGTERM handler: no new scenario, mutant or swap may start once cleanup is under way. */
let aborting = false;

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

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
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
function settle(p: Promise<{ rows: unknown[]; rowCount: number | null }>): Promise<Out> {
  return p.then(
    (r) => ({ ok: true as const, rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }),
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

// ---------------------------------------------------------------------------
// Interleaving control (pg_locks, THIS backend only)
// ---------------------------------------------------------------------------
type Kind = "row" | "lifecycle";
/** What `pid` is queued on right now: a row ("row"), the patient's lifecycle advisory lock, or null. */
async function waitingOn(pid: number, patientId?: string): Promise<Kind | "other" | null> {
  const { rows } = await monitor.query<{ locktype: string; mine: boolean }>(
    `select locktype,
            (locktype = 'advisory' and classid = (hashtext('patient_lifecycle'))::oid
               and ($2::text is null or objid = (hashtext($2::text))::oid)) as mine
       from pg_locks where pid = $1 and not granted`,
    [pid, patientId ?? null],
  );
  if (rows.length === 0) return null;
  if (rows.some((r) => r.mine)) return "lifecycle";
  if (rows.some((r) => r.locktype === "transactionid" || r.locktype === "tuple")) return "row";
  return "other";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The actor's in-flight call must be seen queued on `kind` within ~5s, and must not have answered. */
async function mustWait(a: Actor, kind: Kind, why: string, patientId?: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last: string = "no lock wait";
  while (Date.now() < deadline) {
    if (a.settled) throw new Fail(`interleaving not reached: ${a.name} answered without waiting (${why})`);
    const w = await waitingOn(a.pid, patientId);
    if (w === kind) return;
    if (w) last = `waiting on ${w}`;
    await sleep(25);
  }
  throw new Fail(`interleaving not reached: ${a.name} never waited on the ${kind} lock (${why}); saw ${last}`);
}
/** The opposite: the call must answer while the other side is still open, never queueing. */
async function mustNotWait(a: Actor, p: Promise<Out>, why: string): Promise<Out> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (a.settled) return p;
    if (await waitingOn(a.pid)) throw new Fail(`${a.name} blocked on a lock but should have answered at once (${why})`);
    await sleep(25);
  }
  throw new Fail(`${a.name} neither answered nor queued within 8s (${why})`);
}
/** Which relations' tuple locks `pid` holds (a row-lock waiter holds the tuple lock of the row it queues on). */
async function tupleRelations(pid: number): Promise<string[]> {
  const { rows } = await monitor.query<{ rel: string }>(
    "select distinct relation::regclass::text as rel from pg_locks where pid = $1 and locktype = 'tuple' and relation is not null",
    [pid],
  );
  return rows.map((r) => r.rel);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function mkAdmin(label: string): Promise<string> {
  seq += 1;
  const id = (await monitor.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
  await monitor.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [id, `${TAG}-${seq}@vrp.example.test`],
  );
  await monitor.query(`insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, 'admin', true)`, [
    id,
    `${TAG} ${label}`,
  ]);
  return id;
}
async function mkPatient(): Promise<string> {
  seq += 1;
  const { rows } = await monitor.query<{ id: string }>(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, email)
     values ($1, 'Race', $2, '1990-01-01', $3) returning id`,
    [`DRM-${TAG.toUpperCase()}-${seq}`, `Vrp${seq}`, `${TAG}-p${seq}@vrp.example.test`],
  );
  return rows[0]!.id;
}
async function mkVisit(patientId: string, total = 0): Promise<string> {
  const { rows } = await monitor.query<{ id: string }>(
    `insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'unpaid', $2, 0) returning id`,
    [patientId, total],
  );
  return rows[0]!.id;
}
/** A paid cash payment (posts its journal entry through trg_bridge_payment_insert), notes = run tag. */
async function mkPayment(staff: string): Promise<{ id: string; visit: string }> {
  const p = await mkPatient();
  const visit = await mkVisit(p, 100);
  const { rows } = await monitor.query<{ id: string }>(
    `insert into public.payments (visit_id, amount_php, method, received_by, notes) values ($1, 100, 'cash', $2, $3) returning id`,
    [visit, staff, TAG],
  );
  return { id: rows[0]!.id, visit };
}
async function setView(id: string, role: string | null, untilSql: string | null): Promise<void> {
  await monitor.query(`update public.staff_profiles set view_as_role = $2, view_as_until = ${untilSql ?? "null"} where id = $1`, [id, role]);
}
const ACTIVE = "now() + interval '3 hours'";
const EXPIRED = "now() - interval '1 hour'";

async function viewState(id: string): Promise<{ role: string | null; active: boolean | null }> {
  const { rows } = await monitor.query<{ role: string | null; active: boolean | null }>(
    "select view_as_role as role, (view_as_until > now()) as active from public.staff_profiles where id = $1",
    [id],
  );
  return rows[0]!;
}
/** staff.view_as.* audit rows about admin `id` (own transitions, or ended by another admin), as sorted "action:reason:role". */
async function viewAudit(id: string): Promise<string[]> {
  const { rows } = await monitor.query<{ k: string }>(
    `select replace(replace(action, 'staff.view_as.', '') || ':' || coalesce(metadata->>'reason', '-') || ':' || coalesce(metadata->>'role', '-'), ':-:', ':') as k
       from public.audit_log
      where action like 'staff.view_as.%' and (actor_id = $1 or metadata->>'target_id' = $1::text)`,
    [id],
  );
  return rows.map((r) => r.k).sort();
}
async function patientState(id: string): Promise<{ deleted: boolean; merged: boolean }> {
  const { rows } = await monitor.query<{ deleted: boolean; merged: boolean }>(
    "select deleted_at is not null as deleted, merged_into_id is not null as merged from public.patients where id = $1",
    [id],
  );
  return rows[0]!;
}
async function patientAudit(id: string, action: string): Promise<number> {
  return Number(
    (await monitor.query("select count(*)::int as n from public.audit_log where patient_id = $1 and action = $2", [id, action])).rows[0]!.n,
  );
}

// ---------------------------------------------------------------------------
// Calls, exactly as the app issues them
// ---------------------------------------------------------------------------
const transition = (a: Actor, who: string, role: string | null) =>
  call(a, `select ${FN.transition}.view_as_transition($1::uuid, $2::text, $3::inet, $4::text) as r`, [who, role, "203.0.113.7", "vrp-proof"]);
const expire = (a: Actor, who: string) =>
  call(a, `select ${FN.expire}.view_as_expire($1::uuid, $2::inet, $3::text) as r`, [who, "203.0.113.7", "vrp-proof"]);
const endFor = (a: Actor, who: string, target: string) =>
  call(a, `select ${FN.endFor}.view_as_end_for($1::uuid, $2::uuid, $3::inet, $4::text) as r`, [who, target, "203.0.113.7", "vrp-proof"]);
// lifecycle.ts passes { ip, user_agent }.
const APP_CTX = JSON.stringify({ ip: "203.0.113.7", user_agent: "vrp-proof" });
const restore = (a: Actor, patient: string, admin: string) =>
  call(a, `select ${FN.restore}.restore_patient($1::uuid, $2::uuid, $3::jsonb) as r`, [patient, admin, APP_CTX]);
const del = (a: Actor, patient: string, admin: string) =>
  call(a, `select public.delete_patient($1::uuid, 'test_record', '', $2::uuid, $3::jsonb) as r`, [patient, admin, APP_CTX]);
const insertVisit = (a: Actor, patient: string) =>
  call(a, `insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'unpaid', 0, 0)`, [patient]);
// payments/[id]/void/actions.ts, verbatim WHERE guards.
const voidPayment = (a: Actor, id: string, by: string) =>
  call(
    a,
    `update public.payments set voided_at = now(), voided_by = $2, void_reason = 'Recorded twice: vrp proof'
      where id = $1 and voided_at is null returning id`,
    [id, by],
  );
const deletePayment = (a: Actor, id: string) => call(a, `delete from public.payments where id = $1`, [id]);

const val = (o: Out, key: string): unknown => (o.ok ? o.rows[0]?.[key] : `${o.code}: ${o.msg}`);
const roleOf = (o: Out): unknown => {
  const r = val(o, "r") as { role?: unknown } | string | undefined;
  return typeof r === "object" && r !== null ? r.role : r;
};
function expectOk(o: Out, label: string): void {
  if (!o.ok) throw new Fail(`${label}: refused ${o.code} (${o.msg})`);
}

/** First caller runs (its transaction stays open); second starts and must queue; first ends; second ends. */
async function forced(opts: {
  first: (a: Actor) => Promise<Out>;
  second: (b: Actor) => Promise<Out>;
  kind: Kind;
  why: string;
  patientId?: string;
  /** Relation whose tuple the waiter must hold the queue lock of. */
  rel?: string;
  during?: (a: Actor, b: Actor) => Promise<void>;
}): Promise<{ o1: Out; o2: Out }> {
  const [a, b] = [await actor("first"), await actor("second")];
  await begin(a);
  const r1 = await opts.first(a);
  await begin(b);
  const p2 = andEnd(b, opts.second(b));
  await mustWait(b, opts.kind, opts.why, opts.patientId);
  if (opts.rel) {
    const rels = await tupleRelations(b.pid);
    expect(rels.includes(opts.rel), `waiter queued on ${JSON.stringify(rels)}, not ${opts.rel}`);
  }
  if (opts.during) await opts.during(a, b);
  const o1 = await end(a, r1);
  const o2 = await p2;
  return { o1, o2 };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
type Scenario = () => Promise<void>;
const scenarios: Record<string, Scenario> = {
  // concurrency-proof: view_as_transition (V1-V5 race two transitions of the same admin, and V4 two admins)
  // V1 - start reception vs start medtech: the second waits on the admin row, sees the first's
  //      override, and logs its "switched" end - nothing lost.
  async V1() {
    const adm = await mkAdmin("v1");
    const { o1, o2 } = await forced({
      first: (a) => transition(a, adm, "reception"),
      second: (b) => transition(b, adm, "medtech"),
      kind: "row",
      rel: "staff_profiles",
      why: "the second transition queues on the admin's staff_profiles row",
    });
    expectOk(o1, "first");
    expectOk(o2, "second");
    eq("second answered role", roleOf(o2), "medtech");
    eq("final view", (await viewState(adm)).role, "medtech");
    eq("audit", await viewAudit(adm), ["ended:switched:reception", "started:medtech", "started:reception"]);
  },
  // V2 - start vs stop.
  async V2() {
    const adm = await mkAdmin("v2");
    const { o1, o2 } = await forced({
      first: (a) => transition(a, adm, "reception"),
      second: (b) => transition(b, adm, null),
      kind: "row",
      rel: "staff_profiles",
      why: "the stop queues behind the start",
    });
    expectOk(o1, "first");
    expectOk(o2, "second");
    eq("final view", (await viewState(adm)).role, null);
    eq("audit", await viewAudit(adm), ["ended:manual:reception", "started:reception"]);
  },
  // V3 - stop vs stop on a live override: exactly one "ended".
  async V3() {
    const adm = await mkAdmin("v3");
    await setView(adm, "reception", ACTIVE);
    const { o1, o2 } = await forced({
      first: (a) => transition(a, adm, null),
      second: (b) => transition(b, adm, null),
      kind: "row",
      rel: "staff_profiles",
      why: "the second stop queues behind the first",
    });
    expectOk(o1, "first");
    expectOk(o2, "second");
    eq("final view", (await viewState(adm)).role, null);
    eq("audit", await viewAudit(adm), ["ended:manual:reception"]);
  },
  // V4 - two DIFFERENT admins never wait on each other.
  async V4() {
    const [x, y] = [await mkAdmin("v4x"), await mkAdmin("v4y")];
    const [a, b] = [await actor("first"), await actor("second")];
    await begin(a);
    const r1 = await transition(a, x, "reception");
    expectOk(r1, "first");
    await begin(b);
    const p2 = andEnd(b, transition(b, y, "medtech"));
    const o2 = await mustNotWait(b, p2, "a different admin's row");
    expectOk(o2, "second");
    expectOk(await end(a, r1), "first end");
    eq("x", [(await viewState(x)).role, await viewAudit(x)], ["reception", ["started:reception"]]);
    eq("y", [(await viewState(y)).role, await viewAudit(y)], ["medtech", ["started:medtech"]]);
  },
  // V5 - free race: 3 racers, random start/start/stop, ROUNDS times. Every ended row pairs with a start.
  async V5() {
    const adm = await mkAdmin("v5");
    const pick = ["reception", "medtech", null] as const;
    for (let i = 0; i < ROUNDS; i++) {
      const acts = await Promise.all([actor("r1"), actor("r2"), actor("r3")]);
      const outs = await Promise.all(
        acts.map(async (a, k) => {
          await begin(a);
          return andEnd(a, transition(a, adm, pick[(i + k * 2 + Math.floor(Math.random() * 3)) % 3] ?? null));
        }),
      );
      outs.forEach((o, k) => expectOk(o, `round ${i} racer ${k}`));
      const audit = await viewAudit(adm);
      const started = audit.filter((k) => k.startsWith("started:")).length;
      const ended = audit.filter((k) => k.startsWith("ended:")).length;
      const live = (await viewState(adm)).role !== null;
      eq(`round ${i}: started - ended`, started - ended, live ? 1 : 0);
      await closeAll();
    }
  },

  // concurrency-proof: view_as_expire (E1-E4 race the lazy expiry against a transition and itself)
  // E1 - the admin switches role while the stale view is still stored; the lazy expiry arrives second.
  async E1() {
    const adm = await mkAdmin("e1");
    await setView(adm, "reception", EXPIRED);
    const { o1, o2 } = await forced({
      first: (a) => transition(a, adm, "medtech"),
      second: (b) => expire(b, adm),
      kind: "row",
      rel: "staff_profiles",
      why: "the expiry queues on the row the transition locked",
    });
    expectOk(o1, "transition");
    expectOk(o2, "expire");
    eq("expire is a no-op", val(o2, "r"), false);
    eq("the new override survives", (await viewState(adm)).role, "medtech");
    eq("audit", await viewAudit(adm), ["ended:expired:reception", "started:medtech"]);
  },
  // E2 - expiry first, the admin's switch second: the switch sees a clean row and logs no second "ended".
  async E2() {
    const adm = await mkAdmin("e2");
    await setView(adm, "reception", EXPIRED);
    const { o1, o2 } = await forced({
      first: (a) => expire(a, adm),
      second: (b) => transition(b, adm, "medtech"),
      kind: "row",
      rel: "staff_profiles",
      why: "the transition queues behind the expiry",
    });
    eq("expire did the work", val(o1, "r"), true);
    expectOk(o2, "transition");
    eq("final view", (await viewState(adm)).role, "medtech");
    eq("audit", await viewAudit(adm), ["ended:expired:reception", "started:medtech"]);
  },
  // E3 - the admin stops while the view is stale; the lazy expiry arrives second: one "ended".
  async E3() {
    const adm = await mkAdmin("e3");
    await setView(adm, "reception", EXPIRED);
    const { o1, o2 } = await forced({
      first: (a) => transition(a, adm, null),
      second: (b) => expire(b, adm),
      kind: "row",
      rel: "staff_profiles",
      why: "the expiry queues behind the stop",
    });
    expectOk(o1, "stop");
    eq("expire is a no-op", val(o2, "r"), false);
    eq("final view", (await viewState(adm)).role, null);
    eq("audit", await viewAudit(adm), ["ended:expired:reception"]);
  },
  // E4 - two requests both find the stale view: exactly one "ended".
  async E4() {
    const adm = await mkAdmin("e4");
    await setView(adm, "reception", EXPIRED);
    const { o1, o2 } = await forced({
      first: (a) => expire(a, adm),
      second: (b) => expire(b, adm),
      kind: "row",
      rel: "staff_profiles",
      why: "the second expiry queues behind the first",
    });
    eq("winner", val(o1, "r"), true);
    eq("loser", val(o2, "r"), false);
    eq("audit", await viewAudit(adm), ["ended:expired:reception"]);
  },

  // concurrency-proof: view_as_end_for (F1-F7 race one admin ending another's view against that admin and each other)
  // F1 - admin X clicks "End now" while the target stops its own view: one "ended", end-for finds nothing.
  async F1() {
    const [x, t] = [await mkAdmin("f1x"), await mkAdmin("f1t")];
    await setView(t, "reception", ACTIVE);
    const { o1, o2 } = await forced({
      first: (a) => transition(a, t, null),
      second: (b) => endFor(b, x, t),
      kind: "row",
      rel: "staff_profiles",
      why: "end-for queues on the target's row",
    });
    expectOk(o1, "target stop");
    eq("end-for found nothing to end", val(o2, "r"), false);
    eq("audit", await viewAudit(t), ["ended:manual:reception"]);
  },
  // F2 - end-for first, then the target's own stop: the stop logs nothing more.
  async F2() {
    const [x, t] = [await mkAdmin("f2x"), await mkAdmin("f2t")];
    await setView(t, "reception", ACTIVE);
    const { o1, o2 } = await forced({
      first: (a) => endFor(a, x, t),
      second: (b) => transition(b, t, null),
      kind: "row",
      rel: "staff_profiles",
      why: "the target's stop queues behind end-for",
    });
    eq("ended", val(o1, "r"), true);
    expectOk(o2, "target stop");
    eq("final view", (await viewState(t)).role, null);
    eq("audit", await viewAudit(t), ["ended:ended_by_admin:reception"]);
  },
  // F3 - end-for first, then the target starts a NEW view: it survives and is not double-ended.
  async F3() {
    const [x, t] = [await mkAdmin("f3x"), await mkAdmin("f3t")];
    await setView(t, "reception", ACTIVE);
    const { o1, o2 } = await forced({
      first: (a) => endFor(a, x, t),
      second: (b) => transition(b, t, "medtech"),
      kind: "row",
      rel: "staff_profiles",
      why: "the target's start queues behind end-for",
    });
    eq("ended", val(o1, "r"), true);
    expectOk(o2, "target start");
    eq("final view", (await viewState(t)).role, "medtech");
    eq("audit", await viewAudit(t), ["ended:ended_by_admin:reception", "started:medtech"]);
  },
  // F4 - end-for vs the lazy expiry of a stale view, both orders.
  async F4() {
    const [x, t1, t2] = [await mkAdmin("f4x"), await mkAdmin("f4t1"), await mkAdmin("f4t2")];
    await setView(t1, "reception", EXPIRED);
    const a1 = await forced({
      first: (a) => expire(a, t1),
      second: (b) => endFor(b, x, t1),
      kind: "row",
      rel: "staff_profiles",
      why: "end-for queues behind the expiry",
    });
    eq("expiry did the work", val(a1.o1, "r"), true);
    eq("end-for found nothing", val(a1.o2, "r"), false);
    eq("audit (expiry first)", await viewAudit(t1), ["ended:expired:reception"]);
    await setView(t2, "reception", EXPIRED);
    // end-for locks the target BEFORE deciding there is nothing to end, so a concurrent expiry waits for it.
    const b1 = await forced({
      first: (a) => endFor(a, x, t2),
      second: (b) => expire(b, t2),
      kind: "row",
      rel: "staff_profiles",
      why: "the expiry queues behind end-for's target lock",
    });
    eq("end-for left a stale view alone", val(b1.o1, "r"), false);
    eq("expiry did the work", val(b1.o2, "r"), true);
    eq("audit (end-for first)", await viewAudit(t2), ["ended:expired:reception"]);
  },
  // F5 - two admins click "End now" on the same target: one ends it, the other finds nothing.
  async F5() {
    const [x1, x2, t] = [await mkAdmin("f5x1"), await mkAdmin("f5x2"), await mkAdmin("f5t")];
    await setView(t, "reception", ACTIVE);
    const { o1, o2 } = await forced({
      first: (a) => endFor(a, x1, t),
      second: (b) => endFor(b, x2, t),
      kind: "row",
      rel: "staff_profiles",
      why: "the second end-for queues behind the first",
    });
    eq("winner", val(o1, "r"), true);
    eq("loser", val(o2, "r"), false);
    eq("audit", await viewAudit(t), ["ended:ended_by_admin:reception"]);
  },
  // F6 - a caller who is themselves viewing as another role is refused (P0076); nothing changes.
  async F6() {
    const [x, t] = [await mkAdmin("f6x"), await mkAdmin("f6t")];
    await setView(x, "medtech", ACTIVE);
    await setView(t, "reception", ACTIVE);
    const a = await actor("caller");
    await begin(a);
    const p = call(a, `select ${FN.endFor}.view_as_end_for($1::uuid, $2::uuid, null, null) as r`, [x, t]);
    const o = await mustNotWait(a, p, "the caller check reads the actor row without a lock");
    await end(a, o);
    expect(!o.ok && o.code === "P0076", `expected P0076, got ${JSON.stringify(o)}`);
    eq("target untouched", (await viewState(t)).role, "reception");
    eq("no audit", await viewAudit(t), []);
  },
  // F7 - the caller's OWN start is still in flight (uncommitted): end-for does not lock the actor row, so it
  //      neither waits nor is refused - it serialises as "ended before the caller started viewing".
  async F7() {
    const [x, t] = [await mkAdmin("f7x"), await mkAdmin("f7t")];
    await setView(t, "reception", ACTIVE);
    const [a, b] = [await actor("caller-start"), await actor("end-for")];
    await begin(a);
    const r1 = await transition(a, x, "reception");
    expectOk(r1, "caller start");
    await begin(b);
    const p2 = andEnd(b, endFor(b, x, t));
    const o2 = await mustNotWait(b, p2, "end-for does not lock the calling admin's row");
    eq("ended", val(o2, "r"), true);
    expectOk(await end(a, r1), "caller start end");
    eq("caller now viewing", (await viewState(x)).role, "reception");
    eq("target cleared", (await viewState(t)).role, null);
    eq("audit", await viewAudit(t), ["ended:ended_by_admin:reception"]);
  },

  // concurrency-proof: restore_patient (R1-R5 race restore against restore, delete_patient and a shared-lock writer)
  // R1 - two restores of one deleted patient: the second waits on the LIFECYCLE advisory lock, then is refused P0061.
  async R1() {
    const adm = await mkAdmin("r1");
    const p = await mkPatient();
    expectOk(await settleOne(del, p, adm), "setup delete");
    const { o1, o2 } = await forced({
      first: (a) => restore(a, p, adm),
      second: (b) => restore(b, p, adm),
      kind: "lifecycle",
      why: "the second restore queues on the exclusive lifecycle lock",
      patientId: p,
    });
    expectOk(o1, "first restore");
    expect(!o2.ok && o2.code === "P0061", `second restore: expected P0061, got ${JSON.stringify(o2)}`);
    eq("patient active", (await patientState(p)).deleted, false);
    eq("restored audit rows", await patientAudit(p, "patient.restored"), 1);
  },
  // R2 - restore vs delete_patient, both orders, no 40P01.
  async R2() {
    const adm = await mkAdmin("r2");
    const p1 = await mkPatient();
    expectOk(await settleOne(del, p1, adm), "setup delete");
    const a = await forced({
      first: (x) => restore(x, p1, adm),
      second: (y) => del(y, p1, adm),
      kind: "lifecycle",
      why: "delete queues behind the restore's exclusive lifecycle lock",
      patientId: p1,
    });
    expectOk(a.o1, "restore");
    expectOk(a.o2, "delete after restore");
    eq("restore-then-delete: deleted", (await patientState(p1)).deleted, true);
    eq("restore-then-delete: audits", [await patientAudit(p1, "patient.deleted"), await patientAudit(p1, "patient.restored")], [2, 1]);
    const p2 = await mkPatient();
    const b = await forced({
      first: (x) => del(x, p2, adm),
      second: (y) => restore(y, p2, adm),
      kind: "lifecycle",
      why: "restore queues behind the delete's exclusive lifecycle lock",
      patientId: p2,
    });
    expectOk(b.o1, "delete");
    expectOk(b.o2, "restore after delete");
    eq("delete-then-restore: active", (await patientState(p2)).deleted, false);
    eq("delete-then-restore: audits", [await patientAudit(p2, "patient.deleted"), await patientAudit(p2, "patient.restored")], [1, 1]);
  },
  // R3 - restore vs a shared-lock writer (a visit insert), both orders.
  async R3() {
    const adm = await mkAdmin("r3");
    const p1 = await mkPatient();
    expectOk(await settleOne(del, p1, adm), "setup delete");
    // Restore first: the writer queues on the lifecycle lock, then finds the patient ACTIVE (not P0058).
    const a = await forced({
      first: (x) => restore(x, p1, adm),
      second: (y) => insertVisit(y, p1),
      kind: "lifecycle",
      why: "the visit insert's SHARED lifecycle lock conflicts with the restore's exclusive one",
      patientId: p1,
    });
    expectOk(a.o1, "restore");
    expectOk(a.o2, "visit insert after restore");
    eq("visit exists", Number((await monitor.query("select count(*)::int as n from public.visits where patient_id = $1", [p1])).rows[0]!.n), 1);
    // Writer first: the restore queues behind the in-flight write, then finds the patient not deleted.
    const p2 = await mkPatient();
    const b = await forced({
      first: (x) => insertVisit(x, p2),
      second: (y) => restore(y, p2, adm),
      kind: "lifecycle",
      why: "the restore's exclusive lifecycle lock waits for the in-flight write's shared one",
      patientId: p2,
    });
    expectOk(b.o1, "visit insert");
    expect(!b.o2.ok && b.o2.code === "P0061", `restore behind a writer: expected P0061, got ${JSON.stringify(b.o2)}`);
    eq("no restored audit", await patientAudit(p2, "patient.restored"), 0);
  },
  // R4 - free race: two restores x ROUNDS, exactly one wins, the other P0061.
  async R4() {
    const adm = await mkAdmin("r4");
    for (let i = 0; i < ROUNDS; i++) {
      const p = await mkPatient();
      expectOk(await settleOne(del, p, adm), "setup delete");
      const acts = await Promise.all([actor("r1"), actor("r2")]);
      const outs = await Promise.all(
        acts.map(async (a) => {
          await begin(a);
          return andEnd(a, restore(a, p, adm));
        }),
      );
      const wins = outs.filter((o) => o.ok).length;
      const refused = outs.filter((o) => !o.ok && o.code === "P0061").length;
      expect(wins === 1 && refused === 1, `round ${i}: ${JSON.stringify(outs.map((o) => (o.ok ? "ok" : o.code)))}`);
      eq(`round ${i}: restored audit rows`, await patientAudit(p, "patient.restored"), 1);
      await closeAll();
    }
  },
  // R5 - free race: restore vs delete_patient x ROUNDS. Either order is legal; the state must match the outcomes.
  async R5() {
    const adm = await mkAdmin("r5");
    for (let i = 0; i < ROUNDS; i++) {
      const p = await mkPatient();
      expectOk(await settleOne(del, p, adm), "setup delete");
      const [ar, ad] = await Promise.all([actor("restore"), actor("delete")]);
      const [or, od] = await Promise.all([
        (async () => (await begin(ar), andEnd(ar, restore(ar, p, adm))))(),
        (async () => (await begin(ad), andEnd(ad, del(ad, p, adm))))(),
      ]);
      expectOk(or, `round ${i} restore`);
      // restore first -> delete then succeeds (deleted); delete first -> refused P0058 (already deleted), patient ends active.
      if (od.ok) eq(`round ${i}: restore then delete`, (await patientState(p)).deleted, true);
      else {
        expect(od.code === "P0058", `round ${i}: delete refused with ${od.code}, want P0058`);
        eq(`round ${i}: delete refused`, (await patientState(p)).deleted, false);
      }
      await closeAll();
    }
  },

  // concurrency-proof: bridge_payment_delete (B1-B3 race the BEFORE DELETE trigger against a void and a second delete)
  // B1 - delete first: the void queues on the PAYMENT row, then matches nothing; one reversal.
  async B1() {
    const adm = await mkAdmin("b1");
    const pay = await mkPayment(adm);
    const { o1, o2 } = await forced({
      first: (a) => deletePayment(a, pay.id),
      second: (b) => voidPayment(b, pay.id, adm),
      kind: "row",
      why: "the void queues on the payment row the delete holds",
      during: async (_a, b) => assertQueuedOnPayment(b),
    });
    expectOk(o1, "delete");
    expectOk(o2, "void");
    eq("void matched nothing (row deleted)", o2.ok ? o2.rowCount : -1, 0);
    await assertOneReversal(pay.id, "delete then void");
  },
  // B2 - void first: the delete queues on the payment row, finds the JE already reversed, adds NO second reversal.
  async B2() {
    const adm = await mkAdmin("b2");
    const pay = await mkPayment(adm);
    const { o1, o2 } = await forced({
      first: (a) => voidPayment(a, pay.id, adm),
      second: (b) => deletePayment(b, pay.id),
      kind: "row",
      why: "the delete queues on the payment row the void holds",
      during: async (_a, b) => assertQueuedOnPayment(b),
    });
    expectOk(o1, "void");
    expectOk(o2, "delete");
    eq("delete removed the voided row", o2.ok ? o2.rowCount : -1, 1);
    await assertOneReversal(pay.id, "void then delete");
  },
  // B4 - a direct journal-entry writer (what reverseJournalEntryBySource-style code does) holds the payment's JE
  //      while the payment is deleted: the trigger's FOR UPDATE makes it wait for the writer's commit and re-check
  //      status = 'posted', so it adds NO reversal. Without that lock it reads the stale 'posted' row and reverses an
  //      already-reversed entry.
  async B4() {
    const adm = await mkAdmin("b4");
    const pay = await mkPayment(adm);
    const [a, b] = [await actor("je-writer"), await actor("deleter")];
    await a.c.query("begin"); // plain postgres: a direct ledger writer, not the payment path
    const r1 = await call(a, `update public.journal_entries set status = 'reversed' where source_kind = 'payment' and source_id = $1 and status = 'posted'`, [pay.id]);
    expectOk(r1, "je writer");
    eq("je writer touched one entry", r1.ok ? r1.rowCount : -1, 1);
    await begin(b);
    const p2 = andEnd(b, deletePayment(b, pay.id));
    await mustWait(b, "row", "the trigger queues on the journal entry the writer holds");
    const rels = await tupleRelations(b.pid); // asserted after the outcome, so a mutant dies on the duplicate reversal
    expectOk(await end(a, r1), "je writer end");
    const o2 = await p2;
    expectOk(o2, "delete");
    const rev = await monitor.query("select count(*)::int as n from public.journal_entries where source_kind = 'reversal' and reverses in (select id from public.journal_entries where source_kind = 'payment' and source_id = $1)", [pay.id]);
    eq("no second reversal of an entry the writer already reversed", rev.rows[0]!.n, 0);
    expect(rels.includes("journal_entries"), `deleter queued on ${JSON.stringify(rels)}, not journal_entries`);
  },
  // B3 - two deletes: the second matches nothing; one reversal.
  async B3() {
    const adm = await mkAdmin("b3");
    const pay = await mkPayment(adm);
    const { o1, o2 } = await forced({
      first: (a) => deletePayment(a, pay.id),
      second: (b) => deletePayment(b, pay.id),
      kind: "row",
      why: "the second delete queues on the payment row",
      during: async (_a, b) => assertQueuedOnPayment(b),
    });
    expectOk(o1, "first delete");
    expectOk(o2, "second delete");
    eq("second deleted nothing", o2.ok ? o2.rowCount : -1, 0);
    await assertOneReversal(pay.id, "delete then delete");
  },
};

/** One-shot call in its own transaction (setup helper). */
async function settleOne(fn: (a: Actor, p: string, adm: string) => Promise<Out>, p: string, adm: string): Promise<Out> {
  const a = await actor("setup");
  await begin(a);
  return end(a, await fn(a, p, adm));
}

/** The waiter queued on the payment tuple and never on a journal entry - why the JE FOR UPDATE is redundant. */
async function assertQueuedOnPayment(b: Actor): Promise<void> {
  const rels = await tupleRelations(b.pid);
  expect(rels.includes("payments"), `waiter holds no tuple lock on payments (saw ${JSON.stringify(rels)})`);
  expect(!rels.includes("journal_entries"), `waiter queued on journal_entries, not the payment row (${JSON.stringify(rels)})`);
}

async function assertOneReversal(paymentId: string, label: string): Promise<void> {
  const orig = await monitor.query<{ id: string; status: string; reversed_by: string | null }>(
    "select id, status, reversed_by from public.journal_entries where source_kind = 'payment' and source_id = $1",
    [paymentId],
  );
  eq(`${label}: payment journal entries`, orig.rowCount, 1);
  const rev = await monitor.query<{ id: string; status: string }>(
    "select id, status from public.journal_entries where source_kind = 'reversal' and reverses = $1",
    [orig.rows[0]!.id],
  );
  eq(`${label}: reversal entries of the payment's JE`, rev.rowCount, 1);
  eq(`${label}: reversal posted`, rev.rows[0]!.status, "posted");
  eq(`${label}: original reversed`, orig.rows[0]!.status, "reversed");
  eq(`${label}: original points at the reversal`, orig.rows[0]!.reversed_by, rev.rows[0]!.id);
}

async function runAll(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    if (aborting) break;
    try {
      await fn();
      result[name] = null;
      console.log(`  ok   ${name}`);
    } catch (e) {
      result[name] = e instanceof Error ? e.message : String(e);
      console.log(`  FAIL ${name}: ${result[name]}`);
    }
    await closeAll();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mutants
// ---------------------------------------------------------------------------
type Mutant = {
  id: string;
  note: string;
  fn: string; // regprocedure
  slot?: keyof typeof FN; // which FN schema it replaces (schema copies)
  from: string;
  to: string;
  mustFail: string[];
  /** Scenarios that must still PASS against the mutant (they check the shared behaviour, not the dropped guard). */
  mustPass?: string[];
  trigger?: boolean;
};
const NO_LOCK = (block: string) => ({ from: block, to: block.replace("\n   for update;", ";") });
const MUTANTS: Mutant[] = [
  {
    id: "MT",
    note: "view_as_transition without FOR UPDATE",
    fn: "public.view_as_transition(uuid,text,inet,text)",
    slot: "transition",
    ...NO_LOCK("   and deleted_at is null\n   for update;"),
    mustFail: ["V1", "V2", "V3", "E2", "F2", "F3"],
  },
  {
    id: "ME",
    note: "view_as_expire without FOR UPDATE",
    fn: "public.view_as_expire(uuid,inet,text)",
    slot: "expire",
    ...NO_LOCK("     and view_as_until <= now()\n   for update;"),
    mustFail: ["E1", "E3", "E4"],
  },
  {
    id: "MF",
    note: "view_as_end_for without the target FOR UPDATE",
    fn: "public.view_as_end_for(uuid,uuid,inet,text)",
    slot: "endFor",
    ...NO_LOCK("   where id = p_target\n   for update;"),
    mustFail: ["F1", "F4", "F5"],
  },
  {
    id: "MR",
    note: "restore_patient without the exclusive lifecycle advisory lock",
    fn: "public.restore_patient(uuid,uuid,jsonb)",
    slot: "restore",
    from: "perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));",
    to: "null;",
    mustFail: ["R1", "R2", "R3"],
  },
  {
    id: "MS",
    note: "bridge_payment_delete reverses an already-reversed entry (status = 'posted' filter dropped, for this run's payments)",
    fn: "public.bridge_payment_delete()",
    trigger: true,
    from: "and status = 'posted'",
    to: `and (status = 'posted' or OLD.notes = '${TAG}')`,
    mustFail: ["B2"],
  },
  {
    id: "ML",
    note: "bridge_payment_delete without the journal-entry FOR UPDATE (for this run's payments)",
    fn: "public.bridge_payment_delete()",
    trigger: true,
    from: "", // built specially below
    to: "",
    mustFail: ["B4"],
    mustPass: ["B1", "B2", "B3"],
  },
];

async function liveDef(sig: string): Promise<string> {
  return (await monitor.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [sig])).rows[0]!.d;
}

async function makeSchemaMutant(schema: string, m: Mutant): Promise<void> {
  const def = await liveDef(m.fn);
  if (!def.includes(m.from)) throw new Error(`${m.id}: the live function no longer contains «${m.from}» - update MUTANTS`);
  const name = m.fn.slice(m.fn.indexOf(".") + 1, m.fn.indexOf("("));
  const args = m.fn.slice(m.fn.indexOf("("));
  const body = def.replace(`public.${name}`, `${schema}.${name}`).replace(m.from, m.to);
  await monitor.query(`create schema ${schema}`);
  await monitor.query(body);
  if (name === "restore_patient") {
    // The real function is OWNED by the private NOLOGIN role that alone may write the lifecycle columns (0167);
    // the copy must run as it too. CREATE must be held momentarily on the schema for the transfer (PG17).
    await monitor.query(`grant create on schema ${schema} to patient_lifecycle_writer`);
    await monitor.query(`alter function ${schema}.${name}${args} owner to patient_lifecycle_writer`);
    await monitor.query(`revoke create on schema ${schema} from patient_lifecycle_writer`);
  }
  await monitor.query(`grant usage on schema ${schema} to service_role`);
  await monitor.query(`grant execute on function ${schema}.${name}${args} to service_role`);
}

/** Swap public.bridge_payment_delete for a variant that deviates only for payments.notes = TAG. */
async function swapBridge(m: Mutant): Promise<void> {
  if (aborting) throw new Error("aborting: not swapping bridge_payment_delete");
  const def = await liveDef(m.fn);
  if (def.includes(MUTANT_MARK)) throw new Error("public.bridge_payment_delete is already a mutant (a crashed run?) - restore it first");
  writeFileSync(BRIDGE_BACKUP, def);
  let mutated: string;
  if (m.id === "ML") {
    const sel = `    from public.journal_entries
    where source_kind = 'payment'
      and source_id = OLD.id
      and status = 'posted'
    for update;`;
    if (!def.includes(sel)) throw new Error("ML: the live bridge_payment_delete select changed - update the mutant");
    const nolock = sel.replace("\n    for update;", ";");
    mutated = def.replace(
      `select id, entry_number into v_original_je, v_orig_number\n${sel}`,
      `if OLD.notes = '${TAG}' then\n  select id, entry_number into v_original_je, v_orig_number\n${nolock}\n  else\n  select id, entry_number into v_original_je, v_orig_number\n${sel}\n  end if;`,
    );
    if (mutated === def) throw new Error("ML: replacement did not apply");
  } else {
    if (!def.includes(m.from)) throw new Error(`${m.id}: the live function no longer contains «${m.from}»`);
    mutated = def.replace(m.from, m.to);
  }
  mutated = mutated.replace("AS $function$", `AS $function$ ${MUTANT_MARK}`);
  if (!mutated.includes(MUTANT_MARK)) throw new Error("could not mark the mutant");
  await monitor.query(mutated);
}
/** The statement from the latest migration that defines bridge_payment_delete (0141). */
function bridgeFromMigration(): string {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/0141_manila_posting_dates_remainder.sql"), "utf8");
  const start = sql.indexOf("create or replace function public.bridge_payment_delete()");
  if (start < 0) throw new Error("0141 no longer defines bridge_payment_delete");
  const bodyStart = sql.indexOf("$function$", start);
  const end = sql.indexOf("$function$", bodyStart + 10);
  if (bodyStart < 0 || end < 0) throw new Error("could not extract bridge_payment_delete from 0141");
  return sql.slice(start, end + "$function$".length);
}
async function restoreBridge(): Promise<void> {
  const live = await liveDef("public.bridge_payment_delete()").catch(() => "");
  if (!live.includes(MUTANT_MARK)) {
    if (existsSync(BRIDGE_BACKUP)) unlinkSync(BRIDGE_BACKUP);
    return;
  }
  if (!existsSync(BRIDGE_BACKUP)) {
    // Backup gone (cleaned tmp dir): fall back to the live definition in migration 0141.
    await monitor.query(bridgeFromMigration());
    if ((await liveDef("public.bridge_payment_delete()")).includes(MUTANT_MARK)) throw new Error("fallback restore of bridge_payment_delete failed");
    console.error("bridge_payment_delete restored from migration 0141 (backup file was missing)");
    return;
  }
  const original = readFileSync(BRIDGE_BACKUP, "utf8");
  await monitor.query(original);
  const now = await liveDef("public.bridge_payment_delete()");
  if (now !== original) throw new Error("bridge_payment_delete was not restored byte-for-byte");
  unlinkSync(BRIDGE_BACKUP);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function purge(): Promise<void> {
  const q = async (sql: string, params: unknown[] = []) => {
    try {
      return await monitor.query(sql, params);
    } catch (e) {
      console.error(`  cleanup step failed: ${(e as Error).message.split("\n")[0]}`);
      return null;
    }
  };
  const staff = ((await q("select id from public.staff_profiles where full_name like 'vrp-%'"))?.rows ?? []).map((r) => r.id as string);
  const pats = ((await q("select id from public.patients where drm_id like 'DRM-VRP-%'"))?.rows ?? []).map((r) => r.id as string);
  if (pats.length && staff.length) {
    await q("begin");
    await q("set local role service_role");
    await q(
      `select public.restore_patient(p.id, $2, '{}'::jsonb) from public.patients p where p.id = any($1::uuid[]) and p.deleted_at is not null`,
      [pats, staff[0]],
    );
    await q("commit");
  }
  // Payments + the journal entries they posted (incl. reversals). Triggers are skipped (local only, this transaction
  // only): je_lines_balance_check would otherwise reject entries emptied line by line, and a plain payment DELETE
  // would post yet another reversal.
  await q("begin");
  await q("set local session_replication_role = replica");
  await q(
    `with pay as (select id from public.payments where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))),
          orig as (select id from public.journal_entries
                    where created_by = any($2::uuid[]) or (source_kind = 'payment' and source_id in (select id from pay))),
          allje as (select id from orig union select id from public.journal_entries where reverses in (select id from orig)),
          dl as (delete from public.journal_lines where entry_id in (select id from allje))
     delete from public.journal_entries where id in (select id from allje)`,
    [pats, staff],
  );
  await q(`delete from public.payments where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`, [pats]);
  await q("commit");
  await q(`delete from public.visits where patient_id = any($1::uuid[])`, [pats]);
  await q(
    `delete from public.audit_log where patient_id = any($1::uuid[]) or actor_id = any($2::uuid[]) or resource_id = any($2::uuid[]) or metadata->>'target_id' = any($3::text[])`,
    [pats, staff, staff],
  );
  await q(`delete from public.patients where id = any($1::uuid[])`, [pats]);
  await q(`delete from public.staff_profiles where id = any($1::uuid[])`, [staff]);
  await q(`delete from auth.users where email like '%@vrp.example.test'`);
  const schemas = (await q("select nspname from pg_namespace where nspname like 'vrp_ctl_%'"))?.rows ?? [];
  for (const s of schemas) await q(`drop schema ${s.nspname} cascade`);
}
async function leftovers(): Promise<number> {
  const r = await monitor.query(
    `select (select count(*) from public.staff_profiles where full_name like 'vrp-%')
          + (select count(*) from public.patients where drm_id like 'DRM-VRP-%')
          + (select count(*) from auth.users where email like '%@vrp.example.test')
          + (select count(*) from pg_namespace where nspname like 'vrp_ctl_%') as n`,
  );
  return Number(r.rows[0]!.n);
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  monitor = await newClient();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('view-as-restore:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("another view-as-restore concurrency proof is running - exiting");
    process.exit(2);
  }
  let exit = 0;
  let cleanupP: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupP ??= (async () => {
      await closeAll();
      await restoreBridge().catch((e) => {
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
    // A crashed earlier run may have left a mutant trigger function or tagged rows.
    await restoreBridge();
    await purge();
    console.log(`Server: ${(await monitor.query<{ v: string }>("select version() as v")).rows[0]!.v}`);
    console.log(`Real functions (public), ${ROUNDS} free-race rounds:`);
    const real = await runAll();
    const failed = Object.entries(real).filter(([, e]) => e !== null);
    console.log(`${Object.keys(real).length - failed.length}/${Object.keys(real).length} scenarios passed.`);
    if (failed.length > 0) exit = 1;

    if (CONTROL) {
      for (const m of MUTANTS) {
        if (aborting) break;
        console.log(`Control ${m.id}: ${m.note}`);
        let schema: string | null = null;
        try {
          if (m.trigger) await swapBridge(m);
          else {
            schema = `vrp_ctl_${randomBytes(3).toString("hex")}`;
            await makeSchemaMutant(schema, m);
            FN[m.slot!] = schema;
          }
          const only = new Set([...m.mustFail, ...(m.mustPass ?? [])]);
          const saved = { ...scenarios };
          for (const k of Object.keys(scenarios)) if (!only.has(k)) delete scenarios[k];
          const res = await runAll();
          Object.assign(scenarios, saved);
          if (aborting) break;
          const survived = m.mustFail.filter((x) => res[x] === null);
          const broke = (m.mustPass ?? []).filter((x) => res[x] !== null);
          if (survived.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: scenarios ${survived.join(", ")} still passed against the mutant - the proof cannot catch this bug`);
            exit = 1;
          } else if (broke.length > 0) {
            console.log(`  CONTROL FAIL ${m.id}: ${broke.join(", ")} should pass against this mutant but failed`);
            exit = 1;
          } else console.log(`  control ${m.id} ok: ${m.mustFail.join(", ")} failed against the mutant${m.mustPass ? `; ${m.mustPass.join(", ")} still pass (they check the payment-row serialisation, which the dropped lock does not provide)` : ""}`);
        } finally {
          FN.transition = FN.expire = FN.endFor = FN.restore = "public";
          if (m.trigger) await restoreBridge();
          if (schema) await monitor.query(`drop schema ${schema} cascade`).catch(() => undefined);
          await purge();
        }
      }
    }
  } finally {
    await cleanup();
    await monitor.query("select pg_advisory_unlock(hashtext('view-as-restore:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
