// Hand-run local CONCURRENCY proof for the release-notice outbox
// (supabase/migrations/0210_release_notice_outbox.sql): claim_release_notice,
// finish_release_notice, retry_release_notice and the strict flag
// release_notices_enabled(). Nothing in the app calls them yet (PR 1 of 3).
//
// Same shape as the other pg-runner proofs (waiver / panel-claim): separate `pg`
// connections acting as service_role, real committed fixtures, pg_locks to
// PROVE each interleaving was reached, and a --control mode that mutates a copy
// of each function and requires the scenarios to FAIL against it.
//
// DETERMINISTIC, NOT LUCKY. A forced scenario holds one session's row locks in
// an open transaction, starts the other side, and does not move on until it has
// OBSERVED the interleaving: either the second session is waiting on a row lock
// in pg_locks (finish / retry queue behind the row), or - for FOR UPDATE SKIP
// LOCKED, which by design never waits - the first session's rows are provably
// still locked (a probe `for update skip locked` from the monitor returns
// nothing) while the second session finishes WITHOUT having waited. If the
// intended interleaving is not reached the scenario FAILS; it never degrades
// into a sequential run.
//
// SCENARIOS (each runs in BOTH plan modes: seq and indexed)
//   S1  two claimers over N due rows: A holds its claim open, B (same call)
//       must neither wait nor overlap; the two claims are disjoint and sum to N.
//   S1b four claimers started together over 12 rows (invariant check): the
//       claims are pairwise disjoint and together cover all 12.
//   S2  inline claim(id) vs sweeper claim on the SAME row: whichever holds the
//       row wins, the other gets nothing without waiting; exactly one winner,
//       attempts = 1 (both orders, plus the committed-then-second-claim order).
//   S3  a stale-lease finish with the OLD token is fenced and changes nothing,
//       while the NEWER attempt wins - committed order, and the raced order where
//       the old attempt's finish queues on the row the reclaim holds.
//   S4  manual retry vs a live `sending` lease: refused (committed, and raced
//       behind a claim that holds the row); a plain abandoned row is reset.
//   S5  flag OFF (and a missing settings row): claim returns nothing, inline and
//       sweeper, and changes nothing.
//
// CONTROL ROUNDS (--control) copy the four functions into a throwaway schema
// (rnp_ctl_<hex>, never public: the local stack is shared), apply ONE mutation,
// rerun the named scenarios and pass only if they FAIL in both modes:
//   M1 claim without SKIP LOCKED  (S1, S2)    M4 retry ignores the live lease   (S4)
//   M2 claim without FOR UPDATE   (S1, S2)    M5 claim ignores the flag         (S5)
//   M3 finish without the lease fence (S3)    M6 finish without its row lock    (S3)
// A BASELINE round first requires the unmutated copy to pass every scenario a
// mutant is judged on, so a broken copy cannot make every mutant look caught.
//
// FIXTURES. Committed (two connections cannot see each other's uncommitted
// rows): one patient and one visit per run, a notice per scenario. Everything
// carries the run tag (`rnp-<hex>` / `RNP-<HEX>`); stale rows of a crashed run
// are swept first and the `finally` deletes everything and proves 0 are left.
// The enabled flag is switched ON for the run and restored to its prior value.
//
// Run (local stack, 0210 applied):
//   npm run release-notice:concurrency-proof               # 2 plan modes
//   npm run release-notice:concurrency-proof -- --control  # + control rounds
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";

requireLocalOrExplicitProd("release-notice:concurrency-proof", {
  writes:
    "throwaway fixtures tagged rnp-<hex> (a patient, a visit and release_notices rows), committed so connections can race on them, then deleted; it switches release_notice_settings.enabled ON for the run and restores it",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// This script COMMITS rows: never run it against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(
    `[release-notice:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script commits fixtures and only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `rnp-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();

const fx = { patient: randomUUID(), visit: randomUUID() };

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

// BEGIN as service_role: the role the Server Action / cron route calls with.
async function begin(a: Actor, mode: Mode): Promise<void> {
  await a.c.query("begin");
  await a.c.query("set local role service_role");
  for (const g of MODE_GUCS[mode]) await a.c.query(g);
}

// ---------------------------------------------------------------------------
// The calls, exactly as the app issues them (rpc -> select * from fn(args))
// ---------------------------------------------------------------------------

type Out<T> = { ok: true; v: T } | { ok: false; code: string; message: string };

interface Notice {
  id: string;
  status: string;
  attempts: number;
  lease_token: string | null;
  email_state: string;
  sms_state: string;
  last_error: string | null;
}

async function settle<T>(p: Promise<QueryResult>, pick: (r: QueryResult) => T): Promise<Out<T>> {
  try {
    const r = await p;
    return { ok: true, v: pick(r) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "?", message: err.message ?? String(e) };
  }
}

// claim_release_notice(p_id, p_limit): the inline fast path (id) or the sweeper (null).
function claim(a: Actor, id: string | null, limit = 20): Promise<Out<Notice[]>> {
  return settle(
    a.c.query(`select * from ${fnSchema}.claim_release_notice($1::uuid, $2::int)`, [id, limit]),
    (r) => r.rows as Notice[],
  );
}

function finish(
  a: Actor,
  id: string,
  token: string,
  status: string,
  email: string | null = null,
  sms: string | null = null,
): Promise<Out<Notice[]>> {
  return settle(
    a.c.query(
      `select * from ${fnSchema}.finish_release_notice($1::uuid, $2::uuid, $3::text, $4::text, $5::text)`,
      [id, token, status, email, sms],
    ),
    (r) => r.rows as Notice[],
  );
}

function retry(a: Actor, id: string): Promise<Out<boolean>> {
  return settle(a.c.query(`select ${fnSchema}.retry_release_notice($1::uuid) as r`, [id]), (r) => r.rows[0].r as boolean);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// SKIP LOCKED never waits. Resolve the actor's call, polling pg_locks the whole
// time: if it is ever seen blocked on a row lock the claim queued behind
// someone else's rows (the SKIP LOCKED guarantee is gone) - a FAIL.
async function noWait<T>(a: Actor, p: Promise<Out<T>>, why: string): Promise<Out<T>> {
  let done = false;
  const guarded = p.then((o) => {
    done = true;
    return o;
  });
  for (let i = 0; i < 40 && !done; i++) {
    if (await waitingOnLock(a.pid)) {
      throw new Fail(`${a.name} WAITED on a row lock instead of skipping it (${why})`);
    }
    await Promise.race([guarded, sleep(50)]);
  }
  if (!done) throw new Fail(`${a.name} did not answer within 2s and is not on a row lock (${why})`);
  return guarded;
}

// The rows really are locked right now: a probe `for update skip locked` from
// the monitor finds none of them. Proves the holder's locks were live while the
// other side ran.
async function assertLocked(ids: string[], who: string): Promise<void> {
  await monitor.query("begin");
  try {
    const { rows } = await monitor.query(
      "select id from public.release_notices where id = any($1::uuid[]) for update skip locked",
      [ids],
    );
    if (rows.length > 0) throw new Fail(`interleaving not reached: ${who}'s rows are not locked (${rows.length} of ${ids.length} free)`);
  } finally {
    await monitor.query("rollback");
  }
}

function expectOk<T>(label: string, o: Out<T>): T {
  if (!o.ok) throw new Fail(`${label}: expected success, got ${o.code} ${o.message}`);
  return o.v;
}

// ---------------------------------------------------------------------------
// Fixture builders (committed, as postgres)
// ---------------------------------------------------------------------------

const made = { notices: [] as string[] };
let noticeSeq = 0;

// A pending (or given status) notice, aged so the sweeper sees it (> 2 min).
async function mkNotice(spec: { ageSecs?: number; status?: "pending" | "retry" | "abandoned"; attempts?: number } = {}): Promise<string> {
  const id = randomUUID();
  const age = spec.ageSecs ?? 600;
  const status = spec.status ?? "pending";
  const attempts = spec.attempts ?? 0;
  const seq = ++noticeSeq;
  made.notices.push(id);
  await monitor.query(
    `insert into public.release_notices
       (id, visit_id, released_at, test_request_ids, status, attempts, created_at, next_attempt_at, resolved_at, last_error)
     values ($1, $2, now() - make_interval(secs => $3), array[$4::uuid], $5, $6,
             now() - make_interval(secs => $7), now() - make_interval(secs => $7),
             case when $5 = 'abandoned' then now() else null end,
             case when $5 = 'abandoned' then $8 else null end)`,
    [id, fx.visit, seq, randomUUID(), status, attempts, age, `${TAG} fixture`],
  );
  return id;
}

async function notice(id: string): Promise<Notice> {
  const { rows } = await monitor.query<Notice>(
    "select id, status, attempts, lease_token, email_state, sms_state, last_error from public.release_notices where id = $1",
    [id],
  );
  return rows[0];
}

// Move a lease into the past (as the sender dying would leave it).
async function expireLease(id: string): Promise<void> {
  await monitor.query("update public.release_notices set lease_expires_at = now() - interval '1 second' where id = $1 and status = 'sending'", [id]);
}

async function setFlag(on: boolean): Promise<void> {
  await monitor.query(
    "insert into public.release_notice_settings (id, enabled) values (true, $1) on conflict (id) do update set enabled = excluded.enabled",
    [on],
  );
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
    // Every scenario starts with the table holding no claimable row of the
    // previous one: park whatever is left (cancelled rows are never due).
    await monitor.query(
      `update public.release_notices set status = 'cancelled', resolved_at = now(), lease_token = null, lease_expires_at = null
        where visit_id = $1 and status in ('pending', 'retry', 'sending')`,
      [fx.visit],
    );
    await setFlag(true);
    const note = await body();
    sink.push({ name: full, ok: true, detail: note ?? "" });
    console.log(`  PASS  ${full}${note ? ` - ${note}` : ""}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    sink.push({ name: full, ok: false, detail });
    console.log(`  FAIL  ${full} - ${detail}`);
  } finally {
    await closeActors();
    await setFlag(true).catch(() => undefined);
  }
}

const ids = (rows: Notice[]) => rows.map((r) => r.id).sort();

async function forcedScenarios(mode: Mode): Promise<void> {
  curMode = mode;

  // concurrency-proof: claim_release_notice (S1/S1b: two and four claimers take disjoint rows that sum to N, a loser skips a locked row and never waits; S2: inline claim vs sweeper on one row, exactly one winner)
  // ---- S1 two claimers, disjoint, sum to N ---------------------------------
  await scenario("S1", "two claimers over N due rows are disjoint and sum to N", async () => {
    const N = 10;
    const all: string[] = [];
    for (let i = 0; i < N; i++) all.push(await mkNotice());
    const [s1, s2] = [await actor("S1-A"), await actor("S1-B")];
    await begin(s1, mode);
    const a = expectOk("S1 claimer A", await claim(s1, null, 5));
    if (a.length !== 5) throw new Fail(`A should claim 5, claimed ${a.length}`);
    await assertLocked(ids(a), "claimer A");
    await begin(s2, mode);
    const b = expectOk("S1 claimer B", await noWait(s2, claim(s2, null, 5), "B must skip A's locked rows"));
    if (b.length !== 5) throw new Fail(`B should claim the other 5, claimed ${b.length} (rows skipped or shared)`);
    const overlap = ids(a).filter((x) => ids(b).includes(x));
    if (overlap.length > 0) throw new Fail(`claims overlap on ${overlap.length} row(s): both claimers hold ${overlap[0]}`);
    await s1.c.query("commit");
    await s2.c.query("commit");
    const states: Notice[] = [];
    for (const x of all) states.push(await notice(x)); // one at a time: the monitor is a single connection
    const sending = states.filter((n) => n.status === "sending");
    const tokens = new Set(sending.map((n) => n.lease_token));
    if (sending.length !== N || sending.some((n) => n.attempts !== 1) || tokens.size !== N) {
      throw new Fail(`expected ${N} rows sending, attempts 1, distinct tokens; got ${sending.length} / ${tokens.size} tokens`);
    }
    return `A and B claimed 5 + 5 = ${N} disjoint rows, B never waited`;
  });

  // ---- S1b four concurrent claimers (invariant) ----------------------------
  await scenario("S1b", "four concurrent claimers cover 12 rows disjointly", async () => {
    const N = 12;
    const all: string[] = [];
    for (let i = 0; i < N; i++) all.push(await mkNotice());
    const claimers = await Promise.all([1, 2, 3, 4].map((i) => actor(`S1b-${i}`)));
    for (const c of claimers) await begin(c, mode);
    const out = await Promise.all(claimers.map((c) => claim(c, null, 3)));
    for (const c of claimers) await c.c.query("commit");
    const got = out.map((o, i) => expectOk(`S1b claimer ${i + 1}`, o));
    const flat = got.flat().map((r) => r.id);
    if (new Set(flat).size !== flat.length) throw new Fail(`a row was claimed twice (${flat.length} claims, ${new Set(flat).size} distinct)`);
    if (flat.length !== N || !all.every((x) => flat.includes(x))) throw new Fail(`expected all ${N} rows claimed once, got ${flat.length}`);
    return `4 claimers x 3 = ${N} distinct rows`;
  });

  // ---- S2 inline vs sweeper on one row ------------------------------------
  await scenario("S2", "inline claim(id) vs sweeper on the same row: exactly one wins", async () => {
    // a) the sweeper holds the row open; the inline claim is skipped
    const r1 = await mkNotice();
    const [sw, inl] = [await actor("S2a-sweeper"), await actor("S2a-inline")];
    await begin(sw, mode);
    const won = expectOk("S2a sweeper", await claim(sw, null, 50));
    if (won.length !== 1 || won[0].id !== r1) throw new Fail(`S2a: sweeper should claim only ${r1}, claimed ${ids(won).join(",")}`);
    await assertLocked([r1], "the sweeper");
    await begin(inl, mode);
    const lost = expectOk("S2a inline", await noWait(inl, claim(inl, r1), "inline must skip the row the sweeper holds"));
    if (lost.length !== 0) throw new Fail("S2a: inline claim ALSO claimed the row the sweeper holds (double claim)");
    await sw.c.query("commit");
    await inl.c.query("commit");
    const n1 = await notice(r1);
    if (n1.status !== "sending" || n1.attempts !== 1 || n1.lease_token !== won[0].lease_token) {
      throw new Fail(`S2a: row should be the sweeper's attempt 1, got ${n1.status}/${n1.attempts}`);
    }
    await closeActors();

    // b) the inline path holds the row open; the sweeper is skipped
    const r2 = await mkNotice();
    const [inl2, sw2] = [await actor("S2b-inline"), await actor("S2b-sweeper")];
    await begin(inl2, mode);
    const won2 = expectOk("S2b inline", await claim(inl2, r2));
    if (won2.length !== 1) throw new Fail("S2b: inline claim of a pending row returned nothing");
    await assertLocked([r2], "the inline claim");
    await begin(sw2, mode);
    const lost2 = expectOk("S2b sweeper", await noWait(sw2, claim(sw2, null, 50), "sweeper must skip the row the inline path holds"));
    if (lost2.some((r) => r.id === r2)) throw new Fail("S2b: the sweeper ALSO claimed the row the inline path holds");
    await inl2.c.query("commit");
    await sw2.c.query("commit");
    if ((await notice(r2)).attempts !== 1) throw new Fail(`S2b: attempts should be 1, got ${(await notice(r2)).attempts}`);
    await closeActors();

    // c) committed first: a second claim of either kind finds a live lease
    const r3 = await mkNotice();
    const [c1, c2, c3] = [await actor("S2c-1"), await actor("S2c-2"), await actor("S2c-3")];
    await begin(c1, mode);
    expectOk("S2c first", await andEnd(c1, claim(c1, r3)));
    await begin(c2, mode);
    const x = expectOk("S2c second inline", await andEnd(c2, claim(c2, r3)));
    await begin(c3, mode);
    const y = expectOk("S2c sweeper", await andEnd(c3, claim(c3, null, 50)));
    if (x.length !== 0 || y.some((r) => r.id === r3)) throw new Fail("S2c: a live lease was claimed again");
    if ((await notice(r3)).attempts !== 1) throw new Fail("S2c: attempts moved");
    return "sweeper-first, inline-first and committed-first: one winner, attempts 1";
  });

  // concurrency-proof: finish_release_notice (S3: a finish with the OLD lease token is fenced - committed, and queued on the row the reclaim holds - while the newer attempt wins)
  // ---- S3 stale-lease finish is fenced ------------------------------------
  await scenario("S3", "stale-lease finish is fenced; the newer attempt wins", async () => {
    // a) committed order: attempt 1 claims, its lease lapses, attempt 2 reclaims;
    //    attempt 1's late finish changes nothing; attempt 2's finish lands.
    const r1 = await mkNotice();
    const [p1, p2, p3, p4] = [await actor("S3a-1"), await actor("S3a-2"), await actor("S3a-3"), await actor("S3a-4")];
    await begin(p1, mode);
    const t1 = expectOk("S3a claim 1", await andEnd(p1, claim(p1, r1)))[0];
    await expireLease(r1);
    await begin(p2, mode);
    const t2 = expectOk("S3a reclaim", await andEnd(p2, claim(p2, null, 50))).find((r) => r.id === r1);
    if (!t2 || t2.attempts !== 2 || t2.lease_token === t1.lease_token) throw new Fail("S3a: lapsed lease was not reclaimed with a new token");
    await begin(p3, mode);
    const stale = expectOk("S3a stale finish", await andEnd(p3, finish(p3, r1, t1.lease_token!, "sent", "sent")));
    if (stale.length !== 0) throw new Fail("S3a: a finish with the OLD token returned a row");
    const mid = await notice(r1);
    if (mid.status !== "sending" || mid.lease_token !== t2.lease_token || mid.attempts !== 2 || mid.email_state !== "todo") {
      throw new Fail(`S3a: the stale finish changed the row (${mid.status}, attempts ${mid.attempts}, email ${mid.email_state})`);
    }
    await begin(p4, mode);
    const fin = expectOk("S3a newer finish", await andEnd(p4, finish(p4, r1, t2.lease_token!, "sent", "sent")));
    if (fin.length !== 1 || fin[0].status !== "sent") throw new Fail("S3a: the newer attempt's finish did not land");
    await closeActors();

    // b) raced: the reclaim holds the row open; attempt 1's finish QUEUES on it,
    //    and must be fenced once the reclaim commits.
    const r2 = await mkNotice();
    const [q1, q2, q3] = [await actor("S3b-1"), await actor("S3b-2"), await actor("S3b-3")];
    await begin(q1, mode);
    const u1 = expectOk("S3b claim 1", await andEnd(q1, claim(q1, r2)))[0];
    await expireLease(r2);
    await begin(q2, mode);
    const u2 = expectOk("S3b reclaim", await claim(q2, null, 50)).find((r) => r.id === r2);
    if (!u2) throw new Fail("S3b: reclaim returned nothing");
    await begin(q3, mode);
    const late = andEnd(q3, finish(q3, r2, u1.lease_token!, "sent", "sent"));
    await mustWait(q3, "the old attempt's finish queues on the row the reclaim holds");
    await q2.c.query("commit");
    const lateOut = expectOk("S3b late finish", await late);
    if (lateOut.length !== 0) throw new Fail("S3b: the old attempt's finish overwrote the newer attempt");
    const end = await notice(r2);
    if (end.status !== "sending" || end.lease_token !== u2.lease_token || end.attempts !== 2 || end.email_state !== "todo") {
      throw new Fail(`S3b: the newer attempt was disturbed (${end.status}, attempts ${end.attempts}, email ${end.email_state})`);
    }
    return "old-token finish fenced (committed and queued behind the reclaim); newer attempt intact";
  });

  // concurrency-proof: retry_release_notice (S4: a manual retry never resets a row that holds a live lease - committed, and queued behind the claim that leases it)
  // ---- S4 retry vs a live sending lease -----------------------------------
  await scenario("S4", "manual retry vs a live sending lease is refused", async () => {
    // a) committed live lease
    const r1 = await mkNotice();
    const [a1, a2] = [await actor("S4a-claim"), await actor("S4a-retry")];
    await begin(a1, mode);
    const t = expectOk("S4a claim", await andEnd(a1, claim(a1, r1)))[0];
    await begin(a2, mode);
    const refused = expectOk("S4a retry", await andEnd(a2, retry(a2, r1)));
    const after = await notice(r1);
    if (refused !== false || after.status !== "sending" || after.lease_token !== t.lease_token || after.attempts !== 1) {
      throw new Fail(`S4a: retry touched a live lease (returned ${refused}; ${after.status}, attempts ${after.attempts})`);
    }
    await closeActors();

    // b) raced: the claim holds the (waiting) row open, the retry queues on it
    const r2 = await mkNotice({ status: "retry", attempts: 2 });
    const [b1, b2] = [await actor("S4b-claim"), await actor("S4b-retry")];
    await begin(b1, mode);
    const lease = expectOk("S4b claim", await claim(b1, r2))[0];
    if (!lease || lease.attempts !== 3) throw new Fail("S4b: the due retry row was not claimed");
    await begin(b2, mode);
    const r = andEnd(b2, retry(b2, r2));
    await mustWait(b2, "the retry queues on the row the claim holds");
    await b1.c.query("commit");
    const refused2 = expectOk("S4b retry", await r);
    const after2 = await notice(r2);
    if (refused2 !== false || after2.status !== "sending" || after2.lease_token !== lease.lease_token || after2.attempts !== 3) {
      throw new Fail(`S4b: the retry reset an in-flight attempt (returned ${refused2}; ${after2.status}, attempts ${after2.attempts}, token kept ${after2.lease_token === lease.lease_token})`);
    }
    await closeActors();

    // c) the plain case still works: an abandoned row is reset and becomes claimable
    const r3 = await mkNotice({ status: "abandoned", attempts: 6 });
    const [c1] = [await actor("S4c-retry")];
    await begin(c1, mode);
    const ok = expectOk("S4c retry", await andEnd(c1, retry(c1, r3)));
    const reset = await notice(r3);
    if (ok !== true || reset.status !== "retry" || reset.attempts !== 0 || reset.lease_token !== null) {
      throw new Fail(`S4c: an abandoned row was not reset (${ok}; ${reset.status}, attempts ${reset.attempts})`);
    }
    return "committed and raced retries refused on a live lease; an abandoned row resets";
  });

  // S5: the strict flag - OFF or a missing settings row means claim returns nothing (flag read by release_notices_enabled)
  // ---- S5 flag OFF ---------------------------------------------------------
  await scenario("S5", "flag OFF (or no settings row): claim returns nothing", async () => {
    const r1 = await mkNotice();
    const sx = await actor("S5-claim");
    try {
      await setFlag(false);
      await begin(sx, mode);
      const sweep = expectOk("S5 sweeper OFF", await claim(sx, null, 50));
      const inline = expectOk("S5 inline OFF", await claim(sx, r1));
      await sx.c.query("commit");
      if (sweep.length + inline.length > 0) throw new Fail(`claim returned ${sweep.length + inline.length} row(s) while the flag is OFF`);
      if ((await notice(r1)).status !== "pending") throw new Fail("an OFF claim changed the row");

      await monitor.query("delete from public.release_notice_settings");
      await begin(sx, mode);
      const gone = expectOk("S5 sweeper, no settings row", await claim(sx, null, 50));
      await sx.c.query("commit");
      if (gone.length > 0) throw new Fail("claim returned rows with NO settings row (the flag must fail closed)");
    } finally {
      await setFlag(true);
    }
    return "flag OFF and missing row both claim nothing";
  });
}

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  await monitor.query("begin");
  try {
    await monitor.query(
      `insert into public.patients (id, drm_id, first_name, last_name, birthdate)
       values ($1, $2, 'Rnp', 'Fixture', '1990-01-01')`,
      [fx.patient, `DRM-${TAG_UP}`],
    );
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php, notes)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0, $4)`,
      [fx.visit, `V-${TAG_UP}-1`, fx.patient, `${TAG} fixture`],
    );
    await monitor.query("commit");
  } catch (e) {
    await monitor.query("rollback").catch(() => undefined);
    throw e;
  }
}

// Remove every row of the runs whose tag starts with `like` ("rnp-" = every
// stale run, TAG = this run).
async function sweepTagged(like: string): Promise<void> {
  if (!/^rnp-[0-9a-f]{0,6}$/.test(like)) throw new Error(`refusing to sweep pattern ${like}`);
  const up = like.toUpperCase();
  await monitor.query("begin");
  try {
    await monitor.query(
      `delete from public.release_notices where visit_id in (select id from public.visits where visit_number like $1)`,
      [`V-${up}%`],
    );
    await monitor.query("delete from public.visits where visit_number like $1", [`V-${up}%`]);
    await monitor.query("delete from public.patients where drm_id like $1", [`DRM-${up}%`]);
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
    `select (select count(*) from public.patients where drm_id like $1)
          + (select count(*) from public.visits where visit_number like $2)
          + (select count(*) from public.release_notices
              where id = any($3::uuid[]) or visit_id in (select id from public.visits where visit_number like $2)) as n`,
    [`DRM-${up}%`, `V-${up}%`, made.notices],
  );
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// Control rounds (--control): prove the proof can fail
// ---------------------------------------------------------------------------
//
// Each mutant is a copy of the live functions with one guard removed, created in
// a throwaway schema (never public - other sessions keep calling the real
// functions). The named forced scenarios run against the copy, and the round
// PASSES only when every one of them fails in both plan modes.

type FnName = "release_notices_enabled" | "claim_release_notice" | "finish_release_notice" | "retry_release_notice";

interface Mutant {
  key: string;
  what: string;
  fn: FnName;
  edits: Array<[string, string]>;
  mustFail: string[];
}

const MUTANTS: Mutant[] = [
  {
    key: "M1",
    what: "claim without SKIP LOCKED (a claimer queues behind another's rows instead of skipping them)",
    fn: "claim_release_notice",
    edits: [["limit v_limit\n       for update skip locked", "limit v_limit\n       for update"]],
    mustFail: ["S1", "S2"],
  },
  {
    key: "M2",
    what: "claim without FOR UPDATE (no row lock at all: two claimers pick the same row)",
    fn: "claim_release_notice",
    edits: [["limit v_limit\n       for update skip locked", "limit v_limit"]],
    mustFail: ["S1", "S2"],
  },
  {
    key: "M3",
    what: "finish without the lease fence (any caller finishes a sending row)",
    fn: "finish_release_notice",
    edits: [["     and n.lease_token = p_lease_token\n     for update;", "     for update;"]],
    mustFail: ["S3"],
  },
  {
    key: "M4",
    what: "retry ignores the live lease (also resets a sending row)",
    fn: "retry_release_notice",
    edits: [
      [
        "     and n.status in ('abandoned', 'retry')\n     and (n.lease_expires_at is null or n.lease_expires_at <= clock_timestamp())",
        "     and n.status in ('abandoned', 'retry', 'sending')",
      ],
    ],
    mustFail: ["S4"],
  },
  {
    key: "M5",
    what: "claim ignores the flag (leases rows while the outbox is OFF)",
    fn: "claim_release_notice",
    edits: [["if not %SCHEMA%.release_notices_enabled() then", "if false then"]],
    mustFail: ["S5"],
  },
  {
    key: "M6",
    what: "finish takes no row lock (the fence is read, then written without re-checking)",
    fn: "finish_release_notice",
    edits: [["     and n.lease_token = p_lease_token\n     for update;", "     and n.lease_token = p_lease_token;"]],
    mustFail: ["S3"],
  },
];

const FN_SIGS: Record<FnName, string> = {
  release_notices_enabled: "",
  claim_release_notice: "uuid, integer",
  finish_release_notice: "uuid, uuid, text, text, text, text, text, text, text",
  retry_release_notice: "uuid",
};

async function controlRounds(): Promise<void> {
  const schema = `rnp_ctl_${TAG.slice(4)}`;
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

  const install = async (mutatedFn?: FnName, mutatedSql?: string) => {
    await monitor.query(`drop schema if exists ${schema} cascade`);
    await monitor.query(`create schema ${schema}`);
    for (const fn of names) await monitor.query(fn === mutatedFn ? mutatedSql! : defs[fn]);
    await monitor.query(`grant usage on schema ${schema} to service_role`);
    await monitor.query(`grant execute on all functions in schema ${schema} to service_role`);
  };

  // BASELINE round: an UNMUTATED copy must pass every scenario a mutant is
  // judged on. Otherwise a broken copy/grant/rewrite would make every mutant
  // look "caught".
  const baselineIds = [...new Set(MUTANTS.flatMap((m) => m.mustFail))];
  console.log("\ncontrol baseline: unmutated copy must pass " + baselineIds.join(", "));
  try {
    await install();
    const base: Result[] = [];
    sink = base;
    fnSchema = schema;
    only = baselineIds;
    for (const mode of ["seq", "indexed"] as Mode[]) await forcedScenarios(mode);
    const bad = base.filter((r) => !r.ok);
    const okBase = bad.length === 0 && base.length === baselineIds.length * 2;
    results.push({
      name: "control baseline (unmutated copy)",
      ok: okBase,
      detail: okBase ? `${base.length} scenario runs passed` : `${bad.map((r) => r.name + ": " + r.detail).join("; ") || "scenarios did not run"}`,
    });
    console.log(`  ${okBase ? "PASS" : "FAIL"}  control baseline - ${okBase ? base.length + " scenario runs passed" : "the unmutated copy fails; mutant results are meaningless"}`);
    if (!okBase) return;
  } finally {
    sink = results;
    only = null;
    fnSchema = "public";
    await monitor.query(`drop schema if exists ${schema} cascade`);
  }

  // A failure only counts as a catch when an assertion tripped. Setup /
  // permission / missing-object errors and "interleaving not reached" are
  // harness faults, not catches.
  const HARNESS = /interleaving not reached|did not answer|permission denied|does not exist|\bgot (42501|42883|42P01|3F000)\b/;

  for (const m of MUTANTS) {
    let mutated = defs[m.fn];
    for (const [rawFrom, to] of m.edits) {
      const from = rawFrom.split("%SCHEMA%").join(schema);
      if (!mutated.includes(from)) throw new Error(`control ${m.key}: ${JSON.stringify(from)} not found in ${m.fn}`);
      mutated = mutated.replace(from, () => to);
    }
    try {
      await install(m.fn, mutated);

      console.log(`\ncontrol ${m.key}: ${m.what}`);
      const caught: Result[] = [];
      sink = caught;
      fnSchema = schema;
      only = m.mustFail;
      for (const mode of ["seq", "indexed"] as Mode[]) await forcedScenarios(mode);
      const failedIds = caught.filter((r) => !r.ok && !HARNESS.test(r.detail)).map((r) => r.name);
      const harness = caught.filter((r) => !r.ok && HARNESS.test(r.detail)).map((r) => `${r.name}: ${r.detail}`);
      const missed = (["seq", "indexed"] as Mode[]).flatMap((mode) =>
        m.mustFail
          .filter((id) => !failedIds.some((n) => n.startsWith(`[${mode}] ${id} `)))
          .map((id) => `[${mode}] ${id}`),
      );
      const ok = missed.length === 0 && harness.length === 0;
      const detail = ok
        ? `caught by ${failedIds.length} scenario run(s)`
        : harness.length
          ? `HARNESS FAULT (not a catch): ${harness.join("; ")}`
          : `NOT caught by ${missed.join(", ")}`;
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

let flagBefore: boolean | null = null; // null = no settings row existed

async function restoreFlag(): Promise<void> {
  if (flagBefore === null) await monitor.query("delete from public.release_notice_settings").catch(() => undefined);
  else await setFlag(flagBefore).catch(() => undefined);
}

async function teardown(): Promise<void> {
  await closeActors();
  await monitor.query(`drop schema if exists rnp_ctl_${TAG.slice(4)} cascade`);
  await sweepTagged(TAG);
  await restoreFlag();
  const left = await countTagged(TAG);
  if (left > 0) {
    results.push({ name: "teardown", ok: false, detail: `${left} fixture rows left behind` });
    console.log(`  FAIL  teardown - ${left} fixture rows left behind`);
  } else {
    console.log("  teardown: every fixture row removed (0 left); flag restored");
  }
}

async function main(): Promise<void> {
  monitor = await connect();

  // One run at a time on the shared stack: the startup sweep removes EVERY rnp-
  // fixture, which would pull a concurrent run's live rows out from under it.
  const { rows: lock } = await monitor.query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtext('release-notice:concurrency-proof')) as got",
  );
  if (!lock[0].got) {
    console.error("[release-notice:concurrency-proof] another run is in progress on this stack - try again when it finishes.");
    await monitor.end();
    process.exit(3);
  }

  let seeded = false;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      console.log(`\n  ${sig} received - tearing down`);
      teardown()
        .catch((e) => console.error(e))
        .finally(() => process.exit(code));
    });
  }
  try {
    const { rows: fn } = await monitor.query<{ ok: boolean }>(
      `select to_regprocedure('public.claim_release_notice(uuid,integer)') is not null
          and to_regprocedure('public.finish_release_notice(uuid,uuid,text,text,text,text,text,text,text)') is not null
          and to_regprocedure('public.retry_release_notice(uuid)') is not null
          and to_regclass('public.release_notices') is not null as ok`,
    );
    if (!fn[0].ok) throw new Error("0210 is not applied to the local stack");

    // A crashed earlier run may have left the flag ON; its fixtures give it away.
    const stale = await countTagged("rnp-");
    await sweepTagged("rnp-");
    // Control-round schemas a crashed run left behind (always rnp_ctl_<hex>).
    const { rows: schemas } = await monitor.query<{ n: string }>(
      "select nspname as n from pg_namespace where nspname ~ '^rnp_ctl_[0-9a-f]{6}$'",
    );
    for (const { n } of schemas) await monitor.query(`drop schema ${n} cascade`);

    const { rows: cur } = await monitor.query<{ enabled: boolean }>("select enabled from public.release_notice_settings");
    flagBefore = stale > 0 ? false : cur.length ? cur[0].enabled : null;

    // The scenarios claim from the whole table: a foreign due row (someone's own
    // fixtures) would change every count. Refuse rather than guess.
    const { rows: foreign } = await monitor.query<{ n: string }>(
      "select count(*) as n from public.release_notices where status in ('pending', 'retry', 'sending')",
    );
    if (Number(foreign[0].n) > 0) {
      throw new Error(`release_notices holds ${foreign[0].n} open row(s) that are not this run's: clear them, or run on an empty table`);
    }

    console.log(`release-notice concurrency proof - fixtures tagged ${TAG}`);
    await seed();
    seeded = true;

    for (const mode of ["seq", "indexed"] as Mode[]) await forcedScenarios(mode);
    if (process.argv.includes("--control")) await controlRounds();
  } finally {
    if (seeded || (await countTagged(TAG)) > 0) await teardown();
    else {
      await closeActors();
      await restoreFlag();
    }
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
