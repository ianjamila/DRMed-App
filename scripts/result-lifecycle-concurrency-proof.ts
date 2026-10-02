// Hand-run local CONCURRENCY proof for the four result-lifecycle lock functions of 0184
// that had none (they sat in the concurrency-proof guard's frozen BASELINE), plus - since 0223 - the status-flip trigger
// advance_test_on_result_upload:
//   lifecycle_lock_results   the result-MEMBERSHIP advisory lock (exclusive to change which tests a
//                            result holds, shared for every other results-family write)
//   result_create_linked     the results row + every result_test_requests link in one transaction
//   result_finalise_commit   a structured result's values + PDF pointer + finalised_at, once
//   result_save_draft        a structured draft's values (upsert), refused once finalised
//
// The sequential smokes cannot prove a race (a transaction never waits on itself), so this runner uses
// separate `pg` connections. DETERMINISTIC, NOT LUCKY: a forced scenario holds the first caller's
// transaction open, starts the second, and does not move on until pg_locks shows THAT backend queued on
// the expected lock (the membership advisory lock by its two int keys, the patient lifecycle lock, or a
// row of an expected relation). If the interleaving is not reached the scenario FAILS - it never degrades
// into a sequential run. Only the free-race rounds (K6, C2f, D6) rely on timing, and they assert
// invariants only.
//
// GLOBAL LOCK ORDER (0184, 0198, 0211, 0216, 0223): result MEMBERSHIP -> patient lifecycle (shared; delete /
// restore / merge exclusive) -> visit row -> test_requests lines ORDER BY id -> write.
//   0223 brought the two functions that skipped it into line: result_finalise_commit = membership (shared) -> patient (shared)
//   -> results row FOR UPDATE -> linked VISIT rows FOR SHARE (id order) -> linked lines FOR NO KEY UPDATE (id order) -> the live /
//   in-progress checks -> write (the results UPDATE fires advance_test_on_result_upload, which walks the junction in id order and
//   flips a line only WHERE status = 'in_progress'); result_create_linked = membership (exclusive, the new id) -> patient (shared)
//   -> the lines' VISIT rows FOR SHARE -> lines FOR UPDATE (id order) -> live recount -> insert.
//
// HOW EACH FUNCTION IS CALLED (as the app does): service_role, through the admin client -
//   result_create_linked / result_finalise_commit / result_save_draft   src/lib/actions/results/*,
//     queue/[id]/actions.ts (admin.rpc)
//   delete_test_request_lines (0216), merge_patients_guarded (0196), delete_patient     service_role
//   release_visit_results / unclaim_panel_members                   authenticated, one JWT `sub` per connection
//   lifecycle_lock_results is EXECUTE-revoked from every runtime role (the guard triggers call it as their
//   owner), so the K scenarios call it as the connecting owner role, exactly the way a trigger does.
//
// SCENARIOS (ids are what RLC_ONLY and the --control table name)
//   K1  exclusive vs exclusive (same id): the 2nd queues on the advisory key (hashtext('result_membership'),
//       hashtext(id)), read from pg_locks - proves the key derivation too
//   K2  exclusive vs shared, both orders          K3  shared vs shared: both granted, nobody waits
//   K4  different ids never block; duplicates / NULLs ignored; the membership keyspace is not the patient one
//   K5  ascending acquisition: two callers with opposite array orders both queue on the LOWEST key, no 40P01
//   K6  free race: opposite-order arrays x ROUNDS, invariants only
//   C1  create vs create, same test              C2  overlapping sets, both directions; C2f free race
//   C3  create vs delete_test_request_lines, both orders
//   C4  create vs a visit soft delete, both orders (0223: the create takes the visit FOR SHARE; was a KNOWN defect)
//   C5  create vs merge_patients_guarded of the test's patient, both orders
//   C6  create vs delete_patient, both orders
//   C7  create vs a visit re-assignment to another patient (P0072)
//   C8  the patient lock is taken BEFORE the lines (the create holds no line while queued behind an exclusive waiter)
//   C9  lines locked in id order vs an id-ordered writer (unclaim) while a holder pins the lowest line (no 40P01)
//   C10 create vs claim_panel_members, both orders      C11 create vs release_visit_results, both orders (40001 re-plan)
//   F1  finalise vs finalise (same result)       F2  finalise vs save_draft, both orders
//   F3  finalise vs result_edit_commit           F5  finalise vs a link insert (exclusive membership), both orders
//   F6a finalise vs unclaim_panel_members: the unclaim commits first, the finalise is refused (P0066), nothing finalised (0223; was KNOWN)
//   F6b finalise-first vs unclaim              F6c release-first vs finalise
//   F6e finalise vs release, junction in id order (no cycle)
//   F6d finalise vs release, junction AND lines stored in reverse id order: no 40P01 (0223; was KNOWN, heap-order dependent - now
//       built deterministically on both tables, ctid-verified with a bounded retry, sequential scan forced)
//   F6g the status-flip trigger alone (a results UPDATE) vs unclaim: a line handed back while its flip waited is not flipped
//   F7  finalise vs merge_patients_guarded, both orders       F8  finalise-first vs delete of a member (P0067)
//   F8b delete-first vs finalise: the finalise queues on the visit, then is refused (P0066), no report over a deleted test (0223; was KNOWN)
//   F11 finalise vs a visit soft delete, both orders (the twin of C4)
//   F9  finalise vs a visit re-assignment (P0072)            F10 finalise vs delete_patient (P0059)
//   D1  save_draft vs save_draft (no lost parameter)        D3  opposite-order upserts vs row holders (no 40P01)
//   D4  save_draft vs a link insert (membership), both orders     D5  save_draft vs a visit re-assignment (P0072)
//   D6  free race: finalise vs save_draft x ROUNDS (the committed values are always the finalise's)
//
// KNOWN scenarios: none since 0223 (C4, F6a, F6d, F8b were reproduced defects, now asserted). The machinery stays: a scenario
// registered with known=true is reported, not counted, and the run exits 1 if it stops reproducing (promote it to an asserted
// scenario) or breaks.
//
// REDUNDANT guards (no scenario can fail without them, by construction - not mutated):
//   - result_create_linked's EXCLUSIVE membership lock on the NEW result id: nobody can know the id before the insert
//     commits, and the link-insert trigger takes the same lock again anyway.
//   - for the SAME parameter, the draft upsert's unique index alone would serialise two drafts and the committed values
//     would come out right; the results-row FOR UPDATE is what the opposite-order D3 and the finalised check (F2) truly
//     need, and D1 asserts WHICH row the second draft queued on, so it still catches its removal.
//   - advance_test_on_result_upload's ORDER BY test_request_id: since 0223 result_finalise_commit holds every line before the trigger
//     runs, so the trigger's own order cannot matter on that path (F6d is caught by the finalise's lock order, mutant MF8). Its
//     status guard is the one hunk with a scenario of its own (F6g, mutant MT1: the trigger alone, no finalise in front of it).
//   - result_create_linked's explicit patient lock is order hygiene only: the link-insert trigger would take (and assert)
//     the same shared lock later, so correctness holds without it; the lock manager even rescues the one cycle that
//     would result (C8 explains). C8 pins the ORDER directly.
//
// CONTROL ROUNDS (--control) prove the proof can fail. Each mutant is a COPY of one live function in a throwaway
// schema (rlc_ctl_<hex>, never public) with ONE guard removed; the named scenarios must FAIL against it, for a guard
// reason (a lock that was not taken, a refusal that did not come, a 40P01) - never an infrastructure error:
//   B0  unmutated copies of all four functions: every control scenario passes (the copy itself is sound)
//   ML1 lifecycle_lock_results ignores p_exclusive (K1 K2)    ML2 keyed under the patient class (K1 K4)
//   ML3 takes the keys in the caller's array order (K5, a real 40P01)
//   MC1 create without the lines FOR UPDATE (C1 C2)           MC2 create without the explicit patient lock (C8)
//   MC3 create without the live-line recount (C3)             MC4 create without the post-lock patient re-check (C7)
//   MC5 create without the 'already has a result' check (C1)  MC6 create with lines locked in plan order (C9, 40P01)
//   MF1 finalise without the results-row FOR UPDATE (F1)      MF2 finalise without the finalised_at re-check (F1)
//   MF3 finalise without the membership lock (F5)             MF4 finalise without the post-lock patient re-check (F9)
//   MD1 save_draft without the results-row FOR UPDATE (F2 D3) MD2 save_draft without the finalised refusal (F2)
//   MD3 save_draft without the membership lock (D4)           MD4 save_draft without the post-lock patient re-check (D5)
//   MC7 create without the visit FOR SHARE (C4)
//   MF5 finalise without the visit AND line locks (F6a, F8b)  MF6 finalise without the visit lock (F8b, F11)
//   MF7 finalise without the line locks (F6a)                 MF8 finalise locks lines in plan order, no ORDER BY (F6d, 40P01)
//   MT1 advance_test_on_result_upload without its status guard (F6g) - this mutant is swapped in AS the results trigger for its
//       round (the one object a round touches outside its own schema; healed before the schema drop, at start, at the end and on
//       SIGINT/SIGTERM - a run that finds it repaired reports it, and a clean run that had to repair it FAILS)
//   RLC_CTL=B0,MC1 runs only those rounds; RLC_ONLY=none skips the real-function scenarios.
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows), tagged rlc-<hex>,
// swept at start, deleted in finally + SIGINT/SIGTERM, then counted: a tagged row left is a FAIL. Local DB
// only. The stack is shared: only rows minted here are ever read or written.
//
// Run (local stack):
//   npm run result-lifecycle:concurrency-proof [-- --control]
//   RLC_ONLY=K1,C1 RLC_ROUNDS=40 npm run result-lifecycle:concurrency-proof
//   RLC_ONLY=none RLC_CTL=B0,MC1 npm run result-lifecycle:concurrency-proof -- --control
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";

requireLocalOrExplicitProd("result-lifecycle:concurrency-proof", {
  writes:
    "throwaway staff, services + a result template, patients, visits, test lines, results and merge/delete audit rows tagged rlc-<hex>, committed so two connections can race on them, then deleted; --control also creates and drops schemas rlc_ctl_<hex> holding copies of five functions (and, for mutant MT1 only, temporarily re-points the results trigger trg_results_advance_test at its copy)",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[result-lifecycle:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const TAG = `rlc-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();
const ROUNDS = Number(process.env.RLC_ROUNDS ?? 15);
const ONLY = process.env.RLC_ONLY ? process.env.RLC_ONLY.split(",") : null;
const CTL_ONLY = process.env.RLC_CTL ? process.env.RLC_CTL.split(",") : null;
const CONTROL = process.argv.includes("--control");
const APP_NAME = `result-lifecycle:${TAG}`;

// Which schema each function under test is called from (public, or a mutant's throwaway schema).
// `advance` is the results UPDATE trigger function: never called by name, it is copied only so a mutant can be swapped in as the trigger.
const FN = { lockResults: "public", create: "public", finalise: "public", draft: "public", advance: "public" };

let monitor: Client;
let aborting = false;
let seq = 0;
/** bumped per control round, so a result's `notes` marker is unique to one run of a scenario (the real run and every mutant round reuse the scenario ids) */
const round = { n: 0 };
const noteOf = (n: string) => `${n}#${round.n}`;

// Fixture ids (staff, services, parameters) - seeded once.
const uuid = (): string => randomUUID();
const fx = {
  med: uuid(), // medtech: actor of result_create_linked, uploader, release/unclaim caller
  med2: uuid(),
  admin: uuid(), // merge / delete actor
  services: [uuid(), uuid()],
  template: uuid(),
  params: Array.from({ length: 6 }, () => uuid()),
};

// ---------------------------------------------------------------------------
// Outcomes, assertions
// ---------------------------------------------------------------------------
/** A GUARD failure: the behaviour under test is wrong (a lock missing, a refusal that did not come). */
class Fail extends Error {}
/** An INFRASTRUCTURE failure: fixture, timeout, a statement the proof itself got wrong. Never a catch. */
class Infra extends Error {}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Fail(msg);
}
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Fail(`${label}: got ${g}, want ${w}`);
}
type Out = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string; msg: string };
const fmt = (o: Out) => (o.ok ? "ok" : `${o.code} ${o.msg.split("\n")[0]}`);
function expectOk(o: Out, label: string): void {
  if (!o.ok) throw new Fail(`${label}: refused ${o.code} (${o.msg.split("\n")[0]})`);
}
function expectRefused(o: Out, code: string, msg: RegExp | null, label: string): void {
  if (o.ok) throw new Fail(`${label}: expected ${code}, but it succeeded`);
  if (o.code === "40P01") throw new Fail(`${label}: 40P01 deadlock (${o.msg.split("\n")[0]})`);
  if (o.code !== code) throw new Fail(`${label}: expected ${code}, got ${fmt(o)}`);
  if (msg && !msg.test(o.msg)) throw new Fail(`${label}: ${code} message was «${o.msg.split("\n")[0]}», expected ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Connections and actors
// ---------------------------------------------------------------------------
type Actor = { c: Client; pid: number; name: string; settled: boolean };
const open: Client[] = [];

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL, application_name: APP_NAME });
  c.on("error", () => undefined); // a backend terminated by the abort cleanup must not crash the process
  await c.connect();
  await c.query("set statement_timeout = '25s'");
  open.push(c);
  return c;
}
async function actor(name: string): Promise<Actor> {
  const c = await newClient();
  const pid = (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  return { c, pid, name, settled: false };
}
/** begin as service_role (the admin client), as an authenticated staff member (JWT sub), or raw (the table owner). */
async function begin(a: Actor, as: "service" | "raw" | { uid: string } = "service"): Promise<void> {
  await a.c.query("begin");
  if (as === "raw") return;
  if (as === "service") {
    await a.c.query("set local role service_role");
    return;
  }
  await a.c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: as.uid, role: "authenticated" })]);
  await a.c.query("set local role authenticated");
}
function settle(p: Promise<{ rows: unknown[]; rowCount: number | null }>): Promise<Out> {
  return p.then(
    (r) => ({ ok: true as const, rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code ?? "?", msg: e.message ?? String(e) }),
  );
}
/** One statement, tracking whether it has answered (for mustWait). */
function call(a: Actor, sql: string, params: unknown[] = []): Promise<Out> {
  a.settled = false;
  return settle(a.c.query(sql, params)).then((o) => {
    a.settled = true;
    return o;
  });
}
/** End the transaction: commit on success, roll back on refusal (the way PostgREST ends each RPC). */
async function end(a: Actor, o: Out): Promise<Out> {
  try {
    await a.c.query(o.ok ? "commit" : "rollback");
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "end-failed", msg: err.message ?? String(e) };
  }
  return o;
}
const andEnd = (a: Actor, p: Promise<Out>): Promise<Out> => p.then((o) => end(a, o));
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
type WaitSpec =
  | { kind: "membership"; ids?: string[] }
  | { kind: "lifecycle"; ids?: string[] }
  | { kind: "row"; rel?: string };
interface Wait {
  locktype: string;
  classid: number | null;
  objid: number | null;
  mode: string;
}
let KEY: { membership: number; lifecycle: number } = { membership: 0, lifecycle: 0 };
const keyOf = async (uuid: string): Promise<number> =>
  Number((await monitor.query<{ k: string }>("select (hashtext($1::text))::oid::bigint as k", [uuid])).rows[0]!.k);

async function waitsOf(pid: number): Promise<Wait[]> {
  const { rows } = await monitor.query<{ locktype: string; classid: string | null; objid: string | null; mode: string }>(
    "select locktype, classid::bigint as classid, objid::bigint as objid, mode from pg_locks where pid = $1 and not granted",
    [pid],
  );
  return rows.map((r) => ({ locktype: r.locktype, classid: r.classid === null ? null : Number(r.classid), objid: r.objid === null ? null : Number(r.objid), mode: r.mode }));
}
/** Relations whose tuple lock `pid` holds or queues on (a row-lock waiter holds the tuple lock of the row it queues on). */
async function tupleRels(pid: number): Promise<string[]> {
  const { rows } = await monitor.query<{ rel: string }>(
    "select distinct relation::regclass::text as rel from pg_locks where pid = $1 and locktype = 'tuple' and relation is not null",
    [pid],
  );
  return rows.map((r) => r.rel);
}
async function matches(pid: number, w: Wait[], spec: WaitSpec): Promise<boolean> {
  if (spec.kind === "row") {
    if (!w.some((x) => x.locktype === "transactionid" || x.locktype === "tuple")) return false;
    return !spec.rel || (await tupleRels(pid)).includes(spec.rel);
  }
  const cls = spec.kind === "membership" ? KEY.membership : KEY.lifecycle;
  const adv = w.filter((x) => x.locktype === "advisory" && x.classid === cls);
  if (adv.length === 0) return false;
  if (!spec.ids) return true;
  const keys = await Promise.all(spec.ids.map(keyOf));
  return adv.some((x) => x.objid !== null && keys.includes(x.objid));
}
function describeWaits(w: Wait[]): string {
  if (w.length === 0) return "no lock wait";
  return w
    .map((x) => (x.locktype === "advisory" ? `advisory ${x.classid === KEY.membership ? "membership" : x.classid === KEY.lifecycle ? "lifecycle" : `class ${x.classid}`} key ${x.objid}` : x.locktype))
    .join(", ");
}
const specName = (s: WaitSpec) => (s.kind === "row" ? `a row of ${s.rel ?? "any relation"}` : `the ${s.kind} advisory lock`);

/** The actor's in-flight call must be seen queued on `spec` within ~5s, and must not have answered. */
async function mustWait(a: Actor, spec: WaitSpec, why: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = "no lock wait";
  while (Date.now() < deadline) {
    if (a.settled) throw new Fail(`interleaving not reached: ${a.name} answered without waiting on ${specName(spec)} (${why})`);
    const w = await waitsOf(a.pid);
    if (await matches(a.pid, w, spec)) return;
    last = describeWaits(w);
    await sleep(25);
  }
  throw new Fail(`interleaving not reached: ${a.name} never waited on ${specName(spec)} (${why}); saw ${last}`);
}
/** The opposite: the call must answer while the other side is still open, never queueing. */
async function mustNotWait(a: Actor, p: Promise<Out>, why: string): Promise<Out> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (a.settled) return p;
    const w = await waitsOf(a.pid);
    if (w.length > 0) throw new Fail(`${a.name} blocked on ${describeWaits(w)} but should have answered at once (${why})`);
    await sleep(25);
  }
  throw new Fail(`${a.name} neither answered nor queued within 8s (${why})`);
}
/** Run `forced` side effects with a wait described by `spec`. */
async function forced(opts: {
  first: (a: Actor) => Promise<Out>;
  second: (b: Actor) => Promise<Out>;
  wait: WaitSpec;
  why: string;
  firstAs?: "service" | "raw" | { uid: string };
  secondAs?: "service" | "raw" | { uid: string };
  during?: (a: Actor, b: Actor) => Promise<void>;
}): Promise<{ o1: Out; o2: Out; a: Actor; b: Actor }> {
  const [a, b] = [await actor("first"), await actor("second")];
  await begin(a, opts.firstAs);
  const r1 = await opts.first(a);
  await begin(b, opts.secondAs);
  const p2 = andEnd(b, opts.second(b));
  try {
    await mustWait(b, opts.wait, opts.why);
  } catch (e) {
    if (e instanceof Fail) throw new Fail(`${e.message} [first answered: ${fmt(r1)}${b.settled ? `; second answered: ${fmt(await p2)}` : ""}]`);
    throw e;
  }
  if (opts.during) await opts.during(a, b);
  const o1 = await end(a, r1);
  const o2 = await p2;
  return { o1, o2, a, b };
}

// ---------------------------------------------------------------------------
// Fixtures (committed, as the table owner)
// ---------------------------------------------------------------------------
async function seed(): Promise<void> {
  await monitor.query("begin");
  try {
    for (const [id, role, k] of [[fx.med, "medtech", "m1"], [fx.med2, "medtech", "m2"], [fx.admin, "admin", "a1"]] as const) {
      await monitor.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
        [id, `${TAG}-${k}@example.test`],
      );
      await monitor.query("insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, $3, true)", [id, `${TAG} ${k.toUpperCase()}`, role]);
    }
    for (const [i, id] of fx.services.entries()) {
      await monitor.query(
        `insert into public.services (id, code, name, price_php, kind, section) values ($1, $2, $3, 100, 'lab_test', 'chemistry')`,
        [id, `${TAG_UP}-${i}`, `${TAG} test ${i}`],
      );
    }
    await monitor.query(`insert into public.result_templates (id, service_id, layout, header_notes) values ($1, $2, 'simple', $3)`, [fx.template, fx.services[0], TAG]);
    for (const [i, id] of fx.params.entries()) {
      await monitor.query(
        `insert into public.result_template_params (id, template_id, sort_order, parameter_name, input_type) values ($1, $2, $3, $4, 'numeric')`,
        [id, fx.template, i + 1, `${TAG} p${i}`],
      );
    }
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

async function mkPatient(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await monitor.query(
    `insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex) values ($1, $2, 'Rlc', $3, '1990-01-01', 'female')`,
    [id, `DRM-${TAG_UP}-${seq}`, `Fixture${seq}`],
  );
  return id;
}
async function mkVisit(patient: string, total = 100): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await monitor.query(
    `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
     values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', $4, 0)`,
    [id, `V-${TAG_UP}-${seq}`, patient, total],
  );
  return id;
}
interface LineOpts {
  status?: "in_progress" | "requested" | "cancelled";
  /** price per line (0 = a fixture a deletable patient may carry) */
  price?: number;
  /** store the rows in DESCENDING id order on the heap (so heap order is the reverse of lock-by-id order) */
  desc?: boolean;
}
const ctidParts = (c: string): [number, number] => {
  const m = /^\((\d+),(\d+)\)$/.exec(c);
  if (!m) throw new Infra(`bad ctid ${c}`);
  return [Number(m[1]), Number(m[2])];
};
async function ctidOf(table: string, col: string, id: string): Promise<[number, number]> {
  const { rows } = await monitor.query<{ c: string }>(`select ctid::text as c from public.${table} where ${col} = $1`, [id]);
  if (rows.length !== 1) throw new Infra(`ctidOf: ${table}.${col} ${id} not found`);
  return ctidParts(rows[0]!.c);
}
const before = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** n lines on `visit`, ids ascending. status in_progress (assigned to the medtech) unless asked. */
async function mkLines(visit: string, n: number, o: LineOpts = {}): Promise<string[]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ids = Array.from({ length: n }, () => randomUUID()).sort();
    const order = ids.map((_, i) => i);
    if (o.desc) order.reverse();
    const price = o.price ?? 100;
    await monitor.query("begin");
    try {
      for (const i of order) {
        await monitor.query(
          `insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
           values ($1, $2, $3, $4, 'requested', $5, $5)`,
          [ids[i], visit, fx.services[0], fx.med, price],
        );
      }
      if (o.status === "cancelled") await monitor.query("update public.test_requests set status = 'cancelled' where id = any($1::uuid[])", [ids]);
      if ((o.status ?? "in_progress") === "in_progress") {
        await monitor.query(
          "update public.test_requests set status = 'in_progress', assigned_to = $2, started_at = now() where id = any($1::uuid[])",
          [ids, fx.med],
        );
      }
      await monitor.query("commit");
    } catch (e) {
      await monitor.query("rollback").catch(() => undefined);
      throw e;
    }
    if (!o.desc || n < 2) return ids;
    // heap placement follows free space: confirm the reversal took, else rebuild (the orphan rows are swept at the end)
    if (before(await ctidOf("test_requests", "id", ids[n - 1]!), await ctidOf("test_requests", "id", ids[n - 2]!))) return ids;
  }
  throw new Infra("fixture: could not store the lines in reverse heap order after 8 tries");
}
interface World {
  patient: string;
  visit: string;
  lines: string[];
}
async function mkWorld(n: number, o: LineOpts = {}): Promise<World> {
  const patient = await mkPatient();
  const visit = await mkVisit(patient, (o.price ?? 100) * n);
  return { patient, visit, lines: await mkLines(visit, n, o) };
}

// ---------------------------------------------------------------------------
// Calls, exactly as the app issues them
// ---------------------------------------------------------------------------
const create = (a: Actor, ids: string[], o: { kind?: "structured" | "uploaded"; notes?: string } = {}) =>
  call(a, `select ${FN.create}.result_create_linked($1::uuid, $2::uuid[], $3, null, $4, $5::int, $6) as id`, [
    fx.med,
    ids,
    o.kind ?? "structured",
    o.kind === "uploaded" ? `rlc/${TAG}/up-${randomUUID()}.pdf` : null,
    o.kind === "uploaded" ? 1000 : null,
    noteOf(o.notes ?? TAG),
  ]);
/** value rows for parameters `idx`, each numeric `base + idx` */
const vals = (idx: number[], base: number) =>
  idx.map((i) => ({
    parameter_id: fx.params[i],
    numeric_value_si: base + i,
    numeric_value_conv: base + i,
    text_value: null,
    select_value: null,
    flag: null,
    is_blank: false,
  }));
const saveDraft = (a: Actor, result: string, v: ReturnType<typeof vals>) =>
  call(a, `select ${FN.draft}.result_save_draft($1::uuid, $2::jsonb)`, [result, JSON.stringify(v)]);
const finalise = (a: Actor, result: string, v: ReturnType<typeof vals>, tag: string, at = new Date()) =>
  call(a, `select ${FN.finalise}.result_finalise_commit($1::uuid, $2::uuid, $3::jsonb, $4, $5::int, $6::timestamptz, null, '[]'::jsonb) as r`, [
    result,
    fx.med,
    JSON.stringify(v),
    `rlc/${TAG}/${tag}.pdf`,
    1234,
    at.toISOString(),
  ]);
const lockR = (a: Actor, ids: (string | null)[], exclusive: boolean) =>
  call(a, `select ${FN.lockResults}.lifecycle_lock_results($1::uuid[], $2::boolean)`, [ids, exclusive]);
const delLines = (a: Actor, visit: string, ids: string[]) =>
  call(a, `select public.delete_test_request_lines($1::uuid, $2::uuid[], $3::uuid, $4, $5::timestamptz) as r`, [visit, ids, fx.admin, `${TAG} concurrency proof`, new Date().toISOString()]);
const mergeP = (a: Actor, keep: string, source: string) =>
  call(a, "select public.merge_patients_guarded($1::uuid, $2::uuid, $3::uuid, $4::jsonb) as r", [keep, source, fx.admin, JSON.stringify({ source: "admin" })]);
const delPatient = (a: Actor, p: string) =>
  call(a, `select public.delete_patient($1::uuid, 'test_record', '', $2::uuid, '{}'::jsonb) as r`, [p, fx.admin]);
const unclaim = (a: Actor, ids: string[], holders: string[]) =>
  call(a, "select public.unclaim_panel_members($1::uuid[], $2::uuid[]) as n", [ids, holders]);
const release = (a: Actor, visit: string, ids: string[]) =>
  call(a, "select public.release_visit_results($1::uuid, $2::uuid[], 'email') as r", [visit, ids]);

// ---------------------------------------------------------------------------
// Committed-state readers (monitor connection)
// ---------------------------------------------------------------------------
const num = (v: unknown) => Number(v);
const linkCount = async (ids: string[]) =>
  num((await monitor.query("select count(*)::int as n from public.result_test_requests where test_request_id = any($1::uuid[])", [ids])).rows[0]!.n);
const resultsNoted = async (notes: string) =>
  num((await monitor.query("select count(*)::int as n from public.results where notes = $1", [noteOf(notes)])).rows[0]!.n);
const linkedResults = async (ids: string[]) =>
  (await monitor.query<{ result_id: string }>("select distinct result_id from public.result_test_requests where test_request_id = any($1::uuid[]) order by 1", [ids])).rows.map((r) => r.result_id);
async function patientsOfResult(result: string): Promise<string[]> {
  const { rows } = await monitor.query<{ p: string }>(
    `select distinct v.patient_id as p from public.result_test_requests rtr
       join public.test_requests tr on tr.id = rtr.test_request_id join public.visits v on v.id = tr.visit_id
      where rtr.result_id = $1 order by 1`,
    [result],
  );
  return rows.map((r) => r.p);
}
async function lineStatus(ids: string[]): Promise<Record<string, string>> {
  const { rows } = await monitor.query<{ id: string; status: string; deleted_at: string | null }>(
    "select id, status || case when deleted_at is not null then '+deleted' else '' end as status from public.test_requests where id = any($1::uuid[])",
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}
interface ResState {
  finalised: boolean;
  finalised_at: string | null;
  storage_path: string | null;
  values: Record<string, number>;
}
async function resState(result: string): Promise<ResState> {
  const r = (await monitor.query<{ finalised_at: string | null; storage_path: string | null }>(
    "select to_char(finalised_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') as finalised_at, storage_path from public.results where id = $1",
    [result],
  )).rows[0];
  if (!r) throw new Infra(`result ${result} not found`);
  const v = (await monitor.query<{ parameter_id: string; n: string }>("select parameter_id, numeric_value_si as n from public.result_values where result_id = $1", [result])).rows;
  const values: Record<string, number> = {};
  for (const x of v.sort((p, q) => fx.params.indexOf(p.parameter_id) - fx.params.indexOf(q.parameter_id))) values[`p${fx.params.indexOf(x.parameter_id)}`] = Number(x.n);
  return { finalised: r.finalised_at !== null, finalised_at: r.finalised_at, storage_path: r.storage_path, values };
}
/** the committed value map a `vals(idx, base)` call writes */
const valMap = (idx: number[], base: number) => Object.fromEntries(idx.map((i) => [`p${i}`, base + i]));

/** One-shot call in its own transaction (setup), as service_role, through the monitor connection's twin. */
async function setupCall(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw new Infra(`setup call failed: ${(e as Error).message}`);
  } finally {
    open.splice(open.indexOf(c), 1);
    await c.end().catch(() => undefined);
  }
}
/** A structured draft result over `lines`, optionally with saved draft values, created through the real RPCs. */
async function mkDraft(lines: string[], draftIdx: number[] | null = null, base = 1): Promise<string> {
  const rows = await setupCall("select public.result_create_linked($1::uuid, $2::uuid[], 'structured', null, null, null, $3) as id", [fx.med, lines, TAG]);
  const id = rows[0]!.id as string;
  if (draftIdx) await setupCall("select public.result_save_draft($1::uuid, $2::jsonb)", [id, JSON.stringify(vals(draftIdx, base))]);
  return id;
}
/** A draft result whose junction rows sit on the heap in DESCENDING test id order (direct inserts as the owner). */
async function mkDescDraft(lines: string[]): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomUUID();
    await monitor.query("insert into public.results (id, generation_kind, uploaded_by, notes) values ($1, 'structured', $2, $3)", [id, fx.med, TAG]);
    for (const t of [...lines].reverse()) {
      await monitor.query("insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)", [id, t]);
    }
    if (lines.length < 2) return id;
    const [lo, hi] = [lines[0]!, lines[1]!];
    if (before(await ctidOf("result_test_requests", "test_request_id", hi), await ctidOf("result_test_requests", "test_request_id", lo))) return id;
    await monitor.query("delete from public.result_test_requests where result_id = $1", [id]);
    await monitor.query("delete from public.results where id = $1", [id]);
  }
  throw new Infra("fixture: could not store the junction rows in reverse heap order after 8 tries");
}

/** Move a visit to another patient the way the guard trigger lets it (exclusive locks on both): a direct owner UPDATE. */
const reassignVisit = (a: Actor, visit: string, to: string) => call(a, "update public.visits set patient_id = $2 where id = $1", [visit, to]);
/** Add a link of another in_progress line of the SAME visit to a result (the membership change). */
const addLink = (a: Actor, result: string, line: string) => call(a, "insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)", [result, line]);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
type Scenario = { id: string; title: string; known?: boolean; run: () => Promise<string | void> };
const scenarios: Scenario[] = [];
const S = (id: string, title: string, run: () => Promise<string | void>, known = false) => scenarios.push({ id, title, run, known });

// A held membership lock: a raw transaction taking the advisory key directly (what a trigger-side writer holds).
async function holdKey(a: Actor, key: number, exclusive: boolean): Promise<void> {
  await a.c.query(`select pg_advisory_xact_lock${exclusive ? "" : "_shared"}(hashtext('result_membership'), $1::int)`, [key | 0]);
}
const hashOf = async (u: string): Promise<number> => Number((await monitor.query<{ k: number }>("select hashtext($1::text) as k", [u])).rows[0]!.k);
async function heldLocks(pid: number, id: string): Promise<{ mode: string; granted: boolean }[]> {
  const { rows } = await monitor.query<{ mode: string; granted: boolean }>(
    `select mode, granted from pg_locks
      where pid = $1 and locktype = 'advisory' and classid = (hashtext('result_membership'))::oid
        and objid = (hashtext($2::text))::oid and objsubid = 2`,
    [pid, id],
  );
  return rows;
}

// concurrency-proof: lifecycle_lock_results
// K1 - exclusive vs exclusive on one result: the second queues on the advisory key
//      (hashtext('result_membership'), hashtext(id)) - read from pg_locks, so the key derivation is proven too.
S("K1", "lifecycle_lock_results: exclusive vs exclusive on one result queues on (hashtext('result_membership'), hashtext(id))", async () => {
  const r = randomUUID();
  const { o1, o2, a, b } = await forced({
    first: (x) => lockR(x, [r], true),
    second: (y) => lockR(y, [r], true),
    wait: { kind: "membership", ids: [r] },
    why: "the second exclusive request queues behind the first on the same key",
    firstAs: "raw",
    secondAs: "raw",
    during: async (x, y) => {
      const held = await heldLocks(x.pid, r);
      eq("the first holds exactly one lock on the derived key, exclusive", held.map((h) => `${h.mode}/${h.granted}`), ["ExclusiveLock/true"]);
      const queued = await heldLocks(y.pid, r);
      eq("the second is queued on the same derived key, exclusive", queued.map((h) => `${h.mode}/${h.granted}`), ["ExclusiveLock/false"]);
    },
  });
  void a;
  void b;
  expectOk(o1, "first");
  expectOk(o2, "second");
});

// K2 - exclusive vs shared, both orders (every results-family writer holds it SHARED; an add/remove of a link EXCLUSIVE).
S("K2", "lifecycle_lock_results: exclusive blocks shared and shared blocks exclusive", async () => {
  const r = randomUUID();
  const x = await forced({
    first: (a) => lockR(a, [r], true),
    second: (b) => lockR(b, [r], false),
    wait: { kind: "membership", ids: [r] },
    why: "a shared request queues behind an exclusive holder",
    firstAs: "raw",
    secondAs: "raw",
    during: async (a, b) => eq("the shared request is queued as ShareLock", (await heldLocks(b.pid, r)).map((h) => `${h.mode}/${h.granted}`), ["ShareLock/false"]),
  });
  expectOk(x.o1, "exclusive");
  expectOk(x.o2, "shared after exclusive");
  const y = await forced({
    first: (a) => lockR(a, [r], false),
    second: (b) => lockR(b, [r], true),
    wait: { kind: "membership", ids: [r] },
    why: "an exclusive request queues behind a shared holder",
    firstAs: "raw",
    secondAs: "raw",
  });
  expectOk(y.o1, "shared");
  expectOk(y.o2, "exclusive after shared");
});

// K3 - shared vs shared: nobody waits, both hold the key.
S("K3", "lifecycle_lock_results: shared vs shared never blocks", async () => {
  const r = randomUUID();
  const [a, b] = [await actor("first"), await actor("second")];
  await begin(a, "raw");
  const r1 = await lockR(a, [r], false);
  expectOk(r1, "first shared");
  await begin(b, "raw");
  const p2 = andEnd(b, lockR(b, [r], false));
  const o2 = await mustNotWait(b, p2, "two shared holders of the same key coexist");
  expectOk(o2, "second shared");
  const held = await monitor.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = (hashtext('result_membership'))::oid and objid = (hashtext($1::text))::oid and granted and mode = 'ShareLock'", [r]);
  eq("the first still holds its ShareLock while the second finished", num(held.rows[0]!.n), 1);
  expectOk(await end(a, r1), "first end");
});

// K4 - different ids never block; duplicates and NULLs are ignored; the membership class is not the patient class.
S("K4", "lifecycle_lock_results: different ids never block; NULLs / duplicates ignored; separate from the patient lock keyspace", async () => {
  const [x, y] = [randomUUID(), randomUUID()];
  const [a, b] = [await actor("first"), await actor("second")];
  await begin(a, "raw");
  const r1 = await lockR(a, [x, x, null], true);
  expectOk(r1, "first (duplicate + NULL elements)");
  const n = await monitor.query("select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and granted", [a.pid]);
  eq("duplicates collapse and NULL is ignored: exactly one advisory lock held", num(n.rows[0]!.n), 1);
  await begin(b, "raw");
  const p2 = andEnd(b, lockR(b, [y], true));
  expectOk(await mustNotWait(b, p2, "a different result id is a different key"), "second, different id");
  // The same uuid as a PATIENT id takes the patient lifecycle lock: a different class, so it does not collide.
  const c = await actor("third");
  await begin(c, "raw");
  const p3 = andEnd(c, call(c, "select public.lifecycle_lock(array[$1::uuid], true)", [x]));
  expectOk(await mustNotWait(c, p3, "the patient lifecycle keyspace is not the result-membership one"), "patient lock on the same uuid");
  expectOk(await end(a, r1), "first end");
});

// K5 - ascending acquisition. Two callers hand the SAME two ids in opposite array orders while holders pin both
//      keys; the lock function must take the lower key first, so both queue on it and no cycle can form.
S("K5", "lifecycle_lock_results: opposite array orders both queue on the LOWEST key (no 40P01)", async () => {
  let u1 = randomUUID();
  let u2 = randomUUID();
  while ((await hashOf(u1)) === (await hashOf(u2))) u2 = randomUUID();
  if ((await hashOf(u1)) > (await hashOf(u2))) [u1, u2] = [u2, u1]; // u1 has the lower key (int4 order, as the function sorts)
  const [h1, h2, a, b] = [await actor("holder-low"), await actor("holder-high"), await actor("caller-A"), await actor("caller-B")];
  await begin(h1, "raw");
  await holdKey(h1, await hashOf(u1), true);
  await begin(h2, "raw");
  await holdKey(h2, await hashOf(u2), true);
  await begin(a, "raw");
  const pa = andEnd(a, lockR(a, [u1, u2], true)); // array order low, high
  await mustWait(a, { kind: "membership", ids: [u1] }, "A needs the lower key, held by the first holder");
  await begin(b, "raw");
  const pb = andEnd(b, lockR(b, [u2, u1], true)); // array order high, low
  // Ascending acquisition: B must ALSO queue on the lower key before touching the higher one.
  let bWaitsLow = true;
  let note = "";
  try {
    await mustWait(b, { kind: "membership", ids: [u1] }, "B (array order high, low) must still take the LOWER key first");
  } catch (e) {
    bWaitsLow = false;
    note = (e as Error).message;
  }
  expectOk(await end(h1, { ok: true, rows: [], rowCount: 0 }), "holder-low end"); // A takes the low key, then queues on the high one
  if (bWaitsLow) await mustWait(a, { kind: "membership", ids: [u2] }, "A now holds the low key and needs the high one");
  expectOk(await end(h2, { ok: true, rows: [], rowCount: 0 }), "holder-high end");
  const [oa, ob] = await Promise.all([pa, pb]);
  const dead = [oa, ob].filter((o) => !o.ok && o.code === "40P01").length;
  expect(dead === 0, `lock-order cycle (caller B took the higher key first: ${!bWaitsLow}): ${fmt(oa)} / ${fmt(ob)}`);
  expect(bWaitsLow, `unsorted acquisition: caller B took the higher key first (${note})`);
  expectOk(oa, "A");
  expectOk(ob, "B");
});

// K6 - free race: opposite-order arrays of three ids, ROUNDS times, both exclusive. Invariants only.
S("K6", `lifecycle_lock_results: free race of opposite-order arrays x ${ROUNDS} rounds`, async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const [a, b] = await Promise.all([actor("r1"), actor("r2")]);
    const outs = await Promise.all(
      [a, b].map(async (x, k) => {
        await begin(x, "raw");
        return andEnd(x, lockR(x, k === 0 ? ids : [...ids].reverse(), true));
      }),
    );
    for (const o of outs) if (!o.ok) throw new Fail(`round ${i}: ${fmt(o)}`);
    await closeAll();
  }
});

// ---------------------------------------------------------------------------
// (more scenarios are appended below)
function refusedAny(o: Out, codes: string[], label: string): void {
  if (o.ok) throw new Fail(`${label}: expected one of ${codes.join("/")}, but it succeeded`);
  if (o.code === "40P01") throw new Fail(`${label}: 40P01 deadlock (${o.msg.split("\n")[0]})`);
  if (!codes.includes(o.code)) throw new Fail(`${label}: expected one of ${codes.join("/")}, got ${fmt(o)}`);
}
/** Both promises must answer within 18s of the holder letting go; 40P01 on either side is the finding. */
async function bothAnswer(names: [string, string], pa: Promise<Out>, pb: Promise<Out>): Promise<[Out, Out]> {
  const timeout = sleep(18000).then(() => "timeout" as const);
  const both = await Promise.race([Promise.all([pa, pb]), timeout]);
  if (both === "timeout") throw new Fail(`neither ${names[0]} nor ${names[1]} finished within 18s of the holder letting go`);
  return both as [Out, Out];
}
const victims = (names: string[], outs: Out[]) => names.filter((_, i) => !outs[i]!.ok && (outs[i] as { code: string }).code === "40P01");

// concurrency-proof: result_create_linked
// C1 - two creates for the SAME test: the second queues on the test row the first locked FOR UPDATE, then is refused
//      "already has a result" (P0066). Exactly one result, one link; the loser's results row never lands.
S("C1", "result_create_linked: create vs create on one test - one result, the loser P0066", async () => {
  const w = await mkWorld(1);
  const note = `${TAG}:C1`;
  const { o1, o2 } = await forced({
    first: (a) => create(a, w.lines, { notes: note }),
    second: (b) => create(b, w.lines, { notes: note }),
    wait: { kind: "row", rel: "test_requests" },
    why: "the second create queues on the test row (FOR UPDATE, ordered by id)",
  });
  expectOk(o1, "first create");
  expectRefused(o2, "P0066", /already has a result/, "second create");
  eq("links of the test", await linkCount(w.lines), 1);
  eq("results rows minted by the two calls", await resultsNoted(note), 1);
});

// C2 - overlapping sets, both directions. A=[t1,t2] vs B=[t2,t3] and A=[t2,t3] vs B=[t1,t2]: the loser is refused P0066
//      AFTER the winner commits and links NOTHING (its free test stays unlinked - all or nothing).
S("C2", "result_create_linked: overlapping test sets - the loser links nothing", async () => {
  for (const dir of ["low-first", "high-first"] as const) {
    const w = await mkWorld(3);
    const [t1, t2, t3] = w.lines as [string, string, string];
    const winner = dir === "low-first" ? [t1, t2] : [t2, t3];
    const loser = dir === "low-first" ? [t2, t3] : [t1, t2];
    const free = dir === "low-first" ? t3 : t1;
    const note = `${TAG}:C2:${dir}`;
    const { o1, o2 } = await forced({
      first: (a) => create(a, winner, { notes: note }),
      second: (b) => create(b, loser, { notes: note }),
      wait: { kind: "row", rel: "test_requests" },
      why: "the loser queues on the shared test row",
    });
    expectOk(o1, `${dir}: winner`);
    expectRefused(o2, "P0066", /already has a result/, `${dir}: loser`);
    eq(`${dir}: the loser's free test stays unlinked`, await linkCount([free]), 0);
    eq(`${dir}: links`, await linkCount(w.lines), 2);
    eq(`${dir}: results rows`, await resultsNoted(note), 1);
  }
});

// C2f - free race: two creates over random overlapping subsets of 4 fresh tests, argument orders shuffled, ROUNDS times.
//       No 40P01; every test is linked at most once; a winner holds exactly the set it asked for; a loser holds nothing.
S("C2f", `result_create_linked: free race of overlapping creates x ${ROUNDS} rounds`, async () => {
  const pick = (ids: string[]) => {
    const s = ids.filter(() => Math.random() < 0.6);
    const set = s.length === 0 ? [ids[Math.floor(Math.random() * ids.length)]!] : s;
    return set.sort(() => Math.random() - 0.5);
  };
  for (let i = 0; i < ROUNDS; i++) {
    const w = await mkWorld(4);
    const sets = [pick(w.lines), pick(w.lines)];
    const note = `${TAG}:C2f:${i}`;
    const acts = await Promise.all([actor("c1"), actor("c2")]);
    const outs = await Promise.all(
      acts.map(async (a, k) => {
        await begin(a);
        return andEnd(a, create(a, sets[k]!, { notes: note }));
      }),
    );
    const dead = victims(["c1", "c2"], outs);
    expect(dead.length === 0, `round ${i}: 40P01 victim ${dead.join(", ")} (sets ${JSON.stringify(sets.map((s) => s.map((x) => w.lines.indexOf(x))))})`);
    const overlap = sets[0]!.some((x) => sets[1]!.includes(x));
    const wins = outs.filter((o) => o.ok).length;
    expect(overlap ? wins === 1 : wins === 2, `round ${i}: overlap=${overlap} but ${wins} creates succeeded (${outs.map(fmt).join(" | ")})`);
    for (const [k, o] of outs.entries()) if (!o.ok) expectRefused(o, "P0066", /already has a result/, `round ${i} loser c${k + 1}`);
    eq(`round ${i}: links`, await linkCount(w.lines), new Set(outs.flatMap((o, k) => (o.ok ? sets[k]! : []))).size);
    for (const [k, o] of outs.entries()) {
      if (!o.ok) continue;
      const id = o.rows[0]!.id as string;
      const held = (await monitor.query<{ t: string }>("select test_request_id as t from public.result_test_requests where result_id = $1 order by 1", [id])).rows.map((r) => r.t);
      eq(`round ${i}: winner c${k + 1} holds exactly its set`, held, [...sets[k]!].sort());
    }
    await closeAll();
  }
});

// C3 - create vs delete_test_request_lines (0216: patient shared -> visit FOR UPDATE -> lines by id -> UPDATE).
S("C3", "result_create_linked: create vs delete_test_request_lines, both orders", async () => {
  // Delete first: the create queues on the line the delete holds, then finds it deleted -> P0066, no link.
  const w1 = await mkWorld(1);
  const a1 = await forced({
    first: (a) => delLines(a, w1.visit, w1.lines),
    second: (b) => create(b, w1.lines, { notes: `${TAG}:C3a` }),
    wait: { kind: "row", rel: "visits" },
    why: "the create's shared visit lock queues behind the delete's FOR UPDATE on the visit (0223: visit before lines)",
  });
  expectOk(a1.o1, "delete");
  expectRefused(a1.o2, "P0066", /not found or has been deleted/, "create after delete");
  eq("delete-first: no link on a deleted line", await linkCount(w1.lines), 0);
  eq("delete-first: no result minted", await resultsNoted(`${TAG}:C3a`), 0);
  eq("delete-first: the line is deleted", (await lineStatus(w1.lines))[w1.lines[0]!], "in_progress+deleted");
  // Create first: the delete queues on the line (it already holds the visit), then deletes a line that now has a result.
  const w2 = await mkWorld(1);
  const b2 = await forced({
    first: (a) => create(a, w2.lines, { notes: `${TAG}:C3b` }),
    second: (b) => delLines(b, w2.visit, w2.lines),
    wait: { kind: "row", rel: "visits" },
    why: "the delete's visit FOR UPDATE queues behind the create's shared visit lock (0223: visit before lines)",
  });
  expectOk(b2.o1, "create");
  const st = (await lineStatus(w2.lines))[w2.lines[0]!];
  const links = await linkCount(w2.lines);
  expect(b2.o2.ok ? st === "in_progress+deleted" && links === 1 : st === "in_progress" && links === 1, `create-first: delete ${fmt(b2.o2)} but the line is ${st} with ${links} link(s)`);
});

// C4 - create vs a visit soft delete (0223). result_create_linked took patient (shared) -> lines FOR UPDATE and never the
//      VISIT row, while a visit soft delete takes patient (shared) -> visit row: nothing serialised them, so a draft result
//      could be linked to a line of a visit deleted meanwhile (the create's "visit not deleted" recount read the snapshot
//      from before the delete committed). Now the create takes the visit FOR SHARE after the patient lock (release's step 3)
//      and re-reads deleted_at under it: delete first -> the create queues on the visit row, then is refused P0066 and links
//      nothing; create first -> the delete queues on the visit row, then deletes (the serial create -> delete outcome).
// 0223 -- was a KNOWN issue (reproduced in both orders); mutant MC7 restores the lock-free body.
const softDelete = (a: Actor, visit: string) =>
  call(a, "update public.visits set deleted_at = now(), deleted_by = $2, delete_reason = 'rlc proof' where id = $1", [visit, fx.admin]);
const visitDeleted = async (visit: string) => (await monitor.query("select deleted_at is not null as d from public.visits where id = $1", [visit])).rows[0]!.d as boolean;
S("C4", "result_create_linked vs a visit soft delete, both orders - the visit row serialises them (a result never lands on a deleted visit's line)", async () => {
  // Delete first: the create queues on the visit row, then finds the visit deleted: P0066, no link, no result minted.
  const w1 = await mkWorld(1);
  const a = await forced({
    first: (x) => softDelete(x, w1.visit),
    second: (y) => create(y, w1.lines, { notes: `${TAG}:C4a` }),
    wait: { kind: "row", rel: "visits" },
    why: "the create's shared visit lock queues behind the visit soft delete's row lock",
  });
  expectOk(a.o1, "visit soft delete");
  expectRefused(a.o2, "P0066", /not found or has been deleted/, "create after the visit delete");
  eq("delete-first: the visit is deleted", await visitDeleted(w1.visit), true);
  eq("delete-first: nothing linked", await linkCount(w1.lines), 0);
  eq("delete-first: no result minted", await resultsNoted(`${TAG}:C4a`), 0);
  // Create first: the delete queues on the visit row the create holds shared, then deletes the visit (serial create -> delete).
  const w2 = await mkWorld(1);
  const b = await forced({
    first: (x) => create(x, w2.lines, { notes: `${TAG}:C4b` }),
    second: (y) => softDelete(y, w2.visit),
    wait: { kind: "row", rel: "visits" },
    why: "the visit soft delete queues behind the create's shared visit lock",
  });
  expectOk(b.o1, "create");
  expectOk(b.o2, "visit soft delete after the create");
  eq("create-first: the visit is deleted", await visitDeleted(w2.visit), true);
  eq("create-first: the result stays linked (the serial create -> delete outcome)", await linkCount(w2.lines), 1);
});

// C5 - create vs merge_patients_guarded of the test's patient (merge: membership shared -> both patients exclusive).
S("C5", "result_create_linked: create vs merge of the test's patient, both orders - never a result across two patients", async () => {
  // Merge first: the create queues on the patient lock, then is refused (the patient it resolved is now a tombstone).
  const keep1 = await mkPatient();
  const w1 = await mkWorld(1);
  const a1 = await forced({
    first: (a) => mergeP(a, keep1, w1.patient),
    second: (b) => create(b, w1.lines, { notes: `${TAG}:C5a` }),
    wait: { kind: "lifecycle", ids: [w1.patient] },
    why: "the create's shared patient lock queues behind the merge's exclusive one",
  });
  expectOk(a1.o1, "merge");
  refusedAny(a1.o2, ["P0058", "P0072"], "create after merge");
  eq("merge-first: no result for the moved test", await linkCount(w1.lines), 0);
  eq("merge-first: no result minted", await resultsNoted(`${TAG}:C5a`), 0);
  // Create first: the merge queues on the patient lock, then moves the visit; the result follows its test to ONE patient.
  const keep2 = await mkPatient();
  const w2 = await mkWorld(1);
  const b2 = await forced({
    first: (a) => create(a, w2.lines, { notes: `${TAG}:C5b` }),
    second: (b) => mergeP(b, keep2, w2.patient),
    wait: { kind: "lifecycle", ids: [w2.patient, keep2] },
    why: "the merge's exclusive patient lock queues behind the create's shared one",
  });
  expectOk(b2.o1, "create");
  // The merge resolved its source patient's results BEFORE the create committed, so it either merges (the result then
  // follows its test to the kept record) or fails closed with P0072 (retry); never a result across two patients.
  if (!b2.o2.ok) refusedAny(b2.o2, ["P0072"], "merge after create");
  const [res] = await linkedResults(w2.lines);
  expect(res !== undefined, "create-first: the result is linked");
  eq("create-first: the result holds ONE patient", await patientsOfResult(res!), [b2.o2.ok ? keep2 : w2.patient]);
});

// C6 - create vs delete_patient: the create's shared patient lock vs the delete's exclusive one, both orders.
S("C6", "result_create_linked: create vs delete_patient of the test's patient, both orders", async () => {
  const mk = async () => {
    const patient = await mkPatient();
    const visit = await mkVisit(patient, 0);
    return { patient, visit, lines: await mkLines(visit, 1, { status: "cancelled", price: 0 }) };
  };
  // Delete first: the create is refused P0058 and links nothing.
  const w1 = await mk();
  const a1 = await forced({
    first: (a) => delPatient(a, w1.patient),
    second: (b) => create(b, w1.lines, { notes: `${TAG}:C6a` }),
    wait: { kind: "lifecycle", ids: [w1.patient] },
    why: "the create's shared patient lock queues behind the delete's exclusive one",
  });
  expectOk(a1.o1, "delete_patient");
  expectRefused(a1.o2, "P0058", /deleted/, "create after delete");
  eq("delete-first: nothing linked", await linkCount(w1.lines), 0);
  // Create first: the delete queues, then decides on what the create committed (ok, or refused with open items).
  const w2 = await mk();
  const b2 = await forced({
    first: (a) => create(a, w2.lines, { notes: `${TAG}:C6b` }),
    second: (b) => delPatient(b, w2.patient),
    wait: { kind: "lifecycle", ids: [w2.patient] },
    why: "the delete's exclusive patient lock queues behind the create's shared one",
  });
  expectOk(b2.o1, "create");
  const deleted = (await monitor.query("select deleted_at is not null as d from public.patients where id = $1", [w2.patient])).rows[0]!.d as boolean;
  expect(b2.o2.ok ? deleted : !deleted && !b2.o2.ok && b2.o2.code === "P0059", `create-first: delete_patient answered ${fmt(b2.o2)} but deleted=${deleted}`);
  eq("create-first: the result stays linked", await linkCount(w2.lines), 1);
});

// C7 - create vs a visit re-assigned to ANOTHER patient while it waited: the post-lock re-check refuses P0072 (retry once).
S("C7", "result_create_linked: create vs a visit moved to another patient - P0072 (the post-lock patient re-check)", async () => {
  const w = await mkWorld(1);
  const other = await mkPatient();
  const { o1, o2 } = await forced({
    first: (a) => reassignVisit(a, w.visit, other),
    second: (b) => create(b, w.lines, { notes: `${TAG}:C7` }),
    firstAs: "raw",
    wait: { kind: "lifecycle", ids: [w.patient] },
    why: "the visit move holds both patients exclusively",
  });
  expectOk(o1, "visit move");
  expectRefused(o2, "P0072", /changed while the result was being saved/, "create");
  eq("nothing linked", await linkCount(w.lines), 0);
});

// C8 - the patient lock must be taken BEFORE the lines. S = delete_test_request_lines (patient shared -> visit -> lines) is
//      held at the visit by V; X = merge (patient exclusive) queues behind S's shared lock; C = create then asks for the
//      patient lock behind X. A create that had already locked the line would form S -> C -> X -> S when V lets go; the
//      lock manager resolves THAT particular cycle by re-queueing C ahead of X (a "soft" deadlock - a shared request that is
//      compatible with the holders), so it never surfaces as a 40P01 and cannot be the catch. The order is proven
//      directly instead: while C is queued on the patient lock it must hold no row of the test. All three still finish.
S("C8", "result_create_linked: patient lock BEFORE the lines - the create holds no line while queued behind a waiting exclusive request", async () => {
  const w = await mkWorld(1);
  const keep = await mkPatient();
  const [v, s, x, c] = [await actor("visit-holder"), await actor("line-deleter"), await actor("merger"), await actor("creator")];
  await begin(v, "raw");
  await v.c.query("select 1 from public.visits where id = $1 for update", [w.visit]);
  await begin(s);
  const ps = andEnd(s, delLines(s, w.visit, w.lines));
  await mustWait(s, { kind: "row", rel: "visits" }, "the line delete holds the patient lock and queues on the visit row V holds");
  await begin(x);
  const px = andEnd(x, mergeP(x, keep, w.patient));
  await mustWait(x, { kind: "lifecycle", ids: [w.patient] }, "the merge's exclusive patient lock queues behind the delete's shared one");
  await begin(c);
  const pc = andEnd(c, create(c, w.lines, { notes: `${TAG}:C8` }));
  await mustWait(c, { kind: "lifecycle", ids: [w.patient] }, "the create's shared patient lock queues behind the waiting exclusive request");
  // The order itself: while the create is queued on the patient lock it must hold NO row of the test (the delete cannot
  // have it yet either - it is still queued on the visit). With the lines locked first the create would sit on them.
  const lineLocked = await monitor.query("select 1 from public.test_requests where id = $1 for update skip locked", [w.lines[0]]);
  const heldByCreate = await tupleRels(c.pid);
  await end(v, { ok: true, rows: [], rowCount: 0 }); // V lets go of the visit
  const [os, ox, oc] = await Promise.all([bothAnswer(["delete", "merge/create"], ps, pc).then((r) => r[0]), px, pc]);
  const dead = victims(["line delete", "merge", "create"], [os, ox, oc]);
  expect(dead.length === 0, `cycle: 40P01 victim ${dead.join(", ")} (the create already held ${JSON.stringify(heldByCreate)} while queued on the patient lock) - ${[os, ox, oc].map(fmt).join(" | ")}`);
  expect(lineLocked.rowCount === 1, `the create already holds the test row while it is queued on the patient lock: the lines were locked BEFORE the patient lock`);
  expectOk(os, "line delete");
  expectOk(ox, "merge");
  refusedAny(oc, ["P0058", "P0066", "P0072"], "create");
});

// C9 - create takes its lines in id order. A holder pins the LOWEST of two lines (stored in reverse heap order and read
//      by a sequential scan); an id-ordered writer that takes no visit lock (unclaim_panel_members: lines only) queues on
//      it first; the create then arrives. Heap-order locking would take the higher line first and meet the writer in a
//      cycle when the holder lets go. (A delete_test_request_lines writer would hold the visit FOR UPDATE and stop the create
//      at the visit before it reaches any line since 0223, so the writer here is the one that does not.)
S("C9", "result_create_linked: lines FOR UPDATE in id order vs an id-ordered writer (no 40P01)", async () => {
  const w = await mkWorld(2, { desc: true });
  const [lo] = w.lines as [string, string];
  const [h, wr, cr] = [await actor("holder"), await actor("unclaim"), await actor("creator")];
  await begin(h, "raw");
  await h.c.query("select 1 from public.test_requests where id = $1 for update", [lo]);
  await begin(wr, { uid: fx.med });
  const pw = andEnd(wr, unclaimAs(wr, w.lines));
  await mustWait(wr, { kind: "row", rel: "test_requests" }, "the id-ordered writer queues on the lowest line the holder pins");
  await begin(cr);
  for (const g of ["set local enable_seqscan = on", "set local enable_indexscan = off", "set local enable_indexonlyscan = off", "set local enable_bitmapscan = off"]) await cr.c.query(g);
  const pc = andEnd(cr, create(cr, w.lines, { notes: `${TAG}:C9` }));
  await mustWait(cr, { kind: "row", rel: "test_requests" }, "the create queues on a line behind the writer");
  await end(h, { ok: true, rows: [], rowCount: 0 });
  const [ow, oc] = await bothAnswer(["unclaim", "create"], pw, pc);
  const dead = victims(["unclaim", "create"], [ow, oc]);
  expect(dead.length === 0, `lock-order cycle: 40P01 victim ${dead.join(", ")} - ${fmt(ow)} | ${fmt(oc)}`);
  expectOk(ow, "unclaim");
  expectOk(oc, "create after the unclaim");
  eq("both lines linked to the new result, handed back to 'requested' by the unclaim", [await linkCount(w.lines), Object.values(await lineStatus(w.lines))], [2, ["requested", "requested"]]);
});

// C10 - create vs claim_panel_members (0211) of the same requested lines, both orders: the consolidated flow's own pair
//       (claim the panel, then create its combined result). Both id-ordered; both must finish.
const claimPanel = (a: Actor, ids: string[]) => call(a, "select public.claim_panel_members($1::uuid[]) as n", [ids]);
S("C10", "result_create_linked vs claim_panel_members on the same lines, both orders - both finish", async () => {
  const w1 = await mkWorld(2, { status: "requested" });
  const a = await forced({
    first: (x) => claimPanel(x, w1.lines),
    firstAs: { uid: fx.med },
    second: (y) => create(y, w1.lines, { notes: `${TAG}:C10a` }),
    wait: { kind: "row", rel: "test_requests" },
    why: "the create queues on the lines the claim locked",
  });
  expectOk(a.o1, "claim");
  expectOk(a.o2, "create after the claim");
  eq("claim-first: claimed and linked", [Object.values(await lineStatus(w1.lines)), await linkCount(w1.lines)], [["in_progress", "in_progress"], 2]);
  const w2 = await mkWorld(2, { status: "requested" });
  const b = await forced({
    first: (x) => create(x, w2.lines, { notes: `${TAG}:C10b` }),
    second: (y) => claimPanel(y, w2.lines),
    secondAs: { uid: fx.med },
    wait: { kind: "row", rel: "test_requests" },
    why: "the claim's id-ordered pre-lock queues on the lines the create locked",
  });
  expectOk(b.o1, "create");
  expectOk(b.o2, "claim after the create");
  eq("create-first: linked and claimed", [Object.values(await lineStatus(w2.lines)), await linkCount(w2.lines)], [["in_progress", "in_progress"], 2]);
});

// C11 - create vs release_visit_results (0198/0214: membership shared -> patient -> visit FOR SHARE -> lines by id).
S("C11", "result_create_linked vs release_visit_results on the same line, both orders - no 40P01; the release re-plans (40001)", async () => {
  // Release first: it locks the line (and finds nothing releasable), the create queues on the line, then links.
  const w1 = await mkWorld(1);
  const a = await forced({
    first: (x) => release(x, w1.visit, w1.lines),
    firstAs: { uid: fx.med },
    second: (y) => create(y, w1.lines, { notes: `${TAG}:C11a` }),
    wait: { kind: "row", rel: "test_requests" },
    why: "the create queues on the line the release locked FOR UPDATE",
  });
  expectOk(a.o1, "release");
  expectOk(a.o2, "create after the release");
  eq("release-first: linked", await linkCount(w1.lines), 1);
  // Create first: the release read the report set (none) before the link committed; after the line lock it re-reads and
  // asks the caller to retry (40001) instead of planning on a stale membership.
  const w2 = await mkWorld(1);
  const b = await forced({
    first: (x) => create(x, w2.lines, { notes: `${TAG}:C11b` }),
    second: (y) => release(y, w2.visit, w2.lines),
    secondAs: { uid: fx.med },
    wait: { kind: "row", rel: "test_requests" },
    why: "the release's line locks queue behind the create",
  });
  expectOk(b.o1, "create");
  expectRefused(b.o2, "40001", /changed just now/, "release after the create");
  eq("create-first: linked", await linkCount(w2.lines), 1);
});

// ---------------------------------------------------------------------------
// result_finalise_commit / result_save_draft
// ---------------------------------------------------------------------------
async function mkDraftWorld(n = 2, draftIdx: number[] | null = [0, 1]): Promise<World & { result: string }> {
  const w = await mkWorld(n);
  return { ...w, result: await mkDraft(w.lines.slice(0, 2), draftIdx, 1) };
}
const isoUs = (d: Date) => `${d.toISOString().slice(0, -1)}000`;
const notInProgress = async (ids: string[]) => Object.values(await lineStatus(ids)).every((s) => s !== "in_progress");

// concurrency-proof: result_finalise_commit
// F1 - two finalises of one result: the second queues on the results row (FOR UPDATE), then is refused "already
//      finalised" (P0066) and changes NOTHING: the first one's instant, PDF pointer and value set stand.
S("F1", "result_finalise_commit: finalise vs finalise - one finalisation, the loser P0066 and nothing overwritten", async () => {
  const w = await mkDraftWorld();
  const at = new Date(Date.now() - 60_000);
  const { o1, o2 } = await forced({
    first: (a) => finalise(a, w.result, vals([0, 1, 2], 10), "f1a", at),
    second: (b) => finalise(b, w.result, vals([0, 1, 2, 3], 50), "f1b", new Date()),
    wait: { kind: "row", rel: "results" },
    why: "the second finalise queues on the results row the first locked FOR UPDATE",
  });
  expectOk(o1, "first finalise");
  expectRefused(o2, "P0066", /already finalised/, "second finalise");
  const st = await resState(w.result);
  eq("the first finalisation's instant stands", st.finalised_at, isoUs(at));
  eq("the first finalisation's PDF pointer stands", st.storage_path, `rlc/${TAG}/f1a.pdf`);
  eq("the first finalisation's value set stands", st.values, valMap([0, 1, 2], 10));
  expect(await notInProgress(w.lines), "the linked tests advanced");
});

// concurrency-proof: result_save_draft
// F2 - finalise vs save_draft, both orders. A draft must never overwrite finalised values, and a finalise must replace
//      whatever draft landed first with its own COMPLETE value set.
S("F2", "result_save_draft: finalise vs save_draft, both orders - a draft never overwrites finalised values", async () => {
  // Finalise first: the draft queues on the results row, then is refused (already finalised).
  const w1 = await mkDraftWorld();
  const a = await forced({
    first: (x) => finalise(x, w1.result, vals([0, 1, 2], 10), "f2a"),
    second: (y) => saveDraft(y, w1.result, vals([1, 3], 90)),
    wait: { kind: "row", rel: "results" },
    why: "the draft queues on the results row the finalise locked",
  });
  expectOk(a.o1, "finalise");
  expectRefused(a.o2, "P0066", /already finalised/, "draft after finalise");
  eq("finalise-first: the finalised value set is intact", (await resState(w1.result)).values, valMap([0, 1, 2], 10));
  // Draft first: the finalise queues, then replaces the draft with exactly its own set.
  const w2 = await mkDraftWorld();
  const b = await forced({
    first: (x) => saveDraft(x, w2.result, vals([2, 3], 70)),
    second: (y) => finalise(y, w2.result, vals([0, 1], 10), "f2b"),
    wait: { kind: "row", rel: "results" },
    why: "the finalise queues on the results row the draft locked",
  });
  expectOk(b.o1, "draft");
  expectOk(b.o2, "finalise after the draft");
  eq("draft-first: exactly the finalise's value set remains", (await resState(w2.result)).values, valMap([0, 1], 10));
});

// F3 - finalise vs result_edit_commit (0179) of the same result: the edit queues on the results row, then amends the
//      now-finalised result (amendment 1); a finalised result is only ever edited, never re-finalised.
const editCommit = (a: Actor, result: string, anchor: string, v: ReturnType<typeof vals>) =>
  call(a, "select public.result_edit_commit($1::uuid, $2::uuid, 0, $3::uuid, $4, $5::uuid, $6, 1111, $7::jsonb, null, null) as r", [
    randomUUID(),
    result,
    fx.med,
    "rlc proof edit after finalise",
    anchor,
    `rlc/${TAG}/f3-edit.pdf`,
    JSON.stringify(v),
  ]);
S("F3", "result_finalise_commit vs result_edit_commit: finalise first, the edit queues on the results row and amends it", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => finalise(a, w.result, vals([0, 1], 10), "f3a"),
    second: (b) => editCommit(b, w.result, w.lines[0]!, vals([0, 1, 2], 200)),
    wait: { kind: "row", rel: "results" },
    why: "the edit queues on the results row the finalise locked",
  });
  expectOk(o1, "finalise");
  expectOk(o2, "edit after the finalise");
  const st = await resState(w.result);
  eq("the edit's value set stands", st.values, valMap([0, 1, 2], 200));
  eq("the edit's PDF stands", st.storage_path, `rlc/${TAG}/f3-edit.pdf`);
  eq("amendment count", num((await monitor.query("select amendment_count as n from public.results where id = $1", [w.result])).rows[0]!.n), 1);
});

// F5 - finalise vs a link insert (the exclusive membership lock), both orders.
S("F5", "result_finalise_commit: finalise vs a link insert on the same result - the membership lock orders them", async () => {
  // Link first: the finalise queues on the MEMBERSHIP lock, then finalises (and advances) all three tests.
  const w1 = await mkDraftWorld(3);
  const third1 = w1.lines.find((l) => !w1.lines.slice(0, 2).includes(l))!;
  const a = await forced({
    first: (x) => addLink(x, w1.result, third1),
    firstAs: "raw",
    second: (y) => finalise(y, w1.result, vals([0, 1], 10), "f5a"),
    wait: { kind: "membership", ids: [w1.result] },
    why: "the finalise's shared membership lock queues behind the link insert's exclusive one",
  });
  expectOk(a.o1, "link insert");
  expectOk(a.o2, "finalise after the link insert");
  expect(await notInProgress(w1.lines), `link-first: every linked test advanced (${JSON.stringify(await lineStatus(w1.lines))})`);
  eq("link-first: three links", await linkCount(w1.lines), 3);
  // Finalise first: the link insert queues on the membership lock; the added test then joins a FINALISED result and advances.
  const w2 = await mkDraftWorld(3);
  const third2 = w2.lines.find((l) => !w2.lines.slice(0, 2).includes(l))!;
  const b = await forced({
    first: (x) => finalise(x, w2.result, vals([0, 1], 10), "f5b"),
    second: (y) => addLink(y, w2.result, third2),
    secondAs: "raw",
    wait: { kind: "membership", ids: [w2.result] },
    why: "the link insert's exclusive membership lock queues behind the finalise's shared one",
  });
  expectOk(b.o1, "finalise");
  expectOk(b.o2, "link insert after the finalise");
  expect(await notInProgress(w2.lines), `finalise-first: the late-linked test advanced (${JSON.stringify(await lineStatus(w2.lines))})`);
  eq("finalise-first: three links", await linkCount(w2.lines), 3);
});

// F6 - finalise vs the writers of its lines. Until 0223 the finalise validated "every linked line is in progress" from a
//      snapshot without locking the lines (or their visit); the status flip happened later in a trigger. Now (membership ->
//      patient -> results row ->) the linked VISIT rows FOR SHARE, then the linked lines ORDER BY id FOR NO KEY UPDATE, and
//      only then the live / in-progress checks.
const unclaimAs = (a: Actor, lines: string[]) => unclaim(a, lines, lines.map(() => fx.med));
// F6a - unclaim of the report's lines in flight: the finalise queues on the lines, then finds them handed back and is refused whole.
//       (Was KNOWN: it read them in_progress from a snapshot, finalised, and its advance trigger flipped the first line over
//       the unclaim's 'requested' with an UPDATE that had no status guard and skipped the second.)
S("F6a", "result_finalise_commit vs unclaim_panel_members, unclaim first - the finalise is refused (P0066), nothing finalised", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => unclaimAs(a, w.lines),
    firstAs: { uid: fx.med },
    second: (b) => finalise(b, w.result, vals([0, 1], 10), "f6a"),
    wait: { kind: "row", rel: "test_requests" },
    why: "the finalise's line locks queue on the lines the unclaim holds",
  });
  expectOk(o1, "unclaim");
  expectRefused(o2, "P0066", /not in progress/, "finalise after the unclaim");
  const st = await resState(w.result);
  eq("the result stays a draft (no finalised_at, no PDF pointer)", [st.finalised, st.storage_path], [false, null]);
  eq("both tests stay handed back to 'requested'", Object.values(await lineStatus(w.lines)), ["requested", "requested"]);
});
// F6b - finalise first: the unclaim queues on the lines, then finds them advanced and is refused whole (P0077).
S("F6b", "result_finalise_commit vs unclaim_panel_members, finalise first - the unclaim is refused whole", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => finalise(a, w.result, vals([0, 1], 10), "f6b"),
    second: (b) => unclaimAs(b, w.lines),
    secondAs: { uid: fx.med },
    wait: { kind: "row", rel: "test_requests" },
    why: "the unclaim queues on the lines the finalise's trigger advanced",
  });
  expectOk(o1, "finalise");
  expectRefused(o2, "P0077", null, "unclaim after finalise");
  expect(await notInProgress(w.lines), "the lines stay advanced");
});
// F6c - release first: it locks every member of the report FOR UPDATE and refuses (the members are unfinished); the
//       finalise queues on those lines, then finalises.
S("F6c", "result_finalise_commit vs release_visit_results, release first - both finish", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => release(a, w.visit, [w.lines[0]!]),
    firstAs: { uid: fx.med },
    second: (b) => finalise(b, w.result, vals([0, 1], 10), "f6c"),
    wait: { kind: "row", rel: "test_requests" },
    why: "the finalise's trigger queues on the report members the release locked",
  });
  expectOk(o1, "release");
  expectOk(o2, "finalise");
  expect(await notInProgress(w.lines), "the lines advanced");
});
// F6d/F6e - lock-order check against release: a holder pins the LOWEST line, release (id order) queues on it first, then
//   the finalise arrives. Until 0223 the finalise's trigger walked the junction in HEAP order, so with the junction stored
//   in reverse (F6d) it took the higher line first and met release in a cycle (40P01) when the holder let go. Now the
//   finalise locks its lines ORDER BY id itself, before the trigger runs, so it queues on the lowest line holding nothing.
//   F6d builds the reverse heap order on BOTH tables (the junction AND test_requests, each verified by ctid with a bounded
//   retry) and forces a sequential scan for the finalise, so a lock query without ORDER BY (mutant MF8) takes the higher
//   line first, deterministically. F6e is the id-ordered storage (no cycle possible either way).
async function finaliseVsReleaseOrder(desc: boolean): Promise<{ or: Out; of: Out }> {
  const w = await mkWorld(2, desc ? { desc: true } : {});
  const result = desc ? await mkDescDraft(w.lines) : await mkDraft(w.lines, [0, 1], 1);
  const [lo] = w.lines as [string, string];
  const [h, rel, fin] = [await actor("holder"), await actor("release"), await actor("finalise")];
  await begin(h, "raw");
  await h.c.query("select 1 from public.test_requests where id = $1 for update", [lo]);
  await begin(rel, { uid: fx.med });
  const pr = andEnd(rel, release(rel, w.visit, [lo]));
  await mustWait(rel, { kind: "row", rel: "test_requests" }, "release (id order) queues on the lowest line the holder pins");
  await begin(fin);
  if (desc) for (const g of ["set local enable_seqscan = on", "set local enable_indexscan = off", "set local enable_indexonlyscan = off", "set local enable_bitmapscan = off"]) await fin.c.query(g);
  const pf = andEnd(fin, finalise(fin, result, vals([0, 1], 10), desc ? "f6d" : "f6e"));
  await mustWait(fin, { kind: "row", rel: "test_requests" }, "the finalise's line locks queue on a line release holds or wants");
  await end(h, { ok: true, rows: [], rowCount: 0 });
  const [or, of] = await bothAnswer(["release", "finalise"], pr, pf);
  return { or, of };
}
S("F6e", "result_finalise_commit vs release_visit_results, junction in id order - no 40P01", async () => {
  const { or, of } = await finaliseVsReleaseOrder(false);
  const dead = victims(["release", "finalise"], [or, of]);
  expect(dead.length === 0, `lock-order cycle: 40P01 victim ${dead.join(", ")} - ${fmt(or)} | ${fmt(of)}`);
  expectOk(or, "release");
  expectOk(of, "finalise");
});
S("F6d", "result_finalise_commit vs release_visit_results, junction AND lines stored in reverse id order - no 40P01", async () => {
  const { or, of } = await finaliseVsReleaseOrder(true);
  const dead = victims(["release", "finalise"], [or, of]);
  expect(dead.length === 0, `lock-order cycle: 40P01 victim ${dead.join(", ")} (release locks lines by id; the finalise took them in heap order, higher id first) - ${fmt(or)} | ${fmt(of)}`);
  expectOk(or, "release");
  expectOk(of, "finalise");
});

// concurrency-proof: advance_test_on_result_upload
// F6g - the status-flip trigger ALONE (advance_test_on_result_upload, fired by a results UPDATE that sets finalised_at; no
//       finalise function in front of it): an unclaim holds the lines, the trigger's UPDATE queues on the first, the unclaim
//       commits ('requested'), and the trigger must then leave the handed-back lines alone (its UPDATE is WHERE status =
//       'in_progress'). Without the guard it flipped the first line to ready_for_release over the unclaim and skipped the second.
S("F6g", "advance_test_on_result_upload alone vs unclaim_panel_members - a line handed back while the flip waited is not flipped", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => unclaimAs(a, w.lines),
    firstAs: { uid: fx.med },
    second: (b) => call(b, "update public.results set finalised_at = now(), storage_path = $2 where id = $1", [w.result, `rlc/${TAG}/f6g.pdf`]),
    secondAs: "raw",
    wait: { kind: "row", rel: "test_requests" },
    why: "the trigger's UPDATE of the first line queues on the line the unclaim holds",
  });
  expectOk(o1, "unclaim");
  expectOk(o2, "results update (the trigger runs)");
  eq("the lines stay handed back to 'requested' - the late flip skipped them", Object.values(await lineStatus(w.lines)), ["requested", "requested"]);
});

// F7 - finalise vs merge_patients_guarded, both orders.
S("F7", "result_finalise_commit: finalise vs merge of the result's patient, both orders", async () => {
  // Merge first: the finalise queues on the patient lock, then is refused; the result stays a draft.
  const keep1 = await mkPatient();
  const w1 = await mkDraftWorld();
  const a = await forced({
    first: (x) => mergeP(x, keep1, w1.patient),
    second: (y) => finalise(y, w1.result, vals([0, 1], 10), "f7a"),
    wait: { kind: "lifecycle", ids: [w1.patient] },
    why: "the finalise's shared patient lock queues behind the merge's exclusive one",
  });
  expectOk(a.o1, "merge");
  refusedAny(a.o2, ["P0058", "P0072"], "finalise after merge");
  eq("merge-first: the result stays a draft", (await resState(w1.result)).finalised, false);
  // Finalise first: the merge queues, then moves the visit; the finalised result follows its tests to ONE patient.
  const keep2 = await mkPatient();
  const w2 = await mkDraftWorld();
  const b = await forced({
    first: (x) => finalise(x, w2.result, vals([0, 1], 10), "f7b"),
    second: (y) => mergeP(y, keep2, w2.patient),
    wait: { kind: "lifecycle", ids: [w2.patient, keep2] },
    why: "the merge's exclusive patient lock queues behind the finalise's shared one",
  });
  expectOk(b.o1, "finalise");
  if (!b.o2.ok) refusedAny(b.o2, ["P0072"], "merge after finalise");
  eq("finalise-first: finalised", (await resState(w2.result)).finalised, true);
  eq("finalise-first: the result holds ONE patient", await patientsOfResult(w2.result), [b.o2.ok ? keep2 : w2.patient]);
});

// F8 - finalise vs delete_test_request_lines of one member of the combined report.
S("F8", "result_finalise_commit vs delete_test_request_lines of a member, finalise first - the delete is refused (P0067)", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => finalise(a, w.result, vals([0, 1], 10), "f8a"),
    second: (b) => delLines(b, w.visit, [w.lines[1]!]),
    wait: { kind: "row", rel: "visits" },
    why: "the delete's visit FOR UPDATE queues behind the finalise's shared visit lock (0223)",
  });
  expectOk(o1, "finalise");
  expectRefused(o2, "P0067", /finished combined report/, "delete of a member after the finalise");
  eq("the member is not deleted", (await lineStatus([w.lines[1]!]))[w.lines[1]!], "ready_for_release");
});
// F8b - delete first. The delete holds the visit FOR UPDATE and the member; the finalise now queues on the VISIT row, then (once the
//       delete commits) re-reads its lines under the locks and is refused: a member of the report was deleted. (Was KNOWN: the
//       delete's P0067 guard saw an unfinalised draft and let it through, and the finalise - which checked "live" from a
//       snapshot and never locked the lines - finalised a PDF over the deleted test, the state P0067 exists to prevent.)
S("F8b", "result_finalise_commit vs delete_test_request_lines of a member, delete first - the finalise is refused (P0066)", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (a) => delLines(a, w.visit, [w.lines[1]!]),
    second: (b) => finalise(b, w.result, vals([0, 1], 10), "f8b"),
    wait: { kind: "row", rel: "visits" },
    why: "the finalise's shared visit lock queues behind the delete's FOR UPDATE on the visit",
  });
  expectOk(o1, "delete");
  expectRefused(o2, "P0066", /has been deleted/, "finalise after the delete of a member");
  const fin = await resState(w.result);
  eq("the report stays a draft (no finalised_at, no PDF pointer)", [fin.finalised, fin.storage_path], [false, null]);
  const st = await lineStatus(w.lines);
  eq("the deleted member keeps its status (not flipped), the other stays in progress", [st[w.lines[1]!], st[w.lines[0]!]], ["in_progress+deleted", "in_progress"]);
});

// F11 - finalise vs a visit soft delete, both orders (the finalise's twin of C4): the finalise's shared visit lock and the
//       delete's row lock serialise them. Delete first -> refused (no live test: the visit is deleted), the result stays a
//       draft; finalise first -> the delete queues, then deletes (the serial finalise -> delete outcome).
S("F11", "result_finalise_commit vs a visit soft delete, both orders - the visit row serialises them", async () => {
  const w1 = await mkDraftWorld();
  const a = await forced({
    first: (x) => softDelete(x, w1.visit),
    second: (y) => finalise(y, w1.result, vals([0, 1], 10), "f11a"),
    wait: { kind: "row", rel: "visits" },
    why: "the finalise's shared visit lock queues behind the visit soft delete's row lock",
  });
  expectOk(a.o1, "visit soft delete");
  expectRefused(a.o2, "P0066", /no live test is linked/, "finalise after the visit delete");
  eq("delete-first: the result stays a draft", [(await resState(w1.result)).finalised, await visitDeleted(w1.visit)], [false, true]);
  const w2 = await mkDraftWorld();
  const b = await forced({
    first: (x) => finalise(x, w2.result, vals([0, 1], 10), "f11b"),
    second: (y) => softDelete(y, w2.visit),
    wait: { kind: "row", rel: "visits" },
    why: "the visit soft delete queues behind the finalise's shared visit lock",
  });
  expectOk(b.o1, "finalise");
  expectOk(b.o2, "visit soft delete after the finalise");
  eq("finalise-first: finalised, then the visit deleted", [(await resState(w2.result)).finalised, await visitDeleted(w2.visit)], [true, true]);
});

// F9 - finalise vs a visit moved to another patient while it waited: the post-lock re-check refuses P0072.
S("F9", "result_finalise_commit: finalise vs a visit moved to another patient - P0072 (the post-lock patient re-check)", async () => {
  const w = await mkDraftWorld();
  const other = await mkPatient();
  const { o1, o2 } = await forced({
    first: (a) => reassignVisit(a, w.visit, other),
    firstAs: "raw",
    second: (b) => finalise(b, w.result, vals([0, 1], 10), "f9"),
    wait: { kind: "lifecycle", ids: [w.patient] },
    why: "the visit move holds both patients exclusively",
  });
  expectOk(o1, "visit move");
  expectRefused(o2, "P0072", /changed while it was being saved/, "finalise");
  eq("the result stays a draft", (await resState(w.result)).finalised, false);
});

// F10 - finalise vs delete_patient. A patient with a test in progress is not deletable (open items): the delete queues on the
//       lifecycle lock behind the finalise, then is refused whole (P0059) and disturbs nothing. (The other order cannot be
//       held open: a refused delete aborts its transaction and drops its locks at once; the delete-wins orders are C6/F7.)
S("F10", "result_finalise_commit vs delete_patient - the delete queues behind the finalise, is refused (P0059), the finalise stands", async () => {
  const w = await mkDraftWorld();
  const { o1, o2 } = await forced({
    first: (x) => finalise(x, w.result, vals([0, 1], 10), "f10"),
    second: (y) => delPatient(y, w.patient),
    wait: { kind: "lifecycle", ids: [w.patient] },
    why: "the delete's exclusive patient lock queues behind the finalise's shared one",
  });
  expectOk(o1, "finalise");
  expectRefused(o2, "P0059", null, "delete_patient after the finalise");
  eq("the patient is active", (await monitor.query("select deleted_at is null as a from public.patients where id = $1", [w.patient])).rows[0]!.a, true);
  eq("finalised", (await resState(w.result)).finalised, true);
});

// concurrency-proof: result_save_draft
// D1 - draft vs draft: serialised on the results row, nothing lost.
S("D1", "result_save_draft: draft vs draft - serialised, no lost parameter", async () => {
  const w = await mkDraftWorld(2, [0]);
  const { o1, o2 } = await forced({
    first: (a) => saveDraft(a, w.result, vals([0, 1], 10)),
    second: (b) => saveDraft(b, w.result, vals([1, 2], 50)),
    wait: { kind: "row", rel: "results" },
    why: "the second draft queues on the results row the first locked FOR UPDATE",
  });
  expectOk(o1, "first draft");
  expectOk(o2, "second draft");
  eq("every parameter kept, the later save wins the shared one", (await resState(w.result)).values, { p0: 10, p1: 51, p2: 52 });
});

// D3 - drafts that upsert the SAME two parameters in OPPOSITE orders, while holders pin both value rows. Serialised by the
//      results row, the second never starts upserting until the first is done; without it each would hold one parameter
//      and wait for the other (40P01).
S("D3", "result_save_draft: opposite-order upserts vs row holders - serialised, no 40P01", async () => {
  const w = await mkDraftWorld(2, [0, 1]);
  const [h1, h2, a, b] = [await actor("holder-p0"), await actor("holder-p1"), await actor("draft-A"), await actor("draft-B")];
  for (const [h, i] of [[h1, 0], [h2, 1]] as const) {
    await begin(h, "raw");
    await h.c.query("select 1 from public.result_values where result_id = $1 and parameter_id = $2 for update", [w.result, fx.params[i]]);
  }
  await begin(a);
  const pa = andEnd(a, saveDraft(a, w.result, vals([0, 1], 10)));
  await mustWait(a, { kind: "row", rel: "result_values" }, "draft A upserts p0 first and queues on the value row holder-p0 pins");
  await begin(b);
  const pb = andEnd(b, saveDraft(b, w.result, vals([1, 0], 50)));
  let serialised = true;
  let note = "";
  try {
    await mustWait(b, { kind: "row", rel: "results" }, "draft B queues on the results row A holds, before upserting anything");
  } catch (e) {
    serialised = false;
    note = (e as Error).message;
  }
  await end(h1, { ok: true, rows: [], rowCount: 0 });
  if (serialised) await sleep(150);
  await end(h2, { ok: true, rows: [], rowCount: 0 });
  const [oa, ob] = await bothAnswer(["draft A", "draft B"], pa, pb);
  const dead = victims(["draft A", "draft B"], [oa, ob]);
  expect(dead.length === 0, `40P01 victim ${dead.join(", ")} (each draft held one parameter and wanted the other) - ${fmt(oa)} | ${fmt(ob)}`);
  expect(serialised, `not serialised: ${note}`);
  expectOk(oa, "draft A");
  expectOk(ob, "draft B");
  eq("B ran last", (await resState(w.result)).values, valMap([0, 1], 50));
});

// D4 - draft vs a link insert (the exclusive membership lock), both orders.
S("D4", "result_save_draft: draft vs a link insert on the same result - the membership lock orders them", async () => {
  const w1 = await mkDraftWorld(3);
  const t1 = w1.lines.find((l) => !w1.lines.slice(0, 2).includes(l))!;
  const a = await forced({
    first: (x) => addLink(x, w1.result, t1),
    firstAs: "raw",
    second: (y) => saveDraft(y, w1.result, vals([0, 1, 2], 30)),
    wait: { kind: "membership", ids: [w1.result] },
    why: "the draft's shared membership lock queues behind the link insert's exclusive one",
  });
  expectOk(a.o1, "link insert");
  expectOk(a.o2, "draft after the link insert");
  eq("link-first: the draft landed", (await resState(w1.result)).values, valMap([0, 1, 2], 30));
  const w2 = await mkDraftWorld(3);
  const t2 = w2.lines.find((l) => !w2.lines.slice(0, 2).includes(l))!;
  const b = await forced({
    first: (x) => saveDraft(x, w2.result, vals([0, 1, 2], 30)),
    second: (y) => addLink(y, w2.result, t2),
    secondAs: "raw",
    wait: { kind: "membership", ids: [w2.result] },
    why: "the link insert's exclusive membership lock queues behind the draft's shared one",
  });
  expectOk(b.o1, "draft");
  expectOk(b.o2, "link insert after the draft");
  eq("draft-first: three links", await linkCount(w2.lines), 3);
});

// D5 - draft vs a visit moved to another patient: P0072.
S("D5", "result_save_draft: draft vs a visit moved to another patient - P0072 (the post-lock patient re-check)", async () => {
  const w = await mkDraftWorld();
  const other = await mkPatient();
  const { o1, o2 } = await forced({
    first: (a) => reassignVisit(a, w.visit, other),
    firstAs: "raw",
    second: (b) => saveDraft(b, w.result, vals([2], 70)),
    wait: { kind: "lifecycle", ids: [w.patient] },
    why: "the visit move holds both patients exclusively",
  });
  expectOk(o1, "visit move");
  expectRefused(o2, "P0072", /changed while it was being saved/, "draft");
  eq("the draft did not land", (await resState(w.result)).values, valMap([0, 1], 1));
});

// D6 - free race: a finalise and a draft of one result, ROUNDS times. Whatever the order, the committed values are the
//      finalise's complete set, and a draft that ran after it was refused.
S("D6", `result_save_draft: free race of a finalise and a draft x ${ROUNDS} rounds`, async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const w = await mkDraftWorld();
    const [fa, da] = await Promise.all([actor("finalise"), actor("draft")]);
    const [of, od] = await Promise.all([
      (async () => (await begin(fa), andEnd(fa, finalise(fa, w.result, vals([0, 1], 10), `d6-${i}`))))(),
      (async () => (await begin(da), andEnd(da, saveDraft(da, w.result, vals([1, 3], 90)))))(),
    ]);
    expectOk(of, `round ${i} finalise`);
    if (!od.ok) expectRefused(od, "P0066", /already finalised/, `round ${i} draft`);
    const st = await resState(w.result);
    eq(`round ${i}: finalised`, st.finalised, true);
    eq(`round ${i}: the committed values are the finalise's set`, st.values, valMap([0, 1], 10));
    await closeAll();
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
interface Res {
  id: string;
  status: "pass" | "fail" | "infra" | "known" | "fixed";
  msg: string;
}
async function runScenarios(ids: string[] | null, quiet = false): Promise<Record<string, Res>> {
  const out: Record<string, Res> = {};
  for (const s of scenarios) {
    if (aborting) break;
    if (ids && !ids.includes(s.id)) continue;
    if (!ids && ONLY && !ONLY.includes(s.id)) continue;
    let r: Res;
    try {
      const note = (await s.run()) ?? "";
      r = s.known
        ? { id: s.id, status: "fixed", msg: "NOT reproduced - promote this scenario to an asserted one" }
        : { id: s.id, status: "pass", msg: String(note) };
      if (s.known && note) r = { id: s.id, status: "known", msg: String(note) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r = { id: s.id, status: e instanceof Fail ? "fail" : "infra", msg: e instanceof Fail ? msg : `INFRA: ${msg}` };
    }
    out[s.id] = r;
    if (!quiet) {
      const tag = r.status === "pass" ? "ok   " : r.status === "known" ? "KNOWN" : r.status === "fixed" ? "FIXED" : "FAIL ";
      console.log(`  ${tag} ${s.id} ${s.title}${r.msg ? ` - ${r.msg}` : ""}`);
    }
    await closeAll();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function sweep(c: Client = monitor): Promise<void> {
  await c.query("begin");
  try {
    // Local only, this transaction only: replica mode skips the guard triggers (a merged / deleted patient's
    // rows would otherwise refuse their own delete with P0058) and the FK checks, so every referencing table
    // is cleared explicitly, children first.
    await c.query("set local session_replication_role = replica");
    const stmts = [
      `create temp table rlc_staff on commit drop as select id from auth.users where email like 'rlc-%@example.test'`,
      `create temp table rlc_pat on commit drop as select id from public.patients where drm_id like 'DRM-RLC-%'`,
      `create temp table rlc_visits on commit drop as select id from public.visits where visit_number like 'V-RLC-%' or patient_id in (select id from rlc_pat)`,
      `create temp table rlc_tr on commit drop as select id from public.test_requests where visit_id in (select id from rlc_visits)`,
      `create temp table rlc_res on commit drop as
         select id from public.results where uploaded_by in (select id from rlc_staff)
         union select result_id from public.result_test_requests where test_request_id in (select id from rlc_tr)`,
      `create temp table rlc_je on commit drop as
         select id from public.journal_entries where created_by in (select id from rlc_staff)
            or (source_kind = 'test_request' and source_id in (select id from rlc_tr))`,
      `delete from public.journal_lines where entry_id in (select id from rlc_je)`,
      `delete from public.journal_entries where id in (select id from rlc_je)`,
      `delete from public.critical_alerts where result_id in (select id from rlc_res) or patient_id in (select id from rlc_pat)`,
      `delete from public.result_amendments where result_id in (select id from rlc_res)`,
      `delete from public.result_values where result_id in (select id from rlc_res)`,
      `delete from public.result_test_requests where result_id in (select id from rlc_res) or test_request_id in (select id from rlc_tr)`,
      `delete from public.results where id in (select id from rlc_res)`,
      `delete from public.release_notices where visit_id in (select id from rlc_visits)`,
      `delete from public.audit_log where actor_id in (select id from rlc_staff) or patient_id in (select id from rlc_pat)
          or resource_id in (select id from rlc_tr) or resource_id in (select id from rlc_visits) or resource_id in (select id from rlc_pat)`,
      `delete from public.test_requests where id in (select id from rlc_tr)`,
      `delete from public.visits where id in (select id from rlc_visits)`,
      `delete from public.patient_merges where keep_id in (select id from rlc_pat) or source_id in (select id from rlc_pat)`,
      `delete from public.patients where id in (select id from rlc_pat)`,
      `delete from public.result_template_params where template_id in (select id from public.result_templates where header_notes like 'rlc-%')`,
      `delete from public.result_templates where header_notes like 'rlc-%'`,
      `delete from public.services where code like 'RLC-%'`,
      `delete from public.staff_profiles where id in (select id from rlc_staff)`,
      `delete from auth.users where id in (select id from rlc_staff)`,
    ];
    for (const sql of stmts) await c.query(sql);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}
async function leftovers(c: Client = monitor): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    `select (select count(*) from auth.users where email like 'rlc-%@example.test')
          + (select count(*) from public.staff_profiles where full_name like 'rlc-%')
          + (select count(*) from public.services where code like 'RLC-%')
          + (select count(*) from public.result_templates where header_notes like 'rlc-%')
          + (select count(*) from public.patients where drm_id like 'DRM-RLC-%')
          + (select count(*) from public.visits where visit_number like 'V-RLC-%')
          + (select count(*) from public.results where notes like 'rlc-%')
          + (select count(*) from pg_namespace where nspname like 'rlc_ctl_%') as n`,
  );
  return Number(rows[0]!.n);
}
async function dropCtlSchemas(c: Client = monitor): Promise<void> {
  const { rows } = await c.query<{ n: string }>("select nspname as n from pg_namespace where nspname ~ '^rlc_ctl_[0-9a-f]{6}$'");
  for (const { n } of rows) await c.query(`drop schema ${n} cascade`);
}

// The results UPDATE trigger (trg_results_advance_test) is the one object a control round touches outside its own schema: MT1 points it at a
// mutant copy for the round. It is always pointed back before the copy's schema is dropped (DROP SCHEMA ... CASCADE would otherwise take the
// trigger with it), and every entry point (start, finish, abort) heals it first, so a killed run can never leave the shared stack with a
// mutant or a missing trigger.
const TRIGGER_NAME = "trg_results_advance_test";
async function pointTrigger(c: Client, schema: string): Promise<void> {
  await c.query(`drop trigger if exists ${TRIGGER_NAME} on public.results`);
  await c.query(`create trigger ${TRIGGER_NAME} after update on public.results for each row execute function ${schema}.advance_test_on_result_upload()`);
}
/** Returns true when the trigger had to be repaired (missing, or pointing at a function that is not public's). */
async function healTrigger(c: Client = monitor): Promise<boolean> {
  const { rows } = await c.query<{ ok: boolean }>(
    `select exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
                     where t.tgrelid = 'public.results'::regclass and t.tgname = $1 and not t.tgisinternal
                       and n.nspname = 'public' and p.proname = 'advance_test_on_result_upload') as ok`,
    [TRIGGER_NAME],
  );
  if (rows[0]!.ok) return false;
  await pointTrigger(c, "public");
  return true;
}

async function abortCleanup(sig: string): Promise<void> {
  aborting = true;
  console.log(`\n  ${sig} received - tearing down`);
  const cleaner = new Client({ connectionString: DB_URL });
  await cleaner.connect();
  await cleaner.query("select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and application_name = $1", [APP_NAME]);
  await sleep(300);
  await healTrigger(cleaner); // before the schemas go: the CASCADE would drop a swapped trigger
  await dropCtlSchemas(cleaner);
  await healTrigger(cleaner);
  await sweep(cleaner);
  const left = await leftovers(cleaner);
  console.log(left > 0 ? `  FAIL     teardown - ${left} tagged rows left behind` : "  teardown: every tagged row removed");
  await cleaner.end();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  monitor = await newClient();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('result-lifecycle:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("[result-lifecycle:concurrency-proof] another run is in progress on this stack - try again when it finishes.");
    process.exit(3);
  }
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      abortCleanup(sig)
        .catch((e) => console.error(e))
        .finally(() => process.exit(code));
    });
  }
  let exit = 0;
  let seeded = false;
  try {
    await healTrigger();
    await dropCtlSchemas();
    if (await healTrigger()) console.log("  note: trg_results_advance_test was missing or mutated (a previous run was killed); repaired");
    await sweep();
    KEY = {
      membership: Number((await monitor.query<{ k: string }>("select (hashtext('result_membership'))::oid::bigint as k")).rows[0]!.k),
      lifecycle: Number((await monitor.query<{ k: string }>("select (hashtext('patient_lifecycle'))::oid::bigint as k")).rows[0]!.k),
    };
    console.log(`Server: ${(await monitor.query<{ v: string }>("select version() as v")).rows[0]!.v}`);
    console.log(`result-lifecycle proof - fixtures tagged ${TAG}, ${ROUNDS} free-race rounds`);
    await seed();
    seeded = true;
    const real = await runScenarios(null);
    const asserted = Object.values(real).filter((r) => r.status !== "known" && r.status !== "fixed");
    const failed = Object.values(real).filter((r) => r.status === "fail" || r.status === "infra");
    const known = Object.values(real).filter((r) => r.status === "known");
    const fixed = Object.values(real).filter((r) => r.status === "fixed");
    console.log(`${asserted.length - failed.length}/${asserted.length} scenarios passed; ${known.length} known issue(s) reproduced.`);
    if (failed.length > 0 || fixed.length > 0) exit = 1;
    if (CONTROL && !aborting) {
      const ok = await controlRounds();
      if (!ok) exit = 1;
    }
  } finally {
    if (aborting) await sleep(60000); // the signal handler is cleaning up and will exit
    await closeAll();
    if (await healTrigger().catch(() => false)) {
      console.log("FAIL: trg_results_advance_test was left pointing at a mutant (or missing) after the run - repaired");
      exit = 1;
    }
    await dropCtlSchemas().catch(() => undefined);
    if (await healTrigger().catch(() => false)) console.log("note: trg_results_advance_test repaired after the schema drop");
    if (seeded || (await leftovers().catch(() => 1)) > 0) await sweep().catch((e) => console.error(`cleanup failed: ${(e as Error).message}`));
    const left = await leftovers().catch(() => -1);
    if (left !== 0) {
      console.log(`FAIL: ${left} tagged rows left behind`);
      exit = 1;
    } else console.log("teardown: every tagged row removed");
    await monitor.query("select pg_advisory_unlock(hashtext('result-lifecycle:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

// ---------------------------------------------------------------------------
// Control rounds: mutants
// ---------------------------------------------------------------------------
const SIGS: Record<keyof typeof FN, string> = {
  lockResults: "public.lifecycle_lock_results(uuid[], boolean)",
  create: "public.result_create_linked(uuid, uuid[], text, uuid, text, integer, text)",
  finalise: "public.result_finalise_commit(uuid, uuid, jsonb, text, integer, timestamp with time zone, jsonb, jsonb)",
  draft: "public.result_save_draft(uuid, jsonb)",
  advance: "public.advance_test_on_result_upload()",
};
const RESULT_ROW_LOCK = "   where id = p_result_id\n   for update;";
const PATIENT_RECHECK_RESULT =
  "  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))\n       is distinct from v_patients then";
interface Mutant {
  id: string;
  fn: keyof typeof FN;
  what: string;
  /** [from, to, expected occurrences (default 1)] - the live text must contain `from` exactly that often, or the mutant is stale. */
  edits: Array<[string, string] | [string, string, number]>;
  /** scenarios that must FAIL (guard failure) against the mutant */
  mustFail: string[];
  /** The failure each mustFail scenario must show: the OUTCOME (or lock position) the removed guard protects. A failure that does not
   *  match it is never a catch. */
  reason: RegExp;
}
/** Failures that say nothing about the guard: a statement timeout, a wait that never ended, a fixture / setup error, an interleaving
 *  whose FIRST caller did not answer ok, a terminated backend. A mutant is never "caught" by one of these, whatever its reason says. */
const INFRA_RE =
  /statement timeout|canceling statement|57014|neither .* nor .* finished|neither answered nor queued|Connection terminated|terminating connection|^INFRA:|fixture:|setup call failed|\[first answered: (?!ok)/;
// A lock-removal mutant is caught by WHERE the second caller queued - the scenario asserts the wait on the lock the mutant no longer
// takes. Its reason therefore names that lock AND what the caller did instead (answered at once with the first caller ok, or queued
// on a different lock: "saw transactionid" / "saw advisory lifecycle key"); a bare "saw no lock wait" is not enough.
const MUTANTS: Mutant[] = [
  // lifecycle_lock_results
  {
    id: "ML1",
    fn: "lockResults",
    what: "ignores p_exclusive (always shared)",
    edits: [["    if p_exclusive then", "    if false then"]],
    mustFail: ["K1", "K2"],
    reason: /second answered without waiting on the membership advisory lock[\s\S]*\[first answered: ok; second answered: ok\]/,
  },
  {
    id: "ML2",
    fn: "lockResults",
    what: "keys the lock under the patient lifecycle class instead of 'result_membership'",
    // both branches of the function (shared and exclusive) key the lock with the literal
    edits: [["hashtext('result_membership')", "hashtext('patient_lifecycle')", 2]],
    mustFail: ["K1", "K4"],
    reason: /second never waited on the membership advisory lock[\s\S]*; saw advisory lifecycle key \d+|blocked on advisory lifecycle key \d+ but should have answered at once/,
  },
  {
    id: "ML3",
    fn: "lockResults",
    what: "takes the keys in the CALLER's array order (no sort)",
    edits: [
      [
        "    select distinct hashtext(x::text) as k\n      from unnest(coalesce(p_result_ids, '{}'::uuid[])) x\n     where x is not null\n     order by k",
        "    select hashtext(t.x::text) as k\n      from unnest(coalesce(p_result_ids, '{}'::uuid[])) with ordinality t(x, o)\n     where t.x is not null\n     order by t.o",
      ],
    ],
    mustFail: ["K5"],
    reason: /lock-order cycle \(caller B took the higher key first: true\): [\s\S]*40P01 deadlock detected/, // either caller can be the victim
  },
  // result_create_linked
  {
    id: "MC1",
    fn: "create",
    what: "no lines FOR UPDATE (the unique link index is all that is left)",
    edits: [["  perform 1 from public.test_requests tr where tr.id = any(v_ids) order by tr.id for update;", "  null;"]],
    mustFail: ["C1", "C2"],
    reason: /second never waited on a row of test_requests[\s\S]*; saw transactionid/,
  },
  {
    id: "MC2",
    fn: "create",
    what: "no explicit patient lock BEFORE the lines (the link-insert trigger locks it later)",
    edits: [["  perform public.lifecycle_lock_and_assert(v_patients, false);", "  null;"]],
    mustFail: ["C8"],
    // without the explicit patient lock the create now runs on to the visit row (0223) - which the scenario's visit holder pins - and queues THERE: "saw tuple/transactionid", not the lifecycle lock; before 0223 it ran on to the lines and held one
    reason: /already holds the test row while it is queued on the patient lock|creator never waited on the lifecycle advisory lock[\s\S]*; saw (tuple|transactionid)/,
  },
  {
    id: "MC3",
    fn: "create",
    what: "no live-line recount after the line locks",
    edits: [["  if v_live <> cardinality(v_ids) then", "  if false then"]],
    mustFail: ["C3"],
    reason: /create after delete: expected P0066, but it succeeded/,
  },
  {
    id: "MC4",
    fn: "create",
    what: "no post-lock patient re-check (P0072)",
    edits: [
      [
        "  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_test_requests(v_ids), null))\n       is distinct from v_patients then",
        "  if false then",
      ],
    ],
    mustFail: ["C7"],
    reason: /create: expected P0072, but it succeeded/,
  },
  {
    id: "MC5",
    fn: "create",
    what: "no 'already has a result' check (P0066) after the line locks",
    edits: [["  if exists (select 1 from public.result_test_requests rtr where rtr.test_request_id = any(v_ids)) then", "  if false then"]],
    mustFail: ["C1"],
    reason: /second create: expected P0066, got 23505 duplicate key value violates unique constraint/,
  },
  {
    id: "MC6",
    fn: "create",
    what: "lines locked in plan order, not id order (no ORDER BY id)",
    edits: [["where tr.id = any(v_ids) order by tr.id for update;", "where tr.id = any(v_ids) for update;"]],
    mustFail: ["C9"],
    reason: /lock-order cycle: 40P01 victim (unclaim|create|unclaim, create) - [\s\S]*40P01 deadlock detected/, // either side can be the victim
  },
  {
    id: "MC7",
    fn: "create",
    what: "no visit FOR SHARE before the lines (0223)",
    edits: [["  perform 1 from public.visits v where v.id = any(v_visits) order by v.id for share; -- 0223", "  null;"]],
    mustFail: ["C4"],
    reason: /second answered without waiting on a row of visits[\s\S]*\[first answered: ok; second answered: ok\]/,
  },
  // result_finalise_commit
  {
    id: "MF1",
    fn: "finalise",
    what: "no results-row FOR UPDATE",
    edits: [[RESULT_ROW_LOCK, "   where id = p_result_id;"]],
    mustFail: ["F1"],
    reason: /second never waited on a row of results[\s\S]*; saw transactionid/,
  },
  {
    id: "MF2",
    fn: "finalise",
    what: "no finalised_at re-check after the row lock",
    edits: [["  if v_result.finalised_at is not null then", "  if false then"]],
    mustFail: ["F1"],
    reason: /second finalise: P0066 message was .*expected \/already finalised\//,
  },
  {
    id: "MF3",
    fn: "finalise",
    what: "no result-membership lock",
    edits: [["  perform public.lifecycle_lock_results(array[p_result_id], false);", "  null;"]],
    mustFail: ["F5"],
    reason: /second never waited on the membership advisory lock[\s\S]*; saw transactionid/,
  },
  {
    id: "MF4",
    fn: "finalise",
    what: "no post-lock patient re-check (P0072)",
    edits: [[PATIENT_RECHECK_RESULT, "  if false then"]],
    mustFail: ["F9"],
    reason: /finalise: expected P0072, but it succeeded/,
  },
  // 0223: result_finalise_commit's visit + line locks, one at a time and together
  {
    id: "MF5",
    fn: "finalise",
    what: "neither the visit FOR SHARE nor the lines FOR NO KEY UPDATE (the pre-0223 body)",
    edits: [
      ["  perform 1 from public.visits v where v.id = any(v_visits) order by v.id for share; -- 0223", "  null;"],
      ["  perform 1 from public.test_requests tr where tr.id = any(v_lines) order by tr.id for no key update; -- 0223", "  null;"],
    ],
    mustFail: ["F6a", "F8b"],
    reason: /finalise after the unclaim: expected P0066, but it succeeded|second never waited on a row of visits[\s\S]*; saw transactionid/,
  },
  {
    id: "MF6",
    fn: "finalise",
    what: "no visit FOR SHARE (the lines are still locked)",
    edits: [["  perform 1 from public.visits v where v.id = any(v_visits) order by v.id for share; -- 0223", "  null;"]],
    mustFail: ["F8b", "F11"],
    reason: /second never waited on a row of visits[\s\S]*; saw transactionid|second answered without waiting on a row of visits[\s\S]*\[first answered: ok; second answered: ok\]/,
  },
  {
    id: "MF7",
    fn: "finalise",
    what: "no lines FOR NO KEY UPDATE (the visit is still locked)",
    edits: [["  perform 1 from public.test_requests tr where tr.id = any(v_lines) order by tr.id for no key update; -- 0223", "  null;"]],
    mustFail: ["F6a"],
    reason: /finalise after the unclaim: expected P0066, but it succeeded/,
  },
  {
    id: "MF8",
    fn: "finalise",
    what: "lines locked in plan order, not id order (no ORDER BY)",
    edits: [["  perform 1 from public.test_requests tr where tr.id = any(v_lines) order by tr.id for no key update; -- 0223", "  perform 1 from public.test_requests tr where tr.id = any(v_lines) for no key update; -- 0223"]],
    mustFail: ["F6d"],
    reason: /lock-order cycle: 40P01 victim (release|finalise|release, finalise) [\s\S]*40P01 deadlock detected/, // either side can be the victim
  },
  // advance_test_on_result_upload (swapped in as the results trigger for the round)
  {
    id: "MT1",
    fn: "advance",
    what: "the flip UPDATE without its status guard (the pre-0223 body)",
    edits: [["\n      and status = 'in_progress'; -- 0223: a line handed back / moved on while this UPDATE waited for its lock is left alone", ";"]],
    mustFail: ["F6g"],
    reason: /the lines stay handed back to 'requested' - the late flip skipped them: got \["ready_for_release","requested"\]|got \["requested","ready_for_release"\]/,
  },
  // result_save_draft
  {
    id: "MD1",
    fn: "draft",
    what: "no results-row FOR UPDATE",
    edits: [[RESULT_ROW_LOCK, "   where id = p_result_id;"]],
    mustFail: ["F2", "D3", "D1"],
    reason: /second never waited on a row of results[\s\S]*; saw transactionid|40P01 victim draft [AB] \(each draft held one parameter and wanted the other\)/,
  },
  {
    id: "MD2",
    fn: "draft",
    what: "no finalised_at refusal (a draft may overwrite a finalised result)",
    edits: [["  if v_result.generation_kind <> 'structured' or v_result.finalised_at is not null then", "  if v_result.generation_kind <> 'structured' then"]],
    mustFail: ["F2"],
    reason: /draft after finalise: expected P0066, but it succeeded/,
  },
  {
    id: "MD3",
    fn: "draft",
    what: "no result-membership lock",
    edits: [["  perform public.lifecycle_lock_results(array[p_result_id], false);", "  null;"]],
    mustFail: ["D4"],
    reason: /second never waited on the membership advisory lock[\s\S]*; saw transactionid/,
  },
  {
    id: "MD4",
    fn: "draft",
    what: "no post-lock patient re-check (P0072)",
    edits: [[PATIENT_RECHECK_RESULT, "  if false then"]],
    mustFail: ["D5"],
    reason: /draft: expected P0072, but it succeeded/,
  },
];

async function installCopies(schema: string, m: Mutant | null): Promise<void> {
  await monitor.query(`create schema ${schema}`);
  await monitor.query(`grant usage on schema ${schema} to service_role`);
  for (const [key, sig] of Object.entries(SIGS) as Array<[keyof typeof FN, string]>) {
    let def = (await monitor.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [sig])).rows[0]!.d;
    if (m && m.fn === key) {
      for (const [from, to, want = 1] of m.edits) {
        const hits = def.split(from).length - 1;
        if (hits !== want) throw new Error(`mutant ${m.id}: the live ${key} contains «${from.split("\n")[0]}» ${hits} time(s) (want exactly ${want}) - update MUTANTS`);
        // function replacer (no `$&` patterns in `to`), each of the `want` verified occurrences once, left to right
        let at = 0;
        for (let k = 0; k < want; k++) {
          const i = def.indexOf(from, at);
          def = def.slice(0, i) + to + def.slice(i + from.length);
          at = i + to.length;
        }
      }
    }
    const name = sig.slice(sig.indexOf(".") + 1, sig.indexOf("("));
    if (!def.includes(`public.${name}(`)) throw new Error(`${name}: definition header not found`);
    await monitor.query(def.replace(`public.${name}(`, `${schema}.${name}(`));
    await monitor.query(`grant execute on function ${schema}.${sig.slice(sig.indexOf(".") + 1)} to service_role`);
  }
  if (m && m.fn === "advance") await pointTrigger(monitor, schema); // MT1: the mutant IS the trigger for this round
}

async function controlRounds(): Promise<boolean> {
  console.log("\ncontrol rounds (a mutant is a copy of ONE live function with ONE guard removed; its scenarios must FAIL for a guard reason):");
  let allOk = true;
  const rounds: Array<{ id: string; what: string; m: Mutant | null; list: string[] }> = [
    { id: "B0", what: "unmutated copies of all four functions", m: null, list: [...new Set(MUTANTS.flatMap((x) => x.mustFail))] },
    ...MUTANTS.map((m) => ({ id: m.id, what: `${m.fn}: ${m.what}`, m, list: m.mustFail })),
  ].filter((r) => !CTL_ONLY || CTL_ONLY.includes(r.id));
  for (const r of rounds) {
    if (aborting) break;
    const schema = `rlc_ctl_${randomBytes(3).toString("hex")}`;
    round.n += 1;
    try {
      await installCopies(schema, r.m);
      for (const k of Object.keys(FN) as Array<keyof typeof FN>) FN[k] = schema;
      const res = await runScenarios(r.list, true);
      if (aborting) break;
      if (!r.m) {
        const bad = r.list.filter((id) => res[id]?.status !== "pass");
        if (bad.length > 0) {
          allOk = false;
          console.log(`  FAIL  B0 baseline: ${bad.map((id) => `${id} (${res[id]?.msg.slice(0, 160) ?? "not run"})`).join("; ")}`);
        } else console.log(`  PASS  B0 baseline: ${r.list.length}/${r.list.length} scenarios pass against the unmutated copies`);
        continue;
      }
      const survived = r.m.mustFail.filter((id) => res[id]?.status === "pass" || res[id]?.status === "known" || res[id]?.status === "fixed");
      const infra = r.m.mustFail.filter((id) => !res[id] || res[id]!.status === "infra" || (res[id]!.status === "fail" && INFRA_RE.test(res[id]!.msg)));
      const wrong = r.m.mustFail.filter((id) => res[id]?.status === "fail" && !INFRA_RE.test(res[id]!.msg) && !r.m!.reason.test(res[id]!.msg));
      if (survived.length || infra.length || wrong.length) {
        allOk = false;
        console.log(
          `  FAIL  ${r.id} (${r.what}): ${survived.length ? `SURVIVED (passed): ${survived.join(",")}. ` : ""}${infra.length ? `not a guard failure: ${infra.map((id) => `${id} ${res[id]?.msg.slice(0, 160) ?? "not run"}`).join("; ")}. ` : ""}${wrong.length ? `failed for the wrong reason (wanted ${r.m.reason}): ${wrong.map((id) => `${id} ${res[id]!.msg.slice(0, 160)}`).join("; ")}` : ""}`,
        );
      } else {
        console.log(`  PASS  ${r.id} (${r.what}): caught by ${r.m.mustFail.join(", ")}`);
        for (const id of r.m.mustFail) console.log(`        ${id}: ${res[id]!.msg.slice(0, 190)}`);
      }
    } finally {
      for (const k of Object.keys(FN) as Array<keyof typeof FN>) FN[k] = "public";
      await closeAll();
      await healTrigger().catch((e) => console.error(`trigger repair failed: ${(e as Error).message}`)); // BEFORE the drop: the CASCADE would take a swapped trigger
      await monitor.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
    }
  }
  return allOk;
}

main().catch(async (e) => {
  if (aborting) await sleep(60000);
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
