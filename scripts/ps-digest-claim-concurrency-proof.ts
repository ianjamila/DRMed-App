// Hand-run local CONCURRENCY proof for the Patient Sources owner-email claim
// (supabase/migrations/0213_patient_sources_digest.sql): public._ps_digest_claim.
//
// supabase/tests/0213_patient_sources_digest_smoke.sql proves each claim state one
// statement after another. This runner proves the same function when two or more
// cron invocations claim the SAME recipient/period AT THE SAME MOMENT: separate `pg`
// connections, each acting as service_role (the role the cron uses).
//
// DETERMINISTIC, NOT LUCKY. Forced scenarios hold one side's claim in an open
// transaction, start the other, and do not move on until pg_locks shows that
// backend waiting on a row lock. If the interleaving is not reached the scenario
// FAILS — it never degrades into a sequential run. Only C (free races) relies on timing.
//
// Scenarios: A fresh row (second claim waits on the uncommitted insert, then loses) ·
// B failed row (second claim waits on the row lock, then loses; attempts +1 once) ·
// C free races on a failed row (exactly one winner of 4) · D stale 'sending' row
// (nobody claims; flipped to unknown exactly once) · E include_unknown race (one winner).
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows),
// tagged psd-<hex>, swept at start, deleted in finally and then counted.
//
// Run (isolated or local stack, 0213 applied):
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:56422/postgres \
//     npm run ps-digest-claim:concurrency-proof [-- --control]
//   PSD_ROUNDS=100 npm run ps-digest-claim:concurrency-proof
//
// --control proves the proof can fail: it copies the live function into a throwaway
// schema with ONE guard removed and passes only if the named scenarios FAIL:
//   M1 drops the `where ds.status = 'failed' …` guard (A, B, C, E must fail)
//   M2 makes the stale window 15 years, i.e. no stale flip (D must fail)
//
// concurrency-proof: _ps_digest_claim (scenarios A–E and both mutants race the real claim)
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

requireLocalOrExplicitProd("ps-digest-claim:concurrency-proof", {
  writes:
    "throwaway rows in public.patient_sources_digest_sends tagged psd-<hex>, committed so two connections can race on them, then deleted",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// This script COMMITS rows, so it must never run against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[ps-digest-claim:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const TAG = `psd-${randomBytes(3).toString("hex")}`;
const KEY = "patient_sources_weekly";
const FROM = "2090-01-05";
const TO = "2090-01-11";
const ROUNDS = Number(process.env.PSD_ROUNDS ?? 25);
const CONTROL = process.argv.includes("--control");
const who = (n: string) => `${TAG}-${n}@example.test`;

let fnSchema = "public";
let monitor: Client;
const open: Client[] = [];

/** End every connection except the monitor (rolling back anything still open). */
async function closeRacers(): Promise<void> {
  for (const c of open.splice(0)) {
    if (c === monitor) continue;
    await c.query("rollback").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
  open.push(monitor);
}

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  open.push(c);
  return c;
}
async function backendPid(c: Client): Promise<number> {
  return (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}
/** begin + act as service_role, like the cron's admin client. */
async function prepare(c: Client): Promise<void> {
  await c.query("begin");
  await c.query("set local role service_role");
}
function claimQuery(c: Client, recipient: string, includeUnknown: boolean) {
  return c.query<{ n: number | null }>(
    `select ${fnSchema}._ps_digest_claim($1, $2::date, $3::date, $4, $5) as n`,
    [KEY, FROM, TO, recipient, includeUnknown],
  );
}
/** One racer: claim, then end its own transaction the moment its own call answers. */
async function racer(c: Client, recipient: string, includeUnknown: boolean): Promise<number | null> {
  await prepare(c);
  const n = (await claimQuery(c, recipient, includeUnknown)).rows[0]!.n;
  await c.query("commit");
  return n === null ? null : Number(n);
}
async function mustWait(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rowCount } = await monitor.query(
      "select 1 from pg_locks where pid = $1 and not granted and locktype in ('transactionid', 'tuple')",
      [pid],
    );
    if (rowCount) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label}: the second claim never waited on the first (interleaving not reached)`);
}
async function put(recipient: string, status: string, ageMinutes = 0, attempts = 1): Promise<void> {
  await monitor.query(
    `insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status, attempts, updated_at)
     values ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7))
     on conflict (alert_key, period_from, recipient) do update
       set status = excluded.status, attempts = excluded.attempts, updated_at = excluded.updated_at, last_error = null`,
    [KEY, FROM, TO, recipient, status, attempts, ageMinutes],
  );
}
async function rowOf(recipient: string) {
  const { rows } = await monitor.query<{ status: string; attempts: number }>(
    "select status, attempts from public.patient_sources_digest_sends where alert_key = $1 and period_from = $2 and recipient = $3",
    [KEY, FROM, recipient],
  );
  return rows[0] ?? null;
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

type Scenario = () => Promise<void>;

const scenarios: Record<string, Scenario> = {
  // concurrency-proof: _ps_digest_claim
  // A — fresh row: the loser blocks on the winner's uncommitted INSERT, then finds it taken.
  async A() {
    const r = who("a");
    const [s1, s2] = [await connect(), await connect()];
    await prepare(s1);
    const n1 = (await claimQuery(s1, r, false)).rows[0]!.n;
    await prepare(s2);
    const pid2 = await backendPid(s2); // before the blocking call: the same client cannot run a second query while it waits
    const p2 = claimQuery(s2, r, false);
    await mustWait(pid2, "A");
    await s1.query("commit");
    const n2 = (await p2).rows[0]!.n;
    await s2.query("commit");
    expect(Number(n1) === 1 && n2 === null, `A: expected winner 1 / loser null, got ${n1} / ${n2}`);
    const row = await rowOf(r);
    expect(row?.status === "sending" && row.attempts === 1, `A: row ${JSON.stringify(row)}`);
  },
  // B — failed row: both want to re-claim; one wins, attempts goes up exactly once.
  async B() {
    const r = who("b");
    await put(r, "failed");
    const [s1, s2] = [await connect(), await connect()];
    await prepare(s1);
    const n1 = (await claimQuery(s1, r, false)).rows[0]!.n;
    await prepare(s2);
    const pid2 = await backendPid(s2); // before the blocking call: the same client cannot run a second query while it waits
    const p2 = claimQuery(s2, r, false);
    await mustWait(pid2, "B");
    await s1.query("commit");
    const n2 = (await p2).rows[0]!.n;
    await s2.query("commit");
    expect(Number(n1) === 2 && n2 === null, `B: expected winner 2 / loser null, got ${n1} / ${n2}`);
    const row = await rowOf(r);
    expect(row?.status === "sending" && row.attempts === 2, `B: row ${JSON.stringify(row)}`);
  },
  // C — free race of four claimers on a failed row, ROUNDS times: exactly one winner.
  async C() {
    const r = who("c");
    for (let i = 0; i < ROUNDS; i++) {
      await put(r, "failed");
      const conns = await Promise.all([connect(), connect(), connect(), connect()]);
      const out = await Promise.all(conns.map((c) => racer(c, r, false)));
      const winners = out.filter((n) => n !== null);
      expect(winners.length === 1 && winners[0] === 2, `C round ${i}: outcomes ${JSON.stringify(out)}`);
      const row = await rowOf(r);
      expect(row?.attempts === 2 && row.status === "sending", `C round ${i}: row ${JSON.stringify(row)}`);
      await closeRacers();
    }
  },
  // D — stale 'sending' row: nobody may claim it; it flips to unknown exactly once.
  async D() {
    const r = who("d");
    for (let i = 0; i < ROUNDS; i++) {
      await put(r, "sending", 20);
      const conns = await Promise.all([connect(), connect()]);
      const out = await Promise.all(conns.map((c) => racer(c, r, false)));
      expect(out.every((n) => n === null), `D round ${i}: a stale sending row was claimed ${JSON.stringify(out)}`);
      const row = await rowOf(r);
      expect(row?.status === "unknown" && row.attempts === 1, `D round ${i}: row ${JSON.stringify(row)}`);
      await closeRacers();
    }
  },
  // E — operator retry with include_unknown while the cron also runs: one winner.
  async E() {
    const r = who("e");
    for (let i = 0; i < ROUNDS; i++) {
      await put(r, "unknown");
      const conns = await Promise.all([connect(), connect(), connect()]);
      const out = await Promise.all(conns.map((c) => racer(c, r, true)));
      const winners = out.filter((n) => n !== null);
      expect(winners.length === 1 && winners[0] === 2, `E round ${i}: outcomes ${JSON.stringify(out)}`);
      await closeRacers();
    }
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

const MUTANTS: Array<{ id: string; note: string; from: string; to: string; mustFail: string[] }> = [
  {
    id: "M1",
    note: "claim guard removed (any conflicting row is taken over)",
    from: "where ds.status = 'failed' or (p_include_unknown and ds.status = 'unknown')",
    to: "",
    mustFail: ["A", "B", "C", "E"],
  },
  { id: "M2", note: "no stale flip (15 years)", from: "interval '15 minutes'", to: "interval '15 years'", mustFail: ["D"] },
];

async function makeMutant(schema: string, m: (typeof MUTANTS)[number]): Promise<void> {
  const def = (
    await monitor.query<{ d: string }>(
      "select pg_get_functiondef('public._ps_digest_claim(text,date,date,text,boolean)'::regprocedure) as d",
    )
  ).rows[0]!.d;
  if (!def.includes(m.from)) throw new Error(`${m.id}: the live function no longer contains «${m.from}» — update MUTANTS`);
  const body = def.replace("public._ps_digest_claim", `${schema}._ps_digest_claim`).replace(m.from, m.to);
  await monitor.query(`create schema ${schema}`);
  await monitor.query(body);
  await monitor.query(`grant usage on schema ${schema} to service_role`);
  await monitor.query(`grant execute on function ${schema}._ps_digest_claim(text,date,date,text,boolean) to service_role`);
}

async function sweep(): Promise<void> {
  await monitor.query("delete from public.patient_sources_digest_sends where recipient like 'psd-%@example.test'");
  const { rows } = await monitor.query<{ nspname: string }>("select nspname from pg_namespace where nspname like 'psd_ctl_%'");
  for (const r of rows) await monitor.query(`drop schema ${r.nspname} cascade`);
}

async function main(): Promise<void> {
  monitor = await connect();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('ps-digest-claim:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("another ps-digest-claim concurrency proof is running — exiting");
    process.exit(2);
  }
  let exit = 0;
  const cleanup = async () => {
    await closeRacers();
    await sweep().catch(() => undefined);
    const left = await monitor.query("select 1 from public.patient_sources_digest_sends where recipient like $1", [`${TAG}%`]).catch(() => null);
    if (left?.rowCount) {
      console.error(`FAIL: ${left.rowCount} tagged rows left behind`);
      exit = 1;
    }
  };
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
  try {
    await sweep();
    console.log(`Plan: ${(await monitor.query<{ v: string }>("select version() as v")).rows[0]!.v}`);
    console.log(`Real function (public), ${ROUNDS} free-race rounds:`);
    const real = await runAll();
    const failed = Object.entries(real).filter(([, e]) => e !== null);
    console.log(`${Object.keys(real).length - failed.length}/${Object.keys(real).length} scenarios passed.`);
    if (failed.length > 0) exit = 1;

    if (CONTROL) {
      for (const m of MUTANTS) {
        const schema = `psd_ctl_${randomBytes(3).toString("hex")}`;
        console.log(`Control ${m.id}: ${m.note}`);
        await makeMutant(schema, m);
        fnSchema = schema;
        const res = await runAll();
        fnSchema = "public";
        const survived = m.mustFail.filter((s) => res[s] === null);
        if (survived.length > 0) {
          console.log(`  CONTROL FAIL ${m.id}: scenarios ${survived.join(", ")} still passed against the mutant — the proof cannot catch this bug`);
          exit = 1;
        } else console.log(`  control ${m.id} ok: ${m.mustFail.join(", ")} all failed against the mutant`);
        await monitor.query(`drop schema ${schema} cascade`);
      }
    }
  } finally {
    await cleanup();
    await monitor.query("select pg_advisory_unlock(hashtext('ps-digest-claim:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
