// Hand-run local CONCURRENCY proof for three claim/lock functions that shipped without one:
//   public.claim_statement_email        (0177) — advisory lock on visit + recipient, window check, insert
//   public.result_claim_patient_notify  (0179) — compare-and-set UPDATE of patient_notified_at
//   public.result_mark_copy_contacted   (0179) — amendment FOR UPDATE -> results FOR SHARE -> seq check -> stamp + audit
//
// Each function is called the way the app calls it:
//   claim_statement_email, result_claim_patient_notify -> service_role (the admin client,
//     src/lib/visits/send-statement-email.ts and src/lib/notifications/notify-corrected.ts)
//   result_mark_copy_contacted -> a reception user's JWT (role authenticated, sub = staff id),
//     because the Server Action uses the user's own client and the function checks staff_role()
//   result_edit_commit (C2 only) -> service_role with the REAL function, not a simulation
//
// DETERMINISTIC, NOT LUCKY. Every scenario holds one side open in a transaction, starts the other
// and does not move on until pg_locks shows THAT backend (own pid only) waiting on the expected
// lock - an advisory lock, or a row lock on a named table. Where the other side must NOT wait, the
// call must answer while the first is still open and never appear in pg_locks as waiting. A
// scenario that cannot reach its interleaving FAILS; it never degrades into a sequential run.
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows), tagged
// ncp-<hex> / NCP-<HEX>, swept at start, deleted in finally (also on SIGINT / SIGTERM) and counted.
//
// Run (local stack only):
//   npm run notice-claims:concurrency-proof [-- --control]
//
// --control proves the proof can fail: it copies the live function into a throwaway schema with ONE
// guard removed and passes only if the named scenarios FAIL against it:
//   M1 no advisory lock                         (claim_statement_email: S1, S1b, S2)
//   M2 recipient key not lower()/btrim()'d      (claim_statement_email: S1b)
//   M3 window check ignores age                 (claim_statement_email: S4)
//   M4 predicate without `patient_notified_at is null` (result_claim_patient_notify: N1)
//   M5 no FOR UPDATE on the amendment          (result_mark_copy_contacted: C1)
//   M6 no FOR SHARE on the results row         (result_mark_copy_contacted: C2a)
//
// concurrency-proof: claim_statement_email (S1-S4 and mutants M1-M3 race the real claim)
// concurrency-proof: result_claim_patient_notify (N1-N3, C3 and mutant M4 race the real claim)
// concurrency-proof: result_mark_copy_contacted (C1-C3 and mutants M5-M6 race the real mark)
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";

requireLocalOrExplicitProd("notice-claims:concurrency-proof", {
  writes:
    "throwaway patients / visits / lines / results / amendments / staff tagged ncp-<hex>, plus rate_limit_attempts rows, committed so two connections can race on them, then deleted",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// This script COMMITS rows, so it must never run against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[notice-claims:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const HEX = randomBytes(3).toString("hex");
const TAG = `ncp-${HEX}`;
const TAG_UP = `NCP-${HEX.toUpperCase()}`;
const CONTROL = process.argv.includes("--control");
const ADMIN = randomUUID();
const RECEPTION = randomUUID();
const SERVICE = randomUUID();
const EMAIL_DOMAIN = "example.test";

let monitor: Client;
const open: Client[] = [];
const made = { patients: [] as string[], results: [] as string[], lines: [] as string[] };
let seq = 0;

/** Which schema each function resolves to - a mutant schema for the one under control. */
let mutated: { name: string; schema: string } | null = null;
const F = (name: string) => `${mutated?.name === name ? mutated.schema : "public"}.${name}`;

class Fail extends Error {}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Fail(msg);
}

// ---------------------------------------------------------------------------
// Connections and actors
// ---------------------------------------------------------------------------
async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  open.push(c);
  return c;
}
async function closeRacers(): Promise<void> {
  for (const c of open.splice(0)) {
    if (c === monitor) continue;
    await c.query("rollback").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
  open.push(monitor);
}
interface Racer {
  c: Client;
  pid: number;
}
async function racer(): Promise<Racer> {
  const c = await connect();
  const pid = (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  return { c, pid };
}
/** begin as service_role, the role the admin client uses. */
async function beginService(r: Racer): Promise<void> {
  await r.c.query("begin");
  await r.c.query("set local role service_role");
}
/** begin as a staff member's JWT (role authenticated), the role the Server Action's own client has. */
async function beginStaff(r: Racer, uid: string): Promise<void> {
  await r.c.query("begin");
  await r.c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  await r.c.query("set local role authenticated");
}

// ---------------------------------------------------------------------------
// Interleaving control - pg_locks, own backend pids only
// ---------------------------------------------------------------------------
interface Settled<T> {
  done: boolean;
  value?: T;
  code?: string;
  msg?: string;
}
interface Call<T> {
  state: Settled<T>;
  promise: Promise<Settled<T>>;
}
/** Run a query that may block; never rejects, records how it ended. */
function launch<T>(p: Promise<T>): Call<T> {
  const state: Settled<T> = { done: false };
  const promise = p.then(
    (v) => {
      state.done = true;
      state.value = v;
      return state;
    },
    (e: { code?: string; message?: string }) => {
      state.done = true;
      state.code = e.code ?? "ERR";
      state.msg = e.message ?? String(e);
      return state;
    },
  );
  return { state, promise };
}

interface Waiting {
  advisory: boolean;
  /** table of the tuple the backend waits for (first waiter), if any */
  tupleRel: string | null;
  rowWait: boolean;
}
async function waitingOf(pid: number): Promise<Waiting> {
  const { rows } = await monitor.query<{ locktype: string; granted: boolean; rel: string | null }>(
    "select locktype, granted, case when locktype = 'tuple' then relation::regclass::text end as rel from pg_locks where pid = $1",
    [pid],
  );
  return {
    advisory: rows.some((r) => r.locktype === "advisory" && !r.granted),
    rowWait: rows.some((r) => r.locktype === "transactionid" && !r.granted),
    tupleRel: rows.find((r) => r.locktype === "tuple")?.rel?.replace(/^public\./, "") ?? null,
  };
}
type Expect = { advisory: true } | { row: string };
/** The backend's in-flight call must be seen BLOCKED on the expected lock within ~5s. */
async function mustWait(r: Racer, call: Call<unknown>, expectLock: Expect, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let seen: Waiting | null = null;
  while (Date.now() < deadline) {
    if (call.state.done) {
      throw new Fail(`${label}: the call answered without waiting (interleaving not reached): ${describe(call.state)}`);
    }
    seen = await waitingOf(r.pid);
    if ("advisory" in expectLock ? seen.advisory : seen.rowWait && seen.tupleRel === expectLock.row) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Fail(
    `${label}: never saw the call wait on ${"advisory" in expectLock ? "an advisory lock" : `a row of ${expectLock.row}`} (last seen ${JSON.stringify(seen)})`,
  );
}
/** The call must answer at once, while the other side is open, never appearing as blocked. */
async function mustNotWait<T>(r: Racer, call: Call<T>, label: string): Promise<Settled<T>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (call.state.done) return call.state;
    const w = await waitingOf(r.pid);
    if (w.advisory || w.rowWait) throw new Fail(`${label}: the call blocked on a lock but must not`);
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Fail(`${label}: the call neither answered nor blocked in 5s`);
}
const describe = (s: Settled<unknown>) =>
  s.code ? `${s.code} ${s.msg}` : JSON.stringify((s.value as { rows?: unknown } | undefined)?.rows ?? null);
function ok<T>(s: Settled<T>, label: string): T {
  if (s.code) throw new Fail(`${label}: unexpected error ${describe(s)}`);
  return s.value as T;
}

// ---------------------------------------------------------------------------
// Fixtures (committed through the monitor, as postgres)
// ---------------------------------------------------------------------------
async function setup(): Promise<void> {
  for (const [id, role, k] of [
    [ADMIN, "admin", "admin"],
    [RECEPTION, "reception", "rec"],
  ] as const) {
    await monitor.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
      [id, `${TAG}-${k}@${EMAIL_DOMAIN}`],
    );
    await monitor.query("insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, $3, true)", [
      id,
      `NCP ${TAG} ${k}`,
      role,
    ]);
  }
  await monitor.query(`insert into public.services (id, code, name, price_php, kind) values ($1, $2, 'NCP lab', 100, 'lab_test')`, [
    SERVICE,
    `${TAG_UP}-LAB`,
  ]);
}

interface Amendment {
  patient: string;
  visit: string;
  line: string;
  result: string;
  amendment: string;
}
/** A finished (result_uploaded: still editable, no GL bridge) lab line with a finished result carrying ONE correction (amendment_seq 1 = amendment_count 1). */
async function mkAmendment(): Promise<Amendment> {
  seq += 1;
  const q = async (sql: string, args: unknown[]) => (await monitor.query(sql, args)).rows[0]!.id as string;
  const patient = await q(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, email)
     values ($1, 'Ncp', $2, '1990-01-01', $3) returning id`,
    [`${TAG_UP}-${seq}`, `Fixture${seq}`, `${TAG}-p${seq}@${EMAIL_DOMAIN}`],
  );
  made.patients.push(patient);
  const visit = await q(
    `insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'paid', 0, 0) returning id`,
    [patient],
  );
  const line = await q(
    `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
     values ($1, $2, 'result_uploaded', $3, 0, 0) returning id`,
    [visit, SERVICE, ADMIN],
  );
  made.lines.push(line);
  const result = await q(
    `insert into public.results (generation_kind, uploaded_by, storage_path, file_size_bytes, amendment_count, amended_at)
     values ('uploaded', $1, $2, 1, 1, now()) returning id`,
    [ADMIN, `ncp/${TAG}/${seq}/current.pdf`],
  );
  made.results.push(result);
  await monitor.query(`insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)`, [result, line]);
  const amendment = await q(
    `insert into public.result_amendments
       (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at,
        reason, amended_by, amendment_seq, attempt_id)
     values ($1, $2, $3, $4, now(), 'ncp fixture correction', $4, 1, $5) returning id`,
    [result, line, `ncp/${TAG}/${seq}/prior.pdf`, ADMIN, randomUUID()],
  );
  return { patient, visit, line, result, amendment };
}

async function purge(): Promise<void> {
  const patients = (
    await monitor.query<{ id: string }>("select id from public.patients where drm_id like $1", [`NCP-%`])
  ).rows.map((r) => r.id);
  const staff = (
    await monitor.query<{ id: string }>("select id from public.staff_profiles where full_name like 'NCP ncp-%'")
  ).rows.map((r) => r.id);
  const lines = (
    await monitor.query<{ id: string }>(
      "select tr.id from public.test_requests tr join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[])",
      [patients],
    )
  ).rows.map((r) => r.id);
  await monitor.query("delete from public.rate_limit_attempts where bucket = 'statement_email' and identifier like '%:ncp-%@example.test'");
  await monitor.query(
    "delete from public.audit_log where patient_id = any($1::uuid[]) or actor_id = any($2::uuid[]) or resource_id = any($3::uuid[])",
    [patients, staff, lines],
  );
  await monitor.query(
    "delete from public.results where id in (select result_id from public.result_test_requests where test_request_id = any($1::uuid[]))",
    [lines],
  );
  await monitor.query("delete from public.result_amendments where test_request_id = any($1::uuid[])", [lines]);
  await monitor.query("delete from public.test_requests where id = any($1::uuid[])", [lines]);
  await monitor.query("delete from public.visits where patient_id = any($1::uuid[])", [patients]);
  await monitor.query("delete from public.patients where id = any($1::uuid[])", [patients]);
  await monitor.query("delete from public.services where code like $1", [`NCP-%-LAB`]);
  await monitor.query("delete from public.staff_profiles where id = any($1::uuid[])", [staff]);
  await monitor.query("delete from auth.users where id = any($1::uuid[])", [staff]);
  const { rows } = await monitor.query<{ nspname: string }>("select nspname from pg_namespace where nspname like 'ncp_ctl_%'");
  for (const r of rows) await monitor.query(`drop schema ${r.nspname} cascade`);
}
async function leftovers(): Promise<number> {
  const { rows } = await monitor.query<{ n: string }>(
    `select (
       (select count(*) from public.patients where drm_id like 'NCP-%')
     + (select count(*) from public.staff_profiles where full_name like 'NCP ncp-%')
     + (select count(*) from public.services where code like 'NCP-%-LAB')
     + (select count(*) from public.rate_limit_attempts where bucket = 'statement_email' and identifier like '%:ncp-%@example.test')
     + (select count(*) from auth.users where email like 'ncp-%@example.test')
     )::text as n`,
  );
  return Number(rows[0]!.n);
}

// ---------------------------------------------------------------------------
// claim_statement_email
// ---------------------------------------------------------------------------
const rid = (n: string) => `${TAG}-${n}@${EMAIL_DOMAIN}`;
const claimStmt = (r: Racer, visit: string, recipient: string, windowSecs?: number) =>
  launch(
    r.c.query<{ id: string | null }>(`select ${F("claim_statement_email")}($1, $2${windowSecs ? ", $3" : ""}) as id`, [
      visit,
      recipient,
      ...(windowSecs ? [windowSecs] : []),
    ]),
  );
const stmtRows = async (visit: string, recipientNorm: string) =>
  Number(
    (
      await monitor.query<{ n: string }>(
        "select count(*)::text as n from public.rate_limit_attempts where bucket = 'statement_email' and identifier = $1",
        [`${visit}:${recipientNorm}`],
      )
    ).rows[0]!.n,
  );
const idOf = (s: Settled<{ rows: Array<{ id: string | null }> }>, label: string) => ok(s, label).rows[0]!.id;

async function twoStmt(
  label: string,
  v1: string,
  r1: string,
  v2: string,
  r2: string,
): Promise<{ a: Racer; b: Racer; first: Call<{ rows: Array<{ id: string | null }> }>; second: Call<{ rows: Array<{ id: string | null }> }> }> {
  const [a, b] = [await racer(), await racer()];
  await beginService(a);
  const first = claimStmt(a, v1, r1);
  expect(idOf(await first.promise, `${label} first`) !== null, `${label}: the first claim was refused`);
  await beginService(b);
  const second = claimStmt(b, v2, r2);
  return { a, b, first, second };
}

async function sameKeyRace(label: string, recipient2: string): Promise<void> {
  const visit = randomUUID();
  const recipient = rid(label.toLowerCase());
  const { a, b, second } = await twoStmt(label, visit, recipient, visit, recipient2);
  await mustWait(b, second, { advisory: true }, label);
  await a.c.query("commit");
  const id2 = idOf(await second.promise, `${label} second`);
  await b.c.query("commit");
  expect(id2 === null, `${label}: the second claim was NOT refused (got id ${id2}) - the statement would send twice`);
  const rows = await stmtRows(visit, recipient.toLowerCase());
  expect(rows === 1, `${label}: expected exactly 1 rate_limit_attempts row, found ${rows}`);
}

// ---------------------------------------------------------------------------
// result_claim_patient_notify and result_mark_copy_contacted
// ---------------------------------------------------------------------------
const claimNotify = (r: Racer, amendment: string) =>
  launch(
    r.c.query<{ result_id: string; amendment_seq: number; anchor_test_request_id: string; patient_id: string }>(
      `select * from ${F("result_claim_patient_notify")}($1)`,
      [amendment],
    ),
  );
const markContacted = (r: Racer, amendment: string) =>
  launch(r.c.query<{ at: Date }>(`select ${F("result_mark_copy_contacted")}($1) as at`, [amendment]));
const editCommit = (r: Racer, a: Amendment, expectedCount: number) =>
  launch(
    r.c.query(`select public.result_edit_commit($1, $2, $3, $4, 'ncp proof second correction', $5, $6, 1, null, null, null) as r`, [
      randomUUID(),
      a.result,
      expectedCount,
      ADMIN,
      a.line,
      `ncp/${TAG}/edited-${randomUUID()}.pdf`,
    ]),
  );
interface AmRow {
  patient_contacted_at: Date | null;
  patient_notified_at: Date | null;
}
async function amRow(id: string): Promise<AmRow> {
  return (
    await monitor.query<AmRow>("select patient_contacted_at, patient_notified_at from public.result_amendments where id = $1", [id])
  ).rows[0]!;
}
async function auditCount(a: Amendment): Promise<number> {
  return Number(
    (
      await monitor.query<{ n: string }>(
        "select count(*)::text as n from public.audit_log where action = 'result.patient_contacted' and resource_id = $1",
        [a.line],
      )
    ).rows[0]!.n,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
type Scenario = () => Promise<void>;
const scenarios: Record<string, Scenario> = {
  // concurrency-proof: claim_statement_email
  // S1 - two claims for one visit + recipient: the second waits on the advisory lock, then is refused.
  async S1() {
    await sameKeyRace("S1", rid("s1"));
  },
  // S1b - the key is lower(btrim(recipient)): case / whitespace differences are the same statement.
  async S1b() {
    await sameKeyRace("S1b", `  ${rid("s1b").toUpperCase()}  `);
  },
  // S2 - the first claim rolls back (its send failed): the waiting second claim then gets an id.
  async S2() {
    const visit = randomUUID();
    const recipient = rid("s2");
    const { a, b, second } = await twoStmt("S2", visit, recipient, visit, recipient);
    await mustWait(b, second, { advisory: true }, "S2");
    await a.c.query("rollback");
    const id2 = idOf(await second.promise, "S2 second");
    await b.c.query("commit");
    expect(id2 !== null, "S2: the waiting claim was refused after the first rolled back");
    const rows = await stmtRows(visit, recipient);
    expect(rows === 1, `S2: expected exactly 1 row, found ${rows}`);
  },
  // S3a - a different recipient on the same visit never waits.
  async S3a() {
    const visit = randomUUID();
    const { a, b, second } = await twoStmt("S3a", visit, rid("s3a1"), visit, rid("s3a2"));
    const id2 = idOf(await mustNotWait(b, second, "S3a"), "S3a second");
    await a.c.query("commit");
    await b.c.query("commit");
    expect(id2 !== null, "S3a: the other recipient was refused");
  },
  // S3b - the same recipient on a different visit never waits.
  async S3b() {
    const recipient = rid("s3b");
    const { a, b, second } = await twoStmt("S3b", randomUUID(), recipient, randomUUID(), recipient);
    const id2 = idOf(await mustNotWait(b, second, "S3b"), "S3b second");
    await a.c.query("commit");
    await b.c.query("commit");
    expect(id2 !== null, "S3b: the other visit was refused");
  },
  // S4 - the window: a fresh attempt blocks, one older than p_window_seconds does not.
  async S4() {
    const visit = randomUUID();
    const recipient = rid("s4");
    const [a, b, c] = [await racer(), await racer(), await racer()];
    await beginService(a);
    const id1 = idOf(await claimStmt(a, visit, recipient, 60).promise, "S4 first");
    await a.c.query("commit");
    expect(id1 !== null, "S4: first claim refused");
    await beginService(b);
    const idFresh = idOf(await claimStmt(b, visit, recipient, 60).promise, "S4 fresh repeat");
    await b.c.query("commit");
    expect(idFresh === null, "S4: a repeat inside the window was admitted");
    await monitor.query(
      "update public.rate_limit_attempts set attempted_at = now() - interval '120 seconds' where bucket = 'statement_email' and identifier = $1",
      [`${visit}:${recipient}`],
    );
    await beginService(c);
    const second = claimStmt(c, visit, recipient, 60);
    const idOld = idOf(await mustNotWait(c, second, "S4"), "S4 after the window");
    await c.c.query("commit");
    expect(idOld !== null, "S4: an attempt older than the window still blocked the claim");
    expect((await stmtRows(visit, recipient)) === 2, "S4: expected the backdated row plus the new claim");
  },

  // concurrency-proof: result_claim_patient_notify
  // N1 - two claims of one correction: the second waits on the row, then gets nothing.
  async N1() {
    const am = await mkAmendment();
    const [a, b] = [await racer(), await racer()];
    await beginService(a);
    const first = ok((await claimNotify(a, am.amendment).promise), "N1 first").rows;
    expect(first.length === 1 && first[0]!.amendment_seq === 1, `N1: first claim returned ${JSON.stringify(first)}`);
    const stamp = (await a.c.query<{ t: string }>("select patient_notified_at::text as t from public.result_amendments where id = $1", [am.amendment])).rows[0]!.t;
    await beginService(b);
    const second = claimNotify(b, am.amendment);
    await mustWait(b, second, { row: "result_amendments" }, "N1");
    await a.c.query("commit");
    const rows2 = ok(await second.promise, "N1 second").rows;
    await b.c.query("commit");
    expect(rows2.length === 0, `N1: the second claim also won (${rows2.length} rows) - the notice would send twice`);
    const after = (await monitor.query<{ t: string }>("select patient_notified_at::text as t from public.result_amendments where id = $1", [am.amendment])).rows[0]!.t;
    expect(after === stamp, `N1: patient_notified_at moved (${stamp} -> ${after}); it must be set once`);
  },
  // N2 - the first claimer rolls back: the waiting claim then wins.
  async N2() {
    const am = await mkAmendment();
    const [a, b] = [await racer(), await racer()];
    await beginService(a);
    expect(ok(await claimNotify(a, am.amendment).promise, "N2 first").rows.length === 1, "N2: first claim lost");
    await beginService(b);
    const second = claimNotify(b, am.amendment);
    await mustWait(b, second, { row: "result_amendments" }, "N2");
    await a.c.query("rollback");
    const rows2 = ok(await second.promise, "N2 second").rows;
    await b.c.query("commit");
    expect(rows2.length === 1, `N2: the waiting claim got ${rows2.length} rows after the first rolled back`);
    expect((await amRow(am.amendment)).patient_notified_at !== null, "N2: patient_notified_at not set");
  },
  // N3 - claims on different corrections never wait.
  async N3() {
    const [x, y] = [await mkAmendment(), await mkAmendment()];
    const [a, b] = [await racer(), await racer()];
    await beginService(a);
    expect(ok(await claimNotify(a, x.amendment).promise, "N3 first").rows.length === 1, "N3: first claim lost");
    await beginService(b);
    const rows2 = ok(await mustNotWait(b, claimNotify(b, y.amendment), "N3"), "N3 second").rows;
    await a.c.query("commit");
    await b.c.query("commit");
    expect(rows2.length === 1, "N3: the other correction's claim lost");
  },

  // concurrency-proof: result_mark_copy_contacted
  // C1 - two marks of one correction: the second waits on the amendment row, then returns the FIRST's
  //      timestamp; exactly one audit row.
  async C1() {
    const am = await mkAmendment();
    const [a, b] = [await racer(), await racer()];
    await beginStaff(a, RECEPTION);
    const t1 = ok(await markContacted(a, am.amendment).promise, "C1 first").rows[0]!.at;
    await beginStaff(b, RECEPTION);
    const second = markContacted(b, am.amendment);
    await mustWait(b, second, { row: "result_amendments" }, "C1");
    await a.c.query("commit");
    const t2 = ok(await second.promise, "C1 second").rows[0]!.at;
    await b.c.query("commit");
    expect(new Date(t2).getTime() === new Date(t1).getTime(), `C1: the second mark returned ${t2.toISOString()}, not the first's ${t1.toISOString()}`);
    const n = await auditCount(am);
    expect(n === 1, `C1: expected exactly one result.patient_contacted audit row, found ${n}`);
  },
  // C2a - a correction commits first: the mark waits on the results row, then is refused P0068.
  async C2a() {
    const am = await mkAmendment();
    const [edit, mark] = [await racer(), await racer()];
    await beginService(edit);
    const edited = ok(await editCommit(edit, am, 1).promise, "C2a correction"); // real result_edit_commit, holds results FOR UPDATE
    expect(edited.rows.length === 1, "C2a: correction returned nothing");
    await beginStaff(mark, RECEPTION);
    const call = markContacted(mark, am.amendment);
    await mustWait(mark, call, { row: "results" }, "C2a");
    await edit.c.query("commit");
    const s = await call.promise;
    await mark.c.query("rollback");
    expect(s.code === "P0068" && /corrected again/.test(s.msg ?? ""), `C2a: the mark ended ${describe(s)}, expected P0068 "corrected again"`);
    expect((await amRow(am.amendment)).patient_contacted_at === null, "C2a: the superseded correction was stamped contacted");
    expect(await auditCount(am) === 0, "C2a: an audit row was written for a refused mark");
  },
  // C2b - a mark holds first: the correction waits (results FOR UPDATE vs the mark's FOR SHARE), then commits.
  async C2b() {
    const am = await mkAmendment();
    const [mark, edit] = [await racer(), await racer()];
    await beginStaff(mark, RECEPTION);
    ok(await markContacted(mark, am.amendment).promise, "C2b mark");
    await beginService(edit);
    const call = editCommit(edit, am, 1);
    await mustWait(edit, call, { row: "results" }, "C2b");
    await mark.c.query("commit");
    const s = await call.promise;
    await edit.c.query("commit");
    expect(!s.code, `C2b: the correction ended ${describe(s)} (a deadlock would be 40P01)`);
    const { rows } = await monitor.query<{ amendment_count: number }>("select amendment_count from public.results where id = $1", [am.result]);
    expect(rows[0]!.amendment_count === 2, `C2b: amendment_count is ${rows[0]!.amendment_count}, expected 2`);
    expect((await amRow(am.amendment)).patient_contacted_at !== null, "C2b: the mark was lost");
  },
  // C3a - a notify claim holds the amendment; a mark queues behind it, then both outcomes are kept.
  async C3a() {
    const am = await mkAmendment();
    const [n, m] = [await racer(), await racer()];
    await beginService(n);
    expect(ok(await claimNotify(n, am.amendment).promise, "C3a claim").rows.length === 1, "C3a: claim lost");
    await beginStaff(m, RECEPTION);
    const call = markContacted(m, am.amendment);
    await mustWait(m, call, { row: "result_amendments" }, "C3a");
    await n.c.query("commit");
    const s = await call.promise;
    await m.c.query("commit");
    expect(!s.code, `C3a: the mark ended ${describe(s)}`);
    const row = await amRow(am.amendment);
    expect(row.patient_contacted_at !== null && row.patient_notified_at !== null, `C3a: an outcome was lost ${JSON.stringify(row)}`);
    expect((await auditCount(am)) === 1, "C3a: expected one audit row");
  },
  // C3b - a mark holds the amendment; a notify claim queues behind it, then both outcomes are kept.
  async C3b() {
    const am = await mkAmendment();
    const [m, n] = [await racer(), await racer()];
    await beginStaff(m, RECEPTION);
    ok(await markContacted(m, am.amendment).promise, "C3b mark");
    await beginService(n);
    const call = claimNotify(n, am.amendment);
    await mustWait(n, call, { row: "result_amendments" }, "C3b");
    await m.c.query("commit");
    const s = await call.promise;
    await n.c.query("commit");
    expect(!s.code && (s.value?.rows.length ?? 0) === 1, `C3b: the claim ended ${describe(s)}, expected one row`);
    const row = await amRow(am.amendment);
    expect(row.patient_contacted_at !== null && row.patient_notified_at !== null, `C3b: an outcome was lost ${JSON.stringify(row)}`);
  },
};

async function runAll(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    try {
      await fn();
      result[name] = null;
      console.log(`  ok   ${name}`);
    } catch (e) {
      result[name] = e instanceof Error ? e.message : String(e);
      console.log(`  FAIL ${name}: ${result[name]}`);
    }
    await closeRacers();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Control mutants
// ---------------------------------------------------------------------------
interface Mutant {
  id: string;
  fn: string;
  sig: string;
  note: string;
  from: string;
  to: string;
  mustFail: string[];
}
const MUTANTS: Mutant[] = [
  {
    id: "M1",
    fn: "claim_statement_email",
    sig: "uuid,text,integer",
    note: "no advisory lock",
    from: "perform pg_advisory_xact_lock(hashtextextended('statement_email:' || v_key, 0));",
    to: "",
    mustFail: ["S1", "S1b", "S2"],
  },
  {
    id: "M2",
    fn: "claim_statement_email",
    sig: "uuid,text,integer",
    note: "recipient key not lower()/btrim()'d",
    from: "lower(btrim(p_recipient))",
    to: "p_recipient",
    mustFail: ["S1b"],
  },
  {
    id: "M3",
    fn: "claim_statement_email",
    sig: "uuid,text,integer",
    note: "window check ignores the attempt's age",
    from: "and attempted_at > now() - make_interval(secs => p_window_seconds)",
    to: "",
    mustFail: ["S4"],
  },
  {
    id: "M4",
    fn: "result_claim_patient_notify",
    sig: "uuid",
    note: "claim predicate without `patient_notified_at is null`",
    from: "and patient_notified_at is null",
    to: "",
    mustFail: ["N1"],
  },
  {
    id: "M5",
    fn: "result_mark_copy_contacted",
    sig: "uuid",
    note: "no FOR UPDATE on the amendment",
    from: "where id = p_amendment_id for update;",
    to: "where id = p_amendment_id;",
    mustFail: ["C1"],
  },
  {
    id: "M6",
    fn: "result_mark_copy_contacted",
    sig: "uuid",
    note: "no FOR SHARE on the results row",
    from: "where id = v_am.result_id for share;",
    to: "where id = v_am.result_id;",
    mustFail: ["C2a"],
  },
];

async function makeMutant(schema: string, m: Mutant): Promise<void> {
  const def = (
    await monitor.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [`public.${m.fn}(${m.sig})`])
  ).rows[0]!.d;
  if (!def.includes(m.from)) throw new Error(`${m.id}: the live function no longer contains «${m.from}» - update MUTANTS`);
  const body = def.replace(`FUNCTION public.${m.fn}(`, `FUNCTION ${schema}.${m.fn}(`).replace(m.from, m.to);
  await monitor.query(`create schema ${schema}`);
  await monitor.query(body);
  await monitor.query(`grant usage on schema ${schema} to service_role, authenticated`);
  await monitor.query(`grant execute on function ${schema}.${m.fn}(${m.sig}) to service_role, authenticated`);
}

async function main(): Promise<void> {
  monitor = await connect();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('notice-claims:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("another notice-claims concurrency proof is running - exiting");
    process.exit(2);
  }
  let exit = 0;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await closeRacers();
    await purge().catch((e) => console.error("cleanup error:", e instanceof Error ? e.message : e));
    const left = await leftovers().catch(() => -1);
    if (left !== 0) {
      console.error(`FAIL: ${left} fixture rows left behind`);
      exit = 1;
    } else console.log("Fixtures deleted (0 left).");
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void cleanup().finally(() => process.exit(130)));
  }
  try {
    await purge();
    await setup();
    console.log(`Plan: ${(await monitor.query<{ v: string }>("select version() as v")).rows[0]!.v}`);
    console.log("Real functions (public):");
    const real = await runAll();
    const failed = Object.entries(real).filter(([, e]) => e !== null);
    const total = Object.keys(real).length;
    console.log(`${total - failed.length}/${total} scenarios passed.`);
    if (failed.length > 0) exit = 1;

    if (CONTROL) {
      let caught = 0;
      let wanted = 0;
      for (const m of MUTANTS) {
        const schema = `ncp_ctl_${randomBytes(3).toString("hex")}`;
        console.log(`Control ${m.id} (${m.fn}): ${m.note}`);
        await makeMutant(schema, m);
        mutated = { name: m.fn, schema };
        const res = await runAll();
        mutated = null;
        for (const s of m.mustFail) {
          wanted += 1;
          if (res[s] !== null) caught += 1;
          else {
            console.log(`  CONTROL FAIL ${m.id}: scenario ${s} still passed against the mutant - the proof cannot catch this bug`);
            exit = 1;
          }
        }
        if (m.mustFail.every((s) => res[s] !== null)) console.log(`  control ${m.id} ok: ${m.mustFail.join(", ")} all failed against the mutant`);
        await monitor.query(`drop schema ${schema} cascade`);
      }
      console.log(`Control: ${caught}/${wanted} expected failures caught.`);
    }
  } finally {
    await cleanup();
    await monitor.query("select pg_advisory_unlock(hashtext('notice-claims:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
