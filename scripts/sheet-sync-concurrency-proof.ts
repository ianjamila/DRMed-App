// Hand-run local CONCURRENCY proof for the Sheet Sync write functions
// (supabase/migrations/0170_sheet_sync_foundation.sql, 0193_sync_review_gaps.sql,
// 0204_sheet_links_clear_held_patient.sql):
//   _sheet_sync_fence, sheet_sync_acquire, sheet_sync_upsert_review,
//   sheet_sync_release_undo, sheet_resort_apply, sheet_alias_apply,
//   sheet_sync_apply_customer_ops, sheet_sync_revert_run.
//
// scripts/sheet-sync-db-proof.ts proves leases, fences, fills and reverts one
// statement after another in ONE rolled-back transaction, so it can never prove
// a race: a transaction does not wait on itself. This runner uses separate `pg`
// connections acting as service_role (the role the sync's admin client uses).
//
// WHAT CAN RACE. Every write function opens with _sheet_sync_fence, which takes
// FOR UPDATE on the single `running` sheet_sync_runs row of its lease token. So
// two calls under ONE lease (a chunk retried after a lost response, a second
// admin click) queue on that row; two leases can only meet at acquire (advisory
// lock + the running row) or through a takeover of a stale lease, where the old
// worker's queued write must be refused. The only truly concurrent writers are
// the app's own: a staff edit, delete_patient, merge_patients_guarded.
//
// DETERMINISTIC, NOT LUCKY. Each forced scenario holds one side in an open
// transaction, starts the other, and does not go on until pg_locks /
// pg_blocking_pids shows that exact backend queued behind that exact holder on
// the expected lock (an advisory lock, or a row lock on a named table). A
// scenario that cannot reach its interleaving FAILS; it never degrades into a
// sequential run. Only L5 (a free race) relies on timing, and only asserts the
// invariant. Racers end their own transaction the moment their own call answers.
// Deadlocks are never tolerated: no 40P01 on either side, whoever the victim.
//
// Proves (scenario ids; each is annotated where it is defined):
//   L1 acquire x acquire on an empty slot, L2 stale takeover x acquire, L3 acquire
//   x a live holder's in-flight write, L4 paused cron acquire never waits,
//   L5 free race of 5 acquirers (exactly one lease)
//   F1 an old token queued behind a takeover is refused, F1b the same when the
//   takeover rolls back (stale heartbeat), F3 a write queued behind finish
//   U1 two upserts of one review item -> one open row
//   R1 release replay releases the holds once
//   RS1 resort replay, RS2 resort x staff edit (no lost update)
//   AL1 alias replay (P0064), AL2 alias x staff edit (no lost update)
//   A1 chunk replay (no duplicate patient), A2 fill x staff edit (stale), A3 fill
//   x delete_patient (stale, chunk intact), A5 chunk queued behind a takeover
//   (nothing applied), A6 a revert-acquire x an in-flight chunk (chunk whole)
//   V1 revert x staff edit (no lost update), V2 paged revert replay, V3 revert of
//   a created patient x delete_patient, D2 revert x merge (lock order, no 40P01)
//   KNOWN (reported, not asserted): A4 link x delete_patient (link written to a
//   just-deleted patient), D1 apply chunk x merge (40P01 lock-order cycle).
//
// FIXTURES are committed (two connections cannot see each other's uncommitted
// rows), tagged SscProof<hex> / sscproof<hex>, reached through a throwaway admin
// user (every run this proof creates carries it as actor_id), swept at start
// and deleted in a memoised cleanup (success, failure, SIGINT, SIGTERM), then
// counted. Never touches Bsqfixture rows. One run at a time (advisory lock).
//
// Run (local stack, 0170 + 0193 + 0204 applied):
//   npm run sheet-sync:concurrency-proof [-- --control]
//   SSC_ROUNDS=30 npm run sheet-sync:concurrency-proof
//
// --control proves the proof can fail: for each mutant it builds a scratch-schema
// copy of the live function(s) with ONE guard removed (exact-text replace that
// THROWS when the text drifted), routes ONLY the function under test to it, and
// passes only when the named scenarios FAIL. Fence mutants copy
// sheet_resort_apply and sheet_sync_apply_customer_ops too, rewired to the
// mutant fence. Not covered by a mutant: the unlocked link/facts reads (A4 is a
// reported bug), _sheet_sync_fence's dry-run refusal (db-proof M2), and the
// release_undo paging/admin-hold rules (db-proof M16/M18, sequential rules).
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";

requireLocalOrExplicitProd("sheet-sync:concurrency-proof", {
  writes:
    "throwaway staff, patients, sheet-sync runs / links / review items / aliases / customer rows tagged SscProof, committed so two connections can race on them, then deleted; --control also creates and drops scratch schemas sscproof_ctl_*",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// COMMITS rows: never against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[sheet-sync:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const HEX = randomBytes(3).toString("hex");
const TAG = `SscProof${HEX}`;
const TAGL = TAG.toLowerCase();
const TAGU = TAG.toUpperCase();
const ADMIN = randomUUID();
const ROUNDS = Number(process.env.SSC_ROUNDS ?? 10);
const CONTROL = process.argv.includes("--control");

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------
class Fail extends Error {}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Fail(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
type Out = { ok: true; rows: Row[] } | { ok: false; code: string; msg: string };
interface Actor {
  name: string;
  c: Client;
  pid: number;
}

let monitor: Client;
let aborting = false;
const actors: Actor[] = [];

/** Function name -> qualified name. Only the mutated functions point at a scratch schema. */
let routed: Record<string, string> = {};
const f = (name: string) => routed[name] ?? `public.${name}`;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await monitor.query(sql, params)).rows;
}

async function newActor(name: string): Promise<Actor> {
  const c = new Client({ connectionString: DB_URL });
  c.on("error", () => undefined);
  await c.connect();
  await c.query("set statement_timeout = '30s'");
  const pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  const a = { name, c, pid };
  actors.push(a);
  return a;
}
async function begin(a: Actor, role: string | null = "service_role"): Promise<void> {
  await a.c.query("begin");
  if (role) await a.c.query(`set local role ${role}`);
}
function run(a: Actor, sql: string, params: unknown[] = []): Promise<Out> {
  return a.c.query(sql, params).then(
    (r): Out => ({ ok: true, rows: r.rows }),
    (e: { code?: string; message?: string }): Out => ({ ok: false, code: e.code ?? "?", msg: e.message ?? String(e) }),
  );
}
async function commit(a: Actor): Promise<void> {
  await a.c.query("commit");
}
/** The way PostgREST ends each RPC: commit on success, roll back on refusal, the moment the call answers. */
function andEnd(a: Actor, p: Promise<Out>): Promise<Out> {
  return p.then(async (o) => {
    try {
      await a.c.query(o.ok ? "commit" : "rollback");
    } catch {
      /* connection already closed by a failing scenario */
    }
    return o;
  });
}
async function endNow(a: Actor, o: Out): Promise<Out> {
  return andEnd(a, Promise.resolve(o));
}
const show = (o: Out) => (o.ok ? JSON.stringify(o.rows[0]?.j ?? o.rows[0] ?? null).slice(0, 200) : `${o.code} ${o.msg.slice(0, 120)}`);
const J = (o: Out): Row => {
  expect(o.ok, `expected the call to succeed, got ${show(o)}`);
  return o.rows[0].j;
};
function refused(o: Out, code: string, label: string): void {
  expect(!o.ok && o.code === code, `${label}: expected ${code}, got ${show(o)}`);
}
function noDeadlock(...outs: Out[]): void {
  for (const o of outs) expect(o.ok || o.code !== "40P01", `deadlock (40P01) detected: ${show(o)}`);
}

/** Cancel whatever is in flight on my backends (so a held lock cannot wedge teardown), then end them. */
async function closeActors(): Promise<void> {
  const mine = actors.splice(0);
  for (const a of mine) await monitor.query("select pg_cancel_backend($1)", [a.pid]).catch(() => undefined);
  for (const a of mine) {
    await a.c.query("rollback").catch(() => undefined);
    await a.c.end().catch(() => undefined);
  }
}

/** `w` is queued behind `h` (pg_blocking_pids) on exactly the lock named: an advisory lock, or a row lock on `relation`. */
async function waitsOn(w: Actor, h: Actor, on: { advisory: true } | { relation: string }, why: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let blockers: number[] = [];
  while (Date.now() < deadline) {
    blockers = (await monitor.query("select unnest(pg_blocking_pids($1)) as p", [w.pid])).rows.map((r) => r.p as number);
    if (blockers.includes(h.pid)) break;
    await sleep(25);
  }
  expect(blockers.includes(h.pid), `interleaving not reached: ${w.name} never queued behind ${h.name} (${why}); blocked by [${blockers.join(",")}]`);
  const { rowCount } =
    "advisory" in on
      ? await monitor.query("select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted", [w.pid])
      : await monitor.query("select 1 from pg_locks where pid = $1 and locktype = 'tuple' and relation = $2::regclass", [w.pid, on.relation]);
  expect(
    rowCount,
    `${w.name} waits behind ${h.name} but not on ${"advisory" in on ? "an advisory lock" : `a row lock on ${on.relation}`} (${why})`,
  );
}
/** `w` is queued behind something (any holder) - used where the holder is not one of my actors. */
async function isBlocked(w: Actor, why: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { rowCount } = await monitor.query("select 1 from pg_locks where pid = $1 and not granted", [w.pid]);
    if (rowCount) return;
    await sleep(25);
  }
  throw new Fail(`interleaving not reached: ${w.name} never blocked (${why})`);
}
/** The call must answer while the other side is still open, never queueing on a lock. */
async function answersAtOnce(a: Actor, p: Promise<Out>, why: string): Promise<Out> {
  let done = false;
  const tracked = p.then((o) => ((done = true), o));
  for (let i = 0; i < 80 && !done; i++) {
    const { rowCount } = await monitor.query("select 1 from pg_locks where pid = $1 and not granted", [a.pid]);
    if (rowCount && !done) throw new Fail(`${a.name} queued on a lock but should have answered at once (${why})`);
    await sleep(50);
  }
  expect(done, `${a.name} did not answer within 4s (${why})`);
  return tracked;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
let SEQ = 0;
let origPaused: boolean | null = null;
let pausedChanged = false;

async function setupAdmin(): Promise<void> {
  await q(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [ADMIN, `${TAGL}-admin@example.test`],
  );
  await q(`insert into public.staff_profiles (id, full_name, role, is_active) values ($1, 'Sheet Sync Proof Admin', 'admin', true)`, [ADMIN]);
}
async function mkPatient(o: { referral?: string | null; phone?: string | null; email?: string | null } = {}): Promise<string> {
  const n = ++SEQ;
  const r = await q(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, phone, email, referral_source, legacy_intake)
     values ($1, 'Proof', $2, '1990-01-01', $3, $4, $5, '{"source":"google_sheet_CUSTOMER_LIST2"}'::jsonb) returning id`,
    [`DRM-${TAGU}${n}`, `${TAG}P${n}`, o.phone ?? null, o.email ?? null, o.referral ?? null],
  );
  return r[0].id as string;
}
const patientRow = async (id: string): Promise<Row> =>
  (await q(`select referral_source, referral_source_origin, email, phone, address, row_version::int as rv, deleted_at, merged_into_id from public.patients where id = $1`, [id]))[0];
const emailOf = (n: string) => `${TAGL}-${n}-${++SEQ}@example.test`;

async function clearRuns(): Promise<void> {
  await q(`update public.sheet_sync_runs set status = 'failed', ended_at = now(), error = 'proof reset' where status = 'running' and actor_id = $1`, [ADMIN]);
  const other = await q(`select id from public.sheet_sync_runs where status = 'running'`);
  if (other.length) throw new Fail(`a sheet sync run that is not this proof's is live on the local DB (${other[0].id}); refusing to touch it`);
}
/** A real lease, acquired through the real function (so the fixture cannot drift from it). */
async function newRun(trigger: "resort" | "alias" | "revert" | "release", o: { ageMin?: number } = {}): Promise<{ token: string; runId: string }> {
  await clearRuns();
  const j = (await q(`select public.sheet_sync_acquire($1, $2, false) as j`, [trigger, ADMIN]))[0].j;
  expect(j.status === "running", `fixture acquire answered ${JSON.stringify(j)}`);
  if (o.ageMin) await q(`update public.sheet_sync_runs set heartbeat_at = now() - make_interval(secs => $2) where id = $1`, [j.run_id, Math.round(o.ageMin * 60)]);
  return { token: j.lease_token as string, runId: j.run_id as string };
}
const endRun = (token: string, status = "succeeded") =>
  q(`update public.sheet_sync_runs set status = $2, ended_at = now() where lease_token = $1`, [token, status]);
async function mkRun(trigger: string, status = "succeeded", extra: { revertedBy?: string } = {}): Promise<string> {
  return (
    await q(
      `insert into public.sheet_sync_runs (trigger, actor_id, status, ended_at, reverted_by_run_id) values ($1, $2, $3, now(), $4) returning id`,
      [trigger, ADMIN, status, extra.revertedBy ?? null],
    )
  )[0].id as string;
}
/** A finished 'resort' run that moved these patients other -> online_google (real resort_apply), ready to be reverted. */
async function resortedRun(patients: string[]): Promise<string> {
  const r = await newRun("resort");
  const n = (await q(`select public.sheet_resort_apply($1, $2::uuid[], 'other', 'online_google') as j`, [r.token, patients]))[0].j;
  expect(n === patients.length, `fixture resort moved ${n} of ${patients.length}`);
  await endRun(r.token);
  return r.runId;
}
const countOf = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);

// ---------------------------------------------------------------------------
// SQL under test (routed to the scratch schema in --control)
// ---------------------------------------------------------------------------
const acquireSql = () => `select ${f("sheet_sync_acquire")}($1::text, $2::uuid, $3::boolean) as j`;
const resortSql = () => `select ${f("sheet_resort_apply")}($1::uuid, $2::uuid[], $3::text, $4::text) as j`;
const aliasSql = () => `select ${f("sheet_alias_apply")}($1::uuid, $2::text, $3::text, $4::uuid, $5::uuid) as j`;
const upsertSql = () => `select ${f("sheet_sync_upsert_review")}($1::uuid, $2::text, $3::jsonb, $4::boolean) as j`;
const releaseSql = () => `select ${f("sheet_sync_release_undo")}($1::uuid, $2::uuid, $3::int) as j`;
const applySql = () => `select ${f("sheet_sync_apply_customer_ops")}($1::uuid, $2::jsonb) as j`;
const revertSql = () => `select ${f("sheet_sync_revert_run")}($1::uuid, $2::uuid, $3::int) as j`;
const finishSql = `select public.sheet_sync_finish($1::uuid, 'succeeded', '{}'::jsonb, '{}'::jsonb, null) as j`;
const heartbeatSql = `select public.sheet_sync_heartbeat($1::uuid) as j`;
const deleteSql = `select public.delete_patient($1::uuid, 'test_record', null, $2::uuid, '{}'::jsonb) as j`;
const mergeSql = `select public.merge_patients_guarded($1::uuid, $2::uuid, $3::uuid, '{"source":"admin"}'::jsonb) as j`;

const fillOp = (patient: string, rv: number, fields: Record<string, unknown>) => ({ op: "fill", patient_id: patient, expected_row_version: rv, fields });
const createOp = (key: string) => ({
  op: "create",
  create_key: key,
  method: "auto_exact",
  link_keys: [`${TAGL}-lk-${key}`],
  fields: { first_name: "Proof", last_name: `${TAG}Cr${key}`, birthdate: "1992-03-04" },
  legacy_intake: { source: "google_sheet_CUSTOMER_LIST2" },
  facts: { registered_on: "2026-05-30", new_repeat: "new", source_ref: "ssc" },
});

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
interface Scenario {
  id: string;
  title: string;
  /** reported, not asserted: resolves to "reproduced" or "not-reproduced" */
  known?: boolean;
  run: () => Promise<void | "reproduced" | "not-reproduced">;
}
const RUNS = "public.sheet_sync_runs";
const PATIENTS = "public.patients";

const scenarios: Scenario[] = [
  // concurrency-proof: sheet_sync_acquire (L1: the loser queues on the lease advisory lock, then is refused P0062)
  {
    id: "L1",
    title: "acquire x acquire on an empty slot: one lease, the other refused P0062",
    async run() {
      await clearRuns();
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, acquireSql(), ["resort", ADMIN, false]);
      expect(a.ok && J(a).status === "running", `A should win the lease, got ${show(a)}`);
      const pb = run(B, acquireSql(), ["resort", ADMIN, false]);
      await waitsOn(B, A, { advisory: true }, "B queues on the lease lock");
      await commit(A);
      const b = await andEnd(B, pb);
      refused(b, "P0062", "B");
      noDeadlock(a, b);
      const live = await q(`select lease_token from ${RUNS} where status = 'running'`);
      expect(live.length === 1 && live[0].lease_token === J(a).lease_token, `expected exactly A's lease running, got ${JSON.stringify(live)}`);
    },
  },
  // concurrency-proof: sheet_sync_acquire (L2: a stale-lease takeover raced by a second acquirer)
  {
    id: "L2",
    title: "stale takeover x acquire: one takeover, the old lease failed once, the other refused",
    async run() {
      const old = await newRun("resort", { ageMin: 11 });
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, acquireSql(), ["revert", ADMIN, false]);
      expect(a.ok && J(a).status === "running", `A should take over the stale lease, got ${show(a)}`);
      const pb = run(B, acquireSql(), ["revert", ADMIN, false]);
      await waitsOn(B, A, { advisory: true }, "B queues on the lease lock");
      await commit(A);
      const b = await andEnd(B, pb);
      refused(b, "P0062", "B");
      noDeadlock(a, b);
      const o = (await q(`select status, error from ${RUNS} where id = $1`, [old.runId]))[0];
      expect(o.status === "failed" && /lease expired/.test(o.error), `the stale run should be failed by the takeover, got ${JSON.stringify(o)}`);
      const live = await q(`select lease_token from ${RUNS} where status = 'running'`);
      expect(live.length === 1 && live[0].lease_token === J(a).lease_token, `expected exactly the takeover's lease running, got ${JSON.stringify(live)}`);
    },
  },
  // concurrency-proof: sheet_sync_acquire, _sheet_sync_fence (L3: acquire queues behind a live holder's in-flight write, then finds it live)
  {
    id: "L3",
    title: "acquire x a live holder's in-flight write: queues on the run row, then refused P0062, no takeover",
    async run() {
      const r = await newRun("resort", { ageMin: 9.8 });
      const p = await mkPatient({ referral: "other" });
      const [H, B] = [await newActor("holder"), await newActor("B")];
      await begin(H);
      await begin(B);
      const h = await run(H, `select public.sheet_resort_apply($1::uuid, $2::uuid[], 'other', 'online_google') as j`, [r.token, [p]]);
      expect(h.ok && J(h) === 1, `the holder's write should land, got ${show(h)}`);
      const pb = run(B, acquireSql(), ["revert", ADMIN, false]);
      await waitsOn(B, H, { relation: RUNS }, "the acquirer waits out the in-flight write");
      await commit(H);
      const b = await andEnd(B, pb);
      refused(b, "P0062", "B");
      const row = (await q(`select status, lease_token, extract(epoch from now() - heartbeat_at)::int as age from ${RUNS} where id = $1`, [r.runId]))[0];
      expect(row.status === "running" && row.lease_token === r.token && row.age < 120, `the holder's lease must survive with a fresh heartbeat, got ${JSON.stringify(row)}`);
      expect((await patientRow(p)).referral_source === "online_google", "the holder's in-flight write must have committed");
    },
  },
  // concurrency-proof: sheet_sync_acquire (L4: a paused cron acquire is NOWAIT - it records the skip instead of queueing behind a worker)
  {
    id: "L4",
    title: "paused cron acquire x a worker holding the run row: answers at once (skipped_paused), never waits",
    async run() {
      const r = await newRun("resort");
      const [H, B] = [await newActor("holder"), await newActor("cron")];
      await begin(H);
      await begin(B);
      const h = await run(H, heartbeatSql, [r.token]);
      expect(h.ok, `holder heartbeat: ${show(h)}`);
      const b = await answersAtOnce(B, run(B, acquireSql(), ["cron", ADMIN, false]), "paused acquire must not wait on the worker's row lock");
      expect(b.ok && J(b).status === "skipped_paused", `cron should be recorded as skipped_paused, got ${show(b)}`);
      await endNow(B, b);
      await commit(H);
      const row = (await q(`select status, lease_token from ${RUNS} where id = $1`, [r.runId]))[0];
      expect(row.status === "running" && row.lease_token === r.token, `the worker's lease must be untouched, got ${JSON.stringify(row)}`);
    },
  },
  // concurrency-proof: sheet_sync_acquire (L5: free race of acquirers, ROUNDS times)
  {
    id: "L5",
    title: `free race: 5 acquirers x ${ROUNDS} rounds, exactly one lease each round, no 23505 / 40P01`,
    async run() {
      const as = await Promise.all([1, 2, 3, 4, 5].map((i) => newActor(`acq${i}`)));
      for (let i = 0; i < ROUNDS; i++) {
        await clearRuns();
        const outs = await Promise.all(
          as.map(async (a) => {
            await begin(a);
            return andEnd(a, run(a, acquireSql(), ["resort", ADMIN, false]));
          }),
        );
        noDeadlock(...outs);
        const won = outs.filter((o) => o.ok);
        expect(won.length === 1, `round ${i}: expected exactly one winner, got ${outs.map(show).join(" | ")}`);
        for (const o of outs) if (!o.ok) expect(o.code === "P0062", `round ${i}: a loser got ${show(o)} instead of P0062`);
        expect((await countOf(`select count(*) n from ${RUNS} where status = 'running'`)) === 1, `round ${i}: not exactly one running row`);
      }
    },
  },
  // concurrency-proof: _sheet_sync_fence, sheet_resort_apply (F1: an old token whose write queued behind a COMMITTED takeover)
  {
    id: "F1",
    title: "old token queued behind a takeover: refused P0063, wrote nothing",
    async run() {
      const old = await newRun("resort", { ageMin: 11 });
      const p = await mkPatient({ referral: "other" });
      const [T, W] = [await newActor("takeover"), await newActor("old worker")];
      await begin(T);
      await begin(W);
      const t = await run(T, `select public.sheet_sync_acquire('revert', $1::uuid, false) as j`, [ADMIN]);
      expect(t.ok && J(t).status === "running", `takeover: ${show(t)}`);
      const pw = run(W, resortSql(), [old.token, [p], "other", "online_google"]);
      await waitsOn(W, T, { relation: RUNS }, "the old worker's fence queues on the superseded run row");
      await commit(T);
      const w = await andEnd(W, pw);
      refused(w, "P0063", "old worker");
      expect((await patientRow(p)).referral_source === "other", "the old worker must not have changed the patient");
      expect((await countOf(`select count(*) n from public.sheet_sync_changes where run_id = $1`, [old.runId])) === 0, "no change may be recorded under the superseded run");
    },
  },
  // concurrency-proof: _sheet_sync_fence, sheet_resort_apply (F1b: the takeover ROLLS BACK, so the old lease is still 'running' but stale)
  {
    id: "F1b",
    title: "old token queued behind a takeover that rolls back: still refused P0063 (stale heartbeat)",
    async run() {
      const old = await newRun("resort", { ageMin: 11 });
      const p = await mkPatient({ referral: "other" });
      const [T, W] = [await newActor("takeover"), await newActor("old worker")];
      await begin(T);
      await begin(W);
      const t = await run(T, `select public.sheet_sync_acquire('revert', $1::uuid, false) as j`, [ADMIN]);
      expect(t.ok, `takeover: ${show(t)}`);
      const pw = run(W, resortSql(), [old.token, [p], "other", "online_google"]);
      await waitsOn(W, T, { relation: RUNS }, "the old worker queues on the run row");
      await T.c.query("rollback");
      const w = await andEnd(W, pw);
      refused(w, "P0063", "old worker");
      expect((await patientRow(p)).referral_source === "other", "a stale lease must not write even when nobody took it over");
    },
  },
  // concurrency-proof: _sheet_sync_fence, sheet_resort_apply (F3: a write queued behind the same run's finish)
  {
    id: "F3",
    title: "write queued behind finish: refused P0063 (the run is no longer running)",
    async run() {
      const r = await newRun("resort");
      const p = await mkPatient({ referral: "other" });
      const [F, W] = [await newActor("finish"), await newActor("late write")];
      await begin(F);
      await begin(W);
      const fin = await run(F, finishSql, [r.token]);
      expect(fin.ok, `finish: ${show(fin)}`);
      const pw = run(W, resortSql(), [r.token, [p], "other", "online_google"]);
      await waitsOn(W, F, { relation: RUNS }, "the late write queues on the run row");
      await commit(F);
      const w = await andEnd(W, pw);
      refused(w, "P0063", "late write");
      expect((await patientRow(p)).referral_source === "other", "a write after finish must not land");
    },
  },
  // concurrency-proof: sheet_sync_upsert_review (U1: two upserts of one review item, under one lease)
  {
    id: "U1",
    title: "two upserts of the same review item (even as different identity kinds): one open row",
    async run() {
      const r = await newRun("resort");
      const key = `${TAGL}-rev-${++SEQ}`;
      const item = (kind: string) => [{ kind, item_key: key, payload: { candidates: [] } }];
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, upsertSql(), [r.token, "customers", JSON.stringify(item("ambiguous_patient")), false]);
      expect(a.ok && J(a).opened === 1, `A should open the item, got ${show(a)}`);
      const pb = run(B, upsertSql(), [r.token, "customers", JSON.stringify(item("identity_conflict")), false]);
      await waitsOn(B, A, { relation: RUNS }, "the second upsert queues on the fence");
      await commit(A);
      const b = await andEnd(B, pb);
      expect(b.ok, `B should update the item it finds, got ${show(b)}`);
      noDeadlock(a, b);
      expect(J(b).opened === 0 && J(b).updated === 1, `B must update, not open: ${show(b)}`);
      const rows = await q(`select kind, status from public.sheet_sync_review_items where item_key = $1`, [key]);
      expect(rows.length === 1 && rows[0].status === "open" && rows[0].kind === "identity_conflict", `expected one open identity_conflict row, got ${JSON.stringify(rows)}`);
    },
  },
  // concurrency-proof: sheet_sync_release_undo (R1: the same release replayed under one lease)
  {
    id: "R1",
    title: "release replay: the holds are released once, the replay is refused 22023",
    async run() {
      const undo = await mkRun("revert");
      await mkRun("manual", "succeeded", { revertedBy: undo });
      const keys = [`${TAGL}-h${++SEQ}`, `${TAGL}-h${++SEQ}`];
      for (const k of keys)
        await q(
          `insert into public.sheet_patient_links (link_key, decision, method, run_id, hold_reason) values ($1, 'review', 'auto_exact', $2, 'undone by an admin')`,
          [k, undo],
        );
      await q(`insert into public.sheet_sync_review_items (tab, item_key, kind) values ('customers', $1, 'ambiguous_patient')`, [keys[0]]);
      const r = await newRun("release");
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, releaseSql(), [r.token, undo, null]);
      expect(a.ok && J(a).released === 2 && J(a).done === true, `A should release both holds, got ${show(a)}`);
      const pb = run(B, releaseSql(), [r.token, undo, null]);
      await waitsOn(B, A, { relation: RUNS }, "the replay queues on the fence");
      await commit(A);
      const b = await andEnd(B, pb);
      refused(b, "22023", "replay");
      expect((await countOf(`select count(*) n from public.sheet_patient_links where link_key = any($1::text[])`, [keys])) === 0, "the holds must be gone");
      const item = (await q(`select status, resolution from public.sheet_sync_review_items where item_key = $1`, [keys[0]]))[0];
      expect(item.status === "resolved" && item.resolution.release_run_id === r.runId, `the item must be resolved by the release, got ${JSON.stringify(item)}`);
      expect((await q(`select released_by_run_id from ${RUNS} where id = $1`, [undo]))[0].released_by_run_id === r.runId, "the undo must be stamped released by this run");
    },
  },
  // concurrency-proof: sheet_resort_apply (RS1: the same chunk replayed under one lease)
  {
    id: "RS1",
    title: "resort replay: second call moves nothing and records nothing twice",
    async run() {
      const r = await newRun("resort");
      const ps = [await mkPatient({ referral: "other" }), await mkPatient({ referral: "other" })];
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, resortSql(), [r.token, ps, "other", "online_google"]);
      expect(a.ok && J(a) === 2, `A should move both, got ${show(a)}`);
      const pb = run(B, resortSql(), [r.token, ps, "other", "online_google"]);
      await waitsOn(B, A, { relation: RUNS }, "the replay queues on the fence");
      await commit(A);
      const b = await andEnd(B, pb);
      expect(b.ok && J(b) === 0, `the replay must move 0 rows (they no longer carry the expected old value), got ${show(b)}`);
      const dup = await countOf(
        `select count(*) n from (select patient_id, column_name from public.sheet_sync_changes where run_id = $1 group by 1, 2 having count(*) > 1) d`,
        [r.runId],
      );
      expect(dup === 0, "the replay must not record the same change twice");
      for (const p of ps) expect((await patientRow(p)).referral_source === "online_google", "both patients stay moved");
    },
  },
  // concurrency-proof: sheet_resort_apply (RS2: a staff edit of the same patient's channel lands first)
  {
    id: "RS2",
    title: "resort x staff edit of the channel: waits on the patient row, then skips it (no lost update)",
    async run() {
      const r = await newRun("resort");
      const p = await mkPatient({ referral: "other" });
      const [S, W] = [await newActor("staff"), await newActor("resort")];
      await begin(S, null);
      await begin(W);
      await S.c.query(`update public.patients set referral_source = 'walk_in' where id = $1`, [p]);
      const pw = run(W, resortSql(), [r.token, [p], "other", "online_google"]);
      await waitsOn(W, S, { relation: PATIENTS }, "resort queues on the patient row");
      await commit(S);
      const w = await andEnd(W, pw);
      expect(w.ok && J(w) === 0, `resort must skip the edited patient, got ${show(w)}`);
      const row = await patientRow(p);
      expect(row.referral_source === "walk_in" && row.referral_source_origin === "staff", `the staff value must survive, got ${JSON.stringify(row)}`);
    },
  },
  // concurrency-proof: sheet_alias_apply (AL1: a map answer replayed under one lease)
  {
    id: "AL1",
    title: "alias replay: second call refused P0064, alias and patient written once",
    async run() {
      const { key, patient, item } = await aliasFixture();
      const r = await newRun("alias");
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, aliasSql(), [r.token, key, "online_facebook", ADMIN, item]);
      expect(a.ok && J(a) === 1, `A should move the one patient, got ${show(a)}`);
      const pb = run(B, aliasSql(), [r.token, key, "online_facebook", ADMIN, item]);
      await waitsOn(B, A, { relation: RUNS }, "the replay queues on the fence");
      await commit(A);
      const b = await andEnd(B, pb);
      refused(b, "P0064", "replay");
      expect((await patientRow(patient)).referral_source === "online_facebook", "the patient is moved");
      expect((await countOf(`select count(*) n from public.referral_source_aliases where raw_normalized = $1`, [key])) === 1, "one alias row");
      expect((await q(`select status from public.sheet_sync_review_items where id = $1`, [item]))[0].status === "resolved", "the item is resolved");
    },
  },
  // concurrency-proof: sheet_alias_apply (AL2: a staff edit of a patient the map answer would move)
  {
    id: "AL2",
    title: "alias x staff edit of the channel: waits on the patient row, then leaves it alone",
    async run() {
      const { key, patient } = await aliasFixture(false);
      const r = await newRun("alias");
      const [S, W] = [await newActor("staff"), await newActor("alias")];
      await begin(S, null);
      await begin(W);
      await S.c.query(`update public.patients set referral_source = 'walk_in' where id = $1`, [patient]);
      const pw = run(W, aliasSql(), [r.token, key, "online_facebook", ADMIN, null]);
      await waitsOn(W, S, { relation: PATIENTS }, "alias queues on the patient row");
      await commit(S);
      const w = await andEnd(W, pw);
      expect(w.ok && J(w) === 0, `the answer must not move a patient staff just set, got ${show(w)}`);
      const row = await patientRow(patient);
      expect(row.referral_source === "walk_in" && row.referral_source_origin === "staff", `the staff value must survive, got ${JSON.stringify(row)}`);
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops (A1: a create chunk replayed after a lost response)
  {
    id: "A1",
    title: "chunk replay with a create: the second call skips the existing person (no duplicate patient)",
    async run() {
      const r = await newRun("resort");
      const ck = `c${++SEQ}`;
      const ops = [createOp(ck)];
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, applySql(), [r.token, JSON.stringify(ops)]);
      expect(a.ok && J(a).counts.created === 1, `A should create, got ${show(a)}`);
      const pb = run(B, applySql(), [r.token, JSON.stringify(ops)]);
      await waitsOn(B, A, { relation: RUNS }, "the replay queues on the fence");
      await commit(A);
      const b = await andEnd(B, pb);
      expect(b.ok, `the replay should answer, got ${show(b)}`);
      noDeadlock(a, b);
      expect(J(b).counts.created === 0 && J(b).counts.skipped_existing === 1, `the replay must skip the existing person, got ${show(b)}`);
      const n = await countOf(`select count(*) n from public.patients where last_name = $1`, [`${TAG}Cr${ck}`]);
      expect(n === 1, `expected exactly one patient for the person, got ${n}`);
      expect((await countOf(`select count(*) n from public.sheet_sync_changes where run_id = $1 and change_kind = 'create'`, [r.runId])) === 1, "one create change");
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops (A2: a staff edit lands between the planner's read and the fill)
  {
    id: "A2",
    title: "fill x staff edit: waits on the patient row, then counts it stale (nothing filled)",
    async run() {
      const r = await newRun("resort");
      const p = await mkPatient();
      const rv = (await patientRow(p)).rv;
      const [S, W] = [await newActor("staff"), await newActor("apply")];
      await begin(S, null);
      await begin(W);
      await S.c.query(`update public.patients set address = 'Edited by staff' where id = $1`, [p]);
      const pw = run(W, applySql(), [r.token, JSON.stringify([fillOp(p, rv, { email: emailOf("fill") })])]);
      await waitsOn(W, S, { relation: PATIENTS }, "the fill queues on the patient row");
      await commit(S);
      const w = await andEnd(W, pw);
      expect(w.ok, `the chunk should answer, got ${show(w)}`);
      expect(J(w).counts.stale === 1 && J(w).counts.filled === 0, `the fill must be stale, got ${show(w)}`);
      const row = await patientRow(p);
      expect(row.email === null && row.address === "Edited by staff", `staff edit kept, nothing filled; got ${JSON.stringify(row)}`);
      expect((await countOf(`select count(*) n from public.sheet_sync_changes where run_id = $1`, [r.runId])) === 0, "no change recorded");
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops (A3: a fill chunk meets a patient being deleted)
  {
    id: "A3",
    title: "fill chunk x delete_patient of its second patient: stale (not P0058), the first fill lands",
    async run() {
      const r = await newRun("resort");
      const [p1, p2] = [await mkPatient(), await mkPatient()];
      const [rv1, rv2] = [(await patientRow(p1)).rv, (await patientRow(p2)).rv];
      const [D, W] = [await newActor("delete"), await newActor("apply")];
      await begin(D);
      await begin(W);
      const d = await run(D, deleteSql, [p2, ADMIN]);
      expect(d.ok, `delete_patient: ${show(d)}`);
      const e1 = emailOf("a3a");
      const pw = run(W, applySql(), [r.token, JSON.stringify([fillOp(p1, rv1, { email: e1 }), fillOp(p2, rv2, { email: emailOf("a3b") })])]);
      await waitsOn(W, D, { relation: PATIENTS }, "the second fill queues on the patient being deleted");
      await commit(D);
      const w = await andEnd(W, pw);
      expect(w.ok, `the chunk must not fail because one patient was just deleted, got ${show(w)}`);
      expect(J(w).counts.filled === 1 && J(w).counts.stale === 1, `expected filled 1 / stale 1, got ${show(w)}`);
      expect((await patientRow(p1)).email === e1, "the first patient is filled");
      const row2 = await patientRow(p2);
      expect(row2.deleted_at !== null && row2.email === null, `the deleted patient stays deleted and unfilled, got ${JSON.stringify(row2)}`);
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops (A5: a whole chunk queued behind a takeover)
  {
    id: "A5",
    title: "chunk queued behind a takeover: refused P0063, nothing of it applied",
    async run() {
      const old = await newRun("resort", { ageMin: 11 });
      const p = await mkPatient();
      const rv = (await patientRow(p)).rv;
      const ck = `c${++SEQ}`;
      const ops = [fillOp(p, rv, { email: emailOf("a5") }), createOp(ck)];
      const [T, W] = [await newActor("takeover"), await newActor("old worker")];
      await begin(T);
      await begin(W);
      const t = await run(T, `select public.sheet_sync_acquire('revert', $1::uuid, false) as j`, [ADMIN]);
      expect(t.ok, `takeover: ${show(t)}`);
      const pw = run(W, applySql(), [old.token, JSON.stringify(ops)]);
      await waitsOn(W, T, { relation: RUNS }, "the old chunk queues on the superseded run row");
      await commit(T);
      const w = await andEnd(W, pw);
      refused(w, "P0063", "old chunk");
      expect((await patientRow(p)).email === null, "the chunk's fill must not have landed");
      expect((await countOf(`select count(*) n from public.patients where last_name = $1`, [`${TAG}Cr${ck}`])) === 0, "the chunk's create must not have landed");
      expect((await countOf(`select count(*) n from public.sheet_sync_changes where run_id = $1`, [old.runId])) === 0, "no change recorded");
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops, sheet_sync_acquire (A6: a revert's acquire arrives while a chunk is in flight)
  {
    id: "A6",
    title: "revert-acquire x an in-flight chunk: the acquire waits and is refused P0062, the chunk lands whole",
    async run() {
      const r = await newRun("resort", { ageMin: 9.8 });
      const p = await mkPatient();
      const rv = (await patientRow(p)).rv;
      const ck = `c${++SEQ}`;
      const e = emailOf("a6");
      const ops = [fillOp(p, rv, { email: e }), createOp(ck)];
      const [H, T] = [await newActor("chunk"), await newActor("revert acquire")];
      await begin(H);
      await begin(T);
      const h = await run(H, applySql(), [r.token, JSON.stringify(ops)]);
      expect(h.ok && J(h).counts.filled === 1 && J(h).counts.created === 1, `the chunk should apply, got ${show(h)}`);
      const pt = run(T, acquireSql(), ["revert", ADMIN, false]);
      await waitsOn(T, H, { relation: RUNS }, "the acquire waits out the in-flight chunk");
      await commit(H);
      const t = await andEnd(T, pt);
      refused(t, "P0062", "revert acquire");
      expect((await patientRow(p)).email === e, "the chunk's fill landed");
      expect((await countOf(`select count(*) n from public.patients where last_name = $1`, [`${TAG}Cr${ck}`])) === 1, "the chunk's create landed");
      const row = (await q(`select status, lease_token from ${RUNS} where id = $1`, [r.runId]))[0];
      expect(row.status === "running" && row.lease_token === r.token, "the worker's lease must be untouched");
    },
  },
  // concurrency-proof: sheet_sync_revert_run (V1: a staff edit of a restored patient lands first)
  {
    id: "V1",
    title: "revert x staff edit: waits on the patient row, then blocks that patient (no lost update)",
    async run() {
      const p = await mkPatient({ referral: "other" });
      const target = await resortedRun([p]);
      const r = await newRun("revert");
      const [S, W] = [await newActor("staff"), await newActor("revert")];
      await begin(S, null);
      await begin(W);
      await S.c.query(`update public.patients set referral_source = 'walk_in' where id = $1`, [p]);
      const pw = run(W, revertSql(), [r.token, target, null]);
      await waitsOn(W, S, { relation: PATIENTS }, "the revert queues on the patient row");
      await commit(S);
      const w = await andEnd(W, pw);
      expect(w.ok, `the revert should answer, got ${show(w)}`);
      expect(J(w).blocked === 1 && J(w).restored === 0, `the edited patient must be blocked, got ${show(w)}`);
      expect((await patientRow(p)).referral_source === "walk_in", "the staff value must survive the revert");
      expect((await countOf(`select count(*) n from public.sheet_sync_changes where run_id = $1 and undo_outcome <> 'blocked'`, [target])) === 0, "every change of the edited patient is blocked");
    },
  },
  // concurrency-proof: sheet_sync_revert_run (V2: a paged revert page replayed under one lease)
  {
    id: "V2",
    title: "paged revert replay: page 2 takes the other patient, nothing is restored or blocked twice",
    async run() {
      const ps = [await mkPatient({ referral: "other" }), await mkPatient({ referral: "other" })];
      const target = await resortedRun(ps);
      const r = await newRun("revert");
      const [A, B] = [await newActor("A"), await newActor("B")];
      await begin(A);
      await begin(B);
      const a = await run(A, revertSql(), [r.token, target, 1]);
      expect(a.ok && J(a).restored === 1 && J(a).done === false, `page 1 should restore one patient, got ${show(a)}`);
      const pb = run(B, revertSql(), [r.token, target, 1]);
      await waitsOn(B, A, { relation: RUNS }, "the replayed page queues on the fence");
      await commit(A);
      const b = await andEnd(B, pb);
      expect(b.ok, `page 2 should answer, got ${show(b)}`);
      expect(J(b).restored === 1 && J(b).blocked === 0 && J(b).done === true, `page 2 must restore the OTHER patient and finish, got ${show(b)}`);
      for (const p of ps) expect((await patientRow(p)).referral_source === "other", "both patients restored");
      const bad = await countOf(`select count(*) n from public.sheet_sync_changes where run_id = $1 and undo_outcome is distinct from 'restored'`, [target]);
      expect(bad === 0, `every change must end 'restored' (${bad} do not)`);
      expect((await q(`select reverted_by_run_id from ${RUNS} where id = $1`, [target]))[0].reverted_by_run_id === r.runId, "the target is stamped undone");
    },
  },
  // concurrency-proof: sheet_sync_revert_run (V3: staff delete a sheet-created patient while the undo reaches it)
  {
    id: "V3",
    title: "revert of a created patient x delete_patient: waits, then calls it gone (never kept, never re-deleted)",
    async run() {
      const cr = await newRun("resort");
      const ck = `c${++SEQ}`;
      const done = (await q(`select public.sheet_sync_apply_customer_ops($1, $2::jsonb) as j`, [cr.token, JSON.stringify([createOp(ck)])]))[0].j;
      expect(done.counts.created === 1, `fixture create: ${JSON.stringify(done)}`);
      await endRun(cr.token);
      const x = (await q(`select id from public.patients where last_name = $1`, [`${TAG}Cr${ck}`]))[0].id as string;
      const r = await newRun("revert");
      const [D, W] = [await newActor("delete"), await newActor("revert")];
      await begin(D);
      await begin(W);
      const d = await run(D, deleteSql, [x, ADMIN]);
      expect(d.ok, `delete_patient: ${show(d)}`);
      const pw = run(W, revertSql(), [r.token, cr.runId, null]);
      await waitsOn(W, D, { relation: PATIENTS }, "the revert queues on the created patient");
      await commit(D);
      const w = await andEnd(W, pw);
      expect(w.ok, `the revert should answer, got ${show(w)}`);
      expect(J(w).gone === 1 && J(w).deleted === 0 && J(w).kept === 0, `expected gone 1 / deleted 0 / kept 0, got ${show(w)}`);
      const row = await patientRow(x);
      expect(row && row.deleted_at !== null, "the patient is still there, soft-deleted by staff");
    },
  },
  // concurrency-proof: sheet_sync_revert_run (D2: lock order against merge_patients_guarded, which locks id-ascending)
  {
    id: "D2",
    title: "revert x merge over the same two patients: ascending lock order on both sides, no 40P01",
    async run() {
      const ps = [await mkPatient({ referral: "other" }), await mkPatient({ referral: "other" })].sort();
      const [lo, hi] = ps as [string, string];
      const target = await resortedRun([lo, hi]);
      const r = await newRun("revert");
      const [H, R, M] = [await newActor("holder"), await newActor("revert"), await newActor("merge")];
      await begin(H, null);
      await begin(R);
      await begin(M);
      await H.c.query(`select 1 from public.patients where id = $1 for update`, [hi]);
      const pr = run(R, revertSql(), [r.token, target, null]);
      await waitsOn(R, H, { relation: PATIENTS }, "the revert reaches the higher patient while the holder has it");
      const pm = run(M, mergeSql, [hi, lo, ADMIN]);
      await isBlocked(M, "the merge queues behind the revert (which already holds the lower patient)");
      await commit(H);
      const [rr, mm] = await Promise.all([andEnd(R, pr), andEnd(M, pm)]);
      noDeadlock(rr, mm);
      expect(rr.ok && J(rr).restored === 2, `the revert should restore both patients, got ${show(rr)}`);
      expect(mm.ok || /^P00\d\d$/.test(mm.code), `the merge must finish or refuse cleanly, got ${show(mm)}`);
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops (A4 - KNOWN: link / facts check the patient without locking it)
  {
    id: "A4",
    known: true,
    title: "KNOWN: link op x delete_patient - the link is written to the patient being deleted",
    async run() {
      const r = await newRun("resort");
      const p = await mkPatient();
      const rv = (await patientRow(p)).rv;
      const key = `${TAGL}-lk-del-${++SEQ}`;
      const [D, W] = [await newActor("delete"), await newActor("apply")];
      await begin(D);
      await begin(W);
      const d = await run(D, deleteSql, [p, ADMIN]);
      expect(d.ok, `delete_patient: ${show(d)}`);
      const linkOp = { op: "link", link_key: key, patient_id: p, method: "auto_exact", expected_row_version: rv };
      const w = await andEnd(W, answersAtOnce(W, run(W, applySql(), [r.token, JSON.stringify([linkOp])]), "the link read does not lock the patient"));
      await endNow(D, d);
      expect(w.ok, `the chunk answered ${show(w)}`);
      const link = (await q(`select patient_id from public.sheet_patient_links where link_key = $1`, [key]))[0];
      const del = (await patientRow(p)).deleted_at !== null;
      const reproduced = link?.patient_id === p && del;
      console.log(`    evidence A4: chunk answered ${show(w)}; link ${link ? "now points at" : "absent for"} the patient; patient deleted_at ${del ? "set" : "null"}`);
      return reproduced ? "reproduced" : "not-reproduced";
    },
  },
  // concurrency-proof: sheet_sync_apply_customer_ops (D1 - KNOWN: a chunk's patient-row order against merge_patients_guarded's id-ascending order)
  {
    id: "D1",
    known: true,
    title: "KNOWN: apply chunk [higher, lower] x merge of the same two patients - lock-order cycle (40P01)",
    async run() {
      const r = await newRun("resort");
      const ps = [await mkPatient(), await mkPatient()].sort();
      const [lo, hi] = ps as [string, string];
      const [rvLo, rvHi] = [(await patientRow(lo)).rv, (await patientRow(hi)).rv];
      const [W, M] = [await newActor("apply"), await newActor("merge")];
      await begin(W);
      await begin(M);
      const w1 = await run(W, applySql(), [r.token, JSON.stringify([fillOp(hi, rvHi, { email: emailOf("d1h") })])]);
      expect(w1.ok, `first half of the chunk (higher patient): ${show(w1)}`);
      const pm = run(M, mergeSql, [hi, lo, ADMIN]);
      await isBlocked(M, "the merge holds the lower patient and waits for the higher one");
      const pw = andEnd(W, run(W, applySql(), [r.token, JSON.stringify([fillOp(lo, rvLo, { email: emailOf("d1l") })])]));
      const [ww, mm] = await Promise.all([pw, andEnd(M, pm)]);
      console.log(`    evidence D1: apply chunk -> ${show(ww)}; merge -> ${show(mm)}`);
      return [ww, mm].some((o) => !o.ok && o.code === "40P01") ? "reproduced" : "not-reproduced";
    },
  },
];

async function aliasFixture(withItem = true): Promise<{ key: string; patient: string; item: string | null }> {
  const key = `${TAGL}-src${++SEQ}`;
  const patient = await mkPatient({ referral: null });
  const run = await mkRun("manual");
  await q(
    `insert into public.sheet_customer_rows (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, link_state, row_hash, run_id, patient_id, source_norm)
     values (1, $1, 'Proof Person', 'proof|person', 'proof', $2, 'linked', 'h', $3, $4, $5)`,
    [`${TAGL}-row${SEQ}`, `${TAGL}-lnk${SEQ}`, run, patient, key],
  );
  let item: string | null = null;
  if (withItem)
    item = (await q(`insert into public.sheet_sync_review_items (tab, item_key, kind) values ('customers', $1, 'unmapped_source') returning id`, [key]))[0].id as string;
  return { key, patient, item };
}

// ---------------------------------------------------------------------------
// control mutants
// ---------------------------------------------------------------------------
interface Edit {
  fn: string;
  from: string;
  to: string;
}
interface Mutant {
  id: string;
  note: string;
  edits: Edit[];
  mustFail: string[];
}
const FENCE_USERS = ["sheet_resort_apply", "sheet_sync_apply_customer_ops"];
const MUTANTS: Mutant[] = [
  { id: "MA1", note: "acquire: lease advisory lock removed", edits: [{ fn: "sheet_sync_acquire", from: "  perform pg_advisory_xact_lock(hashtext('sheet_sync_lease'));\n", to: "" }], mustFail: ["L1", "L2"] },
  { id: "MA2", note: "acquire: takes over a LIVE lease (liveness test dropped)", edits: [{ fn: "sheet_sync_acquire", from: "if public._sheet_sync_lease_live(v_run.heartbeat_at) then", to: "if false then" }], mustFail: ["L3", "A6"] },
  { id: "MA3", note: "acquire: running row read without FOR UPDATE (does not wait out an in-flight write)", edits: [{ fn: "sheet_sync_acquire", from: "where r.status = 'running' for update;", to: "where r.status = 'running';" }], mustFail: ["L3", "A6"] },
  { id: "MA4", note: "acquire: paused branch waits instead of NOWAIT", edits: [{ fn: "sheet_sync_acquire", from: "where r.status = 'running' for update nowait;", to: "where r.status = 'running' for update;" }], mustFail: ["L4"] },
  { id: "MF1", note: "fence: status = 'running' filter dropped (a finished run still passes)", edits: [{ fn: "_sheet_sync_fence", from: "r.lease_token = p_lease_token and r.status = 'running'", to: "r.lease_token = p_lease_token" }], mustFail: ["F3"] },
  { id: "MF2", note: "fence: heartbeat liveness test dropped (a stale lease still writes)", edits: [{ fn: "_sheet_sync_fence", from: "if not public._sheet_sync_lease_live(v_hb) then", to: "if false then" }], mustFail: ["F1b"] },
  { id: "MF3", note: "fence: FOR UPDATE dropped (a write does not queue behind the takeover / finish)", edits: [{ fn: "_sheet_sync_fence", from: "\n   for update;\n  if v_id is null then", to: ";\n  if v_id is null then" }], mustFail: ["F1", "F1b", "F3", "A5"] },
  { id: "MU1", note: "upsert_review: open-item lookup dropped (always inserts)", edits: [{ fn: "sheet_sync_upsert_review", from: "if v_open.id is not null then", to: "if false then" }], mustFail: ["U1"] },
  { id: "MR1", note: "release_undo: already-released guard dropped", edits: [{ fn: "sheet_sync_release_undo", from: "if v_undo.released_by_run_id is not null then", to: "if false then" }], mustFail: ["R1"] },
  { id: "MS1", note: "resort_apply: expected-old-channel condition dropped (a replay is still stopped by the origin condition)", edits: [{ fn: "sheet_resort_apply", from: "and p.referral_source is not distinct from p_expected_old", to: "" }], mustFail: ["RS2"] },
  {
    id: "MS2",
    note: "resort_apply: expected-old-channel AND already-sheet-origin conditions dropped (both replay defences)",
    edits: [
      { fn: "sheet_resort_apply", from: "and p.referral_source is not distinct from p_expected_old", to: "" },
      { fn: "sheet_resort_apply", from: "and p.referral_source_origin is distinct from 'sheet'", to: "" },
    ],
    mustFail: ["RS1", "RS2"],
  },
  { id: "ML1", note: "alias_apply: open-item check dropped (replay not refused)", edits: [{ fn: "sheet_alias_apply", from: "if p_item_id is not null and not exists (", to: "if false and not exists (" }], mustFail: ["AL1"] },
  { id: "ML2", note: "alias_apply: staff-set channel no longer protected", edits: [{ fn: "sheet_alias_apply", from: "and (p.referral_source is null or p.referral_source_origin = 'sheet')", to: "" }], mustFail: ["AL2"] },
  { id: "MO1", note: "apply: concurrent-registration guard dropped (replay duplicates the person)", edits: [{ fn: "sheet_sync_apply_customer_ops", from: "if v_dupe_id is not null then", to: "if false then" }], mustFail: ["A1"] },
  {
    id: "MO2",
    note: "apply: fill excludes neither deleted / merged patients NOR a stale row_version (a deletion bumps row_version, so each guard alone is covered by the other)",
    edits: [
      { fn: "sheet_sync_apply_customer_ops", from: "and p.deleted_at is null and p.merged_into_id is null\n       for update;", to: "for update;" },
      { fn: "sheet_sync_apply_customer_ops", from: "if v_op ? 'expected_row_version' and v_old.row_version <> (v_op->>'expected_row_version')::bigint then", to: "if false then" },
    ],
    mustFail: ["A3"],
  },
  { id: "MO3", note: "apply: fill stale-row_version guard dropped", edits: [{ fn: "sheet_sync_apply_customer_ops", from: "if v_op ? 'expected_row_version' and v_old.row_version <> (v_op->>'expected_row_version')::bigint then", to: "if false then" }], mustFail: ["A2"] },
  { id: "MO4", note: "apply: fill reads the patient without FOR UPDATE", edits: [{ fn: "sheet_sync_apply_customer_ops", from: "and p.deleted_at is null and p.merged_into_id is null\n       for update;", to: "and p.deleted_at is null and p.merged_into_id is null;" }], mustFail: ["A2", "A3"] },
  { id: "MV1", note: "revert: row_version equality dropped (restores over a staff edit)", edits: [{ fn: "sheet_sync_revert_run", from: "v_cur.row_version <> v_ver or ", to: "" }], mustFail: ["V1"] },
  { id: "MV2", note: "revert: patient row read without FOR UPDATE", edits: [{ fn: "sheet_sync_revert_run", from: "select * into v_cur from public.patients p where p.id = v_pid for update;", to: "select * into v_cur from public.patients p where p.id = v_pid;" }], mustFail: ["V1"] },
  { id: "MV3", note: "revert: already-handled changes no longer skipped (page replay re-processes)", edits: [{ fn: "sheet_sync_revert_run", from: "c.change_kind = 'update' and c.undo_outcome is null", to: "c.change_kind = 'update'" }], mustFail: ["V2"] },
  { id: "MV4", note: "revert: since-deleted created patient no longer called gone", edits: [{ fn: "sheet_sync_revert_run", from: "if v_del_at is not null then", to: "if false then" }], mustFail: ["V3"] },
  { id: "MV5", note: "revert: patients locked in DESCENDING id order (merge locks ascending)", edits: [{ fn: "sheet_sync_revert_run", from: "     group by c.patient_id\n     order by c.patient_id\n", to: "     group by c.patient_id\n     order by c.patient_id desc\n" }], mustFail: ["D2"] },
];

async function buildMutant(schema: string, m: Mutant): Promise<Record<string, string>> {
  const names = new Set(m.edits.map((e) => e.fn));
  if (names.has("_sheet_sync_fence")) for (const u of FENCE_USERS) names.add(u);
  const map: Record<string, string> = {};
  await monitor.query(`create schema ${schema}`);
  for (const name of names) {
    const defs = await q(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name]);
    expect(defs.length === 1, `${m.id}: expected exactly one public.${name}, found ${defs.length}`);
    let body: string = defs[0].d;
    for (const e of m.edits.filter((x) => x.fn === name)) {
      const parts = body.split(e.from);
      if (parts.length !== 2) throw new Error(`${m.id}: «${e.from.trim()}» occurs ${parts.length - 1} times in public.${name} (need exactly 1) - the live function drifted, update MUTANTS`);
      body = parts.join(e.to);
    }
    body = body.replace(`FUNCTION public.${name}(`, `FUNCTION ${schema}.${name}(`);
    if (names.has("_sheet_sync_fence") && name !== "_sheet_sync_fence") body = body.split("public._sheet_sync_fence(").join(`${schema}._sheet_sync_fence(`);
    await monitor.query(body);
    map[name] = `${schema}.${name}`;
  }
  await monitor.query(`grant usage on schema ${schema} to service_role`);
  await monitor.query(`grant execute on all functions in schema ${schema} to service_role`);
  return map;
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------
async function sweep(): Promise<void> {
  const ctl = await q(`select nspname from pg_namespace where nspname like 'sscproof_ctl_%'`);
  for (const s of ctl) await monitor.query(`drop schema ${s.nspname} cascade`);
  const admins: string[] = (await q(`select id from auth.users where email like 'sscproof%-admin@example.test'`)).map((r) => r.id);
  // a crashed run may have left a live lease behind: end it so nothing waits on it
  await q(`update public.sheet_sync_runs set status = 'failed', ended_at = now(), error = 'proof sweep' where status = 'running' and actor_id = any($1::uuid[])`, [admins]);
  await monitor.query("begin");
  try {
    // local-only teardown of rows this proof minted: replica mode skips the lifecycle guards (fixtures end deleted) and per-row RI ordering
    await monitor.query("set local session_replication_role = replica");
    const runs: string[] = (await q(`select id from public.sheet_sync_runs where actor_id = any($1::uuid[])`, [admins])).map((r) => r.id);
    const pats: string[] = (await q(`select id from public.patients where last_name like 'SscProof%' or drm_id like 'DRM-SSCPROOF%'`)).map((r) => r.id);
    const imports: string[] = (
      await q(
        `select legacy_import_run_id as id from public.sheet_sync_runs where id = any($1::uuid[]) and legacy_import_run_id is not null
         union select legacy_import_run_id from public.patients where id = any($2::uuid[]) and legacy_import_run_id is not null`,
        [runs, pats],
      )
    ).map((r) => r.id);
    const del = (sql: string, p: unknown[]) => monitor.query(sql, p);
    await del(`delete from public.sheet_sync_changes where run_id = any($1::uuid[]) or patient_id = any($2::uuid[])`, [runs, pats]);
    await del(`delete from public.sheet_patient_links where link_key like 'sscproof%' or patient_id = any($2::uuid[]) or run_id = any($1::uuid[])`, [runs, pats]);
    await del(`delete from public.sheet_sync_review_items where item_key like 'sscproof%' or run_id = any($1::uuid[])`, [runs]);
    await del(`delete from public.referral_source_aliases where raw_normalized like 'sscproof%' or run_id = any($1::uuid[])`, [runs]);
    await del(`delete from public.sheet_customer_rows where source_key like 'sscproof%' or run_id = any($1::uuid[]) or patient_id = any($2::uuid[])`, [runs, pats]);
    await del(`delete from public.sheet_mirror_staging where run_id = any($1::uuid[])`, [runs]);
    await del(`delete from public.patient_acquisition_facts where patient_id = any($1::uuid[])`, [pats]);
    await del(`delete from public.patient_merges where keep_id = any($1::uuid[]) or source_id = any($1::uuid[])`, [pats]);
    await del(`delete from public.audit_log where patient_id = any($1::uuid[]) or actor_id = any($2::uuid[])`, [pats, admins]);
    await del(`delete from public.patients where id = any($1::uuid[])`, [pats]);
    await del(`delete from public.sheet_sync_runs where id = any($1::uuid[])`, [runs]);
    await del(`delete from public.legacy_import_runs where id = any($1::uuid[])`, [imports]);
    await del(`delete from public.staff_profiles where id = any($1::uuid[])`, [admins]);
    await del(`delete from auth.users where id = any($1::uuid[])`, [admins]);
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}
async function leftovers(): Promise<string[]> {
  const out: string[] = [];
  const chk = async (label: string, sql: string) => {
    const n = await countOf(sql);
    if (n) out.push(`${label}: ${n}`);
  };
  await chk("patients", `select count(*) n from public.patients where last_name like 'SscProof%' or drm_id like 'DRM-SSCPROOF%'`);
  await chk("runs", `select count(*) n from public.sheet_sync_runs where actor_id in (select id from auth.users where email like 'sscproof%-admin@example.test')`);
  await chk("links", `select count(*) n from public.sheet_patient_links where link_key like 'sscproof%'`);
  await chk("review items", `select count(*) n from public.sheet_sync_review_items where item_key like 'sscproof%'`);
  await chk("aliases", `select count(*) n from public.referral_source_aliases where raw_normalized like 'sscproof%'`);
  await chk("customer rows", `select count(*) n from public.sheet_customer_rows where source_key like 'sscproof%'`);
  await chk("staff users", `select count(*) n from auth.users where email like 'sscproof%-admin@example.test'`);
  await chk("scratch schemas", `select count(*) n from pg_namespace where nspname like 'sscproof_ctl_%'`);
  return out;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
type Result = { status: "pass" | "fail" | "known" | "fixed"; msg: string };
async function runOne(s: Scenario): Promise<Result> {
  try {
    const v = await s.run();
    if (s.known) return v === "reproduced" ? { status: "known", msg: "bug reproduced" } : { status: "fixed", msg: "NOT reproduced - promote this scenario to an asserted one" };
    return { status: "pass", msg: "" };
  } catch (e) {
    return { status: "fail", msg: e instanceof Error ? e.message : String(e) };
  } finally {
    await closeActors();
  }
}

let cleanupP: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleanupP ??= (async () => {
    await closeActors();
    await sweep().catch((e) => console.error(`sweep failed: ${e instanceof Error ? e.message : e}`));
    if (pausedChanged && origPaused !== null)
      await monitor.query(`update public.sheet_sync_settings set paused = $1 where id`, [origPaused]).catch(() => undefined);
  })();
  return cleanupP;
}

async function main(): Promise<void> {
  monitor = new Client({ connectionString: DB_URL });
  monitor.on("error", () => undefined);
  await monitor.connect();
  const lock = await q("select pg_try_advisory_lock(hashtext('sheet-sync:concurrency-proof')) as ok");
  if (!lock[0].ok) {
    console.error("another sheet-sync concurrency proof is running - exiting");
    process.exit(2);
  }
  let exit = 0;
  const onSignal = (sig: NodeJS.Signals) => () => {
    aborting = true;
    console.error(`${sig}: stopping, cleaning up`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal("SIGINT"));
  process.once("SIGTERM", onSignal("SIGTERM"));
  try {
    const have = await q(
      `select count(*)::int n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])`,
      [[...new Set(["_sheet_sync_fence", "sheet_sync_acquire", "sheet_sync_upsert_review", "sheet_sync_release_undo", "sheet_resort_apply", "sheet_alias_apply", "sheet_sync_apply_customer_ops", "sheet_sync_revert_run", "sheet_sync_finish", "sheet_sync_heartbeat", "delete_patient", "merge_patients_guarded"])]],
    );
    if (have[0].n !== 12) throw new Error(`prerequisites missing by object: found ${have[0].n} of 12 functions (0170/0193/0196/0204 and the lifecycle functions must be applied)`);
    expect((await countOf(`select count(*) n from information_schema.columns where table_name = 'sheet_patient_links' and column_name = 'held_patient_id'`)) === 1, "0193/0204 column held_patient_id is missing");
    await sweep();
    origPaused = (await q(`select paused from public.sheet_sync_settings where id`))[0].paused as boolean;
    if (!origPaused) {
      await q(`update public.sheet_sync_settings set paused = true where id`);
      pausedChanged = true;
    }
    await setupAdmin();
    const ver = (await q("select version() as v"))[0].v as string;
    console.log(`Plan: ${ver.split(",")[0]}; tag ${TAG}; ${ROUNDS} free-race rounds; sync paused (restored after: ${pausedChanged ? "yes" : "was already paused"})`);

    const runAll = async (only: string[] | null): Promise<Record<string, Result>> => {
      const res: Record<string, Result> = {};
      for (const s of scenarios) {
        if (only && !only.includes(s.id)) continue;
        if (aborting) break;
        res[s.id] = await runOne(s);
        const r = res[s.id]!;
        console.log(`  ${r.status === "pass" ? "ok   " : r.status === "known" ? "KNOWN" : r.status === "fixed" ? "FIXED" : "FAIL "} ${s.id} ${s.title}${r.msg ? ` - ${r.msg}` : ""}`);
      }
      return res;
    };

    console.log("Real functions (public):");
    const real = await runAll(null);
    const asserted = Object.entries(real).filter(([id]) => !scenarios.find((s) => s.id === id)?.known);
    const passed = asserted.filter(([, r]) => r.status === "pass").length;
    const known = Object.values(real).filter((r) => r.status === "known").length;
    console.log(`${passed}/${asserted.length} scenarios passed; ${known} known issue(s) reproduced.`);
    if (passed !== asserted.length) exit = 1;

    if (CONTROL && !aborting) {
      let caught = 0;
      for (const m of MUTANTS) {
        if (aborting) break;
        const schema = `sscproof_ctl_${randomBytes(3).toString("hex")}`;
        console.log(`Control ${m.id}: ${m.note}`);
        try {
          routed = await buildMutant(schema, m);
          const res = await runAll(m.mustFail);
          const survived = m.mustFail.filter((id) => res[id]?.status !== "fail");
          if (survived.length) {
            console.log(`  CONTROL FAIL ${m.id}: ${survived.join(", ")} still passed against the mutant - the proof cannot catch this`);
            exit = 1;
          } else {
            caught++;
            console.log(`  control ${m.id} ok: ${m.mustFail.join(", ")} failed against the mutant`);
          }
        } finally {
          routed = {};
          await closeActors();
          await monitor.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
        }
      }
      console.log(`${caught}/${MUTANTS.length} mutants caught.`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    exit = 1;
  } finally {
    await cleanup();
    const left = await leftovers().catch((e) => [`leftover check failed: ${e instanceof Error ? e.message : e}`]);
    if (left.length) {
      console.error(`FAIL: tagged rows left behind - ${left.join("; ")}`);
      exit = 1;
    } else console.log("Leftovers: 0");
    await monitor.query("select pg_advisory_unlock(hashtext('sheet-sync:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(aborting ? 130 : exit);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
