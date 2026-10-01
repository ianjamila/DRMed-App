// Hand-run local CONCURRENCY proof for the consolidated-panel claim functions
// (supabase/migrations/0191_claim_panel_members.sql, P0077):
// claim_panel_members / unclaim_panel_members.
//
// supabase/tests/0191_claim_panel_members_smoke.sql proves every refusal one
// statement after another, inside one transaction. This runner proves the
// same functions when two staff sessions act on the same panel AT THE SAME
// MOMENT: separate `pg` connections, each acting as `authenticated` with its
// own JWT `sub` (invoker rights, so RLS and 0190's holder guard apply exactly
// as for the staff server client).
//
// DETERMINISTIC, NOT LUCKY. Every forced scenario holds one side's row locks
// in an open transaction, starts the other side, and does not move on until
// pg_stat_activity shows that backend waiting on a Lock (or, for the "must not
// wait" cases, until it has answered while the first side is still open). If
// the intended interleaving is not reached the scenario FAILS — it never
// silently degrades into a sequential run. Only section F (free races) relies
// on timing, and it asserts the invariant alone.
//
// TWO PLAN SHAPES. Lock order is whatever order the UPDATE visits rows in, and
// that is the planner's choice. The local stack holds a handful of
// test_requests, so it seq-scans them (physical order). Prod (read-only
// EXPLAIN, 2026-09-30) drives BOTH functions' UPDATEs off
// idx_test_requests_status — one shared order for every caller, whatever
// order the caller's array is in. Every scenario therefore runs twice: "seq"
// (the local default) and "indexed" (enable_seqscan / enable_bitmapscan off
// in each actor's transaction — locally that yields the pkey scan for the
// claim, and for the unclaim a nested loop whose OUTER side is an index scan
// of test_requests (status or assigned_to), never the array). B4 and D3
// re-check that shape before they run and fail loudly if it changes.
// The plan each mode produced is printed first. The opposite-order scenarios
// (B4, D3) would deadlock (40P01 — still all-or-nothing, but a retry message
// instead of P0077) under a plan that locked in ARRAY order; none of these
// plans does.
//
// FIXTURES. Two connections cannot see each other's uncommitted rows, so —
// unlike the other *-db-proof scripts — the fixtures are COMMITTED: five staff
// (auth.users + staff_profiles), one report group with three chemistry
// services, one patient, three visits (panels P, Q, R of three tests each).
// Every row carries a per-run tag (`pcc-<hex>` / `PCC-<HEX>`), stale rows from
// a crashed run are swept before seeding, and the `finally` deletes
// everything and then proves nothing tagged is left. It never touches rows it
// did not mint (the shared local stack also holds other sessions' fixtures).
//
// Run (local stack, 0191 applied):
//   npm run panel-claim:concurrency-proof               # 2 modes, 25 free-race rounds
//   npm run panel-claim:concurrency-proof -- --control  # + control rounds
//   PCC_ROUNDS=100 npm run panel-claim:concurrency-proof
//
// CONTROL ROUNDS (--control) prove the proof can fail: each copies the live
// functions into a throwaway schema with one guard removed (never touching
// public — other sessions share this stack), reruns the forced scenarios
// against the copy, and passes only if the named scenarios FAIL in both
// modes (see MUTANTS): A drops the all-or-nothing count check (the pre-0191
// split — A3 sees the panel claim keep 2 of 3), B drops the expected-holder
// match (C1 hands back a reassigned member), C drops deleted_at (E1).
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";

requireLocalOrExplicitProd("panel-claim:concurrency-proof", {
  writes:
    "throwaway fixtures tagged pcc-<hex> (staff, services, a patient, visits, tests), committed so two connections can race on them, then deleted",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Belt-and-suspenders on top of the guard above: this script COMMITS rows, so
// it must never run against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(
    `[panel-claim:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script commits fixtures and only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = `pcc-${randomBytes(3).toString("hex")}`;
const TAG_UP = TAG.toUpperCase();

// Three member ids per panel, sorted so m[0] < m[1] < m[2] in uuid order
// (lowercase hex compares like Postgres's bytewise uuid compare). The
// partial-progress scenarios depend on knowing which member an id-ordered
// scan reaches last.
function panelIds(): [string, string, string] {
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  return [ids[0], ids[1], ids[2]];
}

const fx = {
  med1: randomUUID(),
  med2: randomUUID(),
  med3: randomUUID(),
  admin1: randomUUID(),
  admin2: randomUUID(),
  group: randomUUID(),
  services: [randomUUID(), randomUUID(), randomUUID()],
  patient: randomUUID(),
  visits: { P: randomUUID(), Q: randomUUID(), R: randomUUID() },
  P: panelIds(),
  Q: panelIds(),
  R: panelIds(),
};
const ALL_TESTS = [...fx.P, ...fx.Q, ...fx.R];

const NAMES: Record<string, string> = {
  [fx.med1]: "M1",
  [fx.med2]: "M2",
  [fx.med3]: "M3",
  [fx.admin1]: "A1",
  [fx.admin2]: "A2",
};

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type Mode = "seq" | "indexed";

// Where the functions under test live: public, or a --control mutant schema.
let fnSchema = "public";

interface Actor {
  name: string;
  uid: string | null; // null = service_role (the queue Delete's admin client)
  c: Client;
  pid: number;
}

let monitor: Client; // postgres; seeds, resets, reads committed state, watches waits
const open: Actor[] = [];

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  // A forced wait that never resolves must fail the run, not hang it.
  await c.query("set statement_timeout = '20s'");
  return c;
}

// A fresh connection per actor per scenario: plpgsql caches its statement
// plans per session, so reusing a connection across modes would keep the
// first mode's plan.
async function actor(name: string, uid: string | null): Promise<Actor> {
  const c = await connect();
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  const a = { name, uid, c, pid: rows[0].pid };
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

// BEGIN as a staff member (JWT sub, role authenticated), or as service_role.
async function begin(a: Actor, mode: Mode): Promise<void> {
  await a.c.query("begin");
  if (a.uid) {
    await a.c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: a.uid, role: "authenticated" }),
    ]);
    await a.c.query("set local role authenticated");
  } else {
    await a.c.query("set local role service_role");
  }
  for (const g of MODE_GUCS[mode]) await a.c.query(g);
}

// ---------------------------------------------------------------------------
// The writes, exactly as the app issues them
// ---------------------------------------------------------------------------

type Outcome = { ok: true; n: number } | { ok: false; code: string; message: string };

async function settle(p: Promise<QueryResult>, count: (r: QueryResult) => number): Promise<Outcome> {
  try {
    const r = await p;
    return { ok: true, n: count(r) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "?", message: err.message ?? String(e) };
  }
}

// concurrency-proof: claim_panel_members
// claimPanelMembers → rpc("claim_panel_members")
function claim(a: Actor, ids: readonly string[]): Promise<Outcome> {
  return settle(
    a.c.query(`select ${fnSchema}.claim_panel_members($1::uuid[]) as n`, [ids]),
    (r) => Number(r.rows[0].n),
  );
}

// concurrency-proof: unclaim_panel_members
// unclaimPanelMembers → rpc("unclaim_panel_members")
function unclaim(a: Actor, ids: readonly string[], holders: readonly string[]): Promise<Outcome> {
  return settle(
    a.c.query(`select ${fnSchema}.unclaim_panel_members($1::uuid[], $2::uuid[]) as n`, [ids, holders]),
    (r) => Number(r.rows[0].n),
  );
}

// claimTestAction's single-row UPDATE (queue/actions.ts).
function claimOne(a: Actor, id: string): Promise<Outcome> {
  return settle(
    a.c.query(
      `update public.test_requests
          set status = 'in_progress', assigned_to = $2, started_at = now()
        where id = $1 and status = 'requested' and deleted_at is null
        returning id`,
      [id, a.uid],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// reassignTestAction's UPDATE (queue/actions.ts) — one member, admin only.
function reassign(a: Actor, id: string, to: string): Promise<Outcome> {
  return settle(
    a.c.query(
      `update public.test_requests
          set assigned_to = $2
        where id = $1 and status in ('in_progress', 'result_uploaded') and deleted_at is null
        returning id`,
      [id, to],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// The UPDATE deleteTestRequestsManyCore issues per visit (via
// deleteTestRequestsForVisit, lib/actions/queue/bulk-delete-core.ts), through
// the service-role admin client.
function queueDelete(a: Actor, ids: readonly string[], visitId: string): Promise<Outcome> {
  return settle(
    a.c.query(
      `update public.test_requests
          set deleted_at = now(), deleted_by = $3, delete_reason = $4
        where id = any($1::uuid[]) and visit_id = $2 and deleted_at is null
        returning id`,
      [ids, visitId, fx.admin1, `${TAG} concurrency proof`],
    ),
    (r) => r.rowCount ?? 0,
  );
}

// Commit on success, roll back on refusal — the moment the call answers, the
// way PostgREST ends each RPC's transaction. Racers must never wait for each
// other's answers before ending their own: the loser is queued behind the
// winner's still-open transaction.
function andEnd(a: Actor, p: Promise<Outcome>): Promise<Outcome> {
  // Never rejects: a scenario that throws early closes its connections while
  // these are still pending, and an unhandled rejection there would kill the
  // process before the fixtures are torn down. A failed COMMIT still surfaces
  // — as a failed outcome the scenario's assertions reject.
  return p.then(async (o) => {
    try {
      await a.c.query(o.ok ? "commit" : "rollback");
      return o;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code ?? "end-failed", message: err.message ?? String(e) };
    }
  });
}

// ---------------------------------------------------------------------------
// Interleaving control
// ---------------------------------------------------------------------------

class Fail extends Error {}

// Waiting on a ROW: an ungranted transactionid (queued behind the holder's
// transaction) or tuple lock. A relation-level wait — another session's DDL
// on the shared stack — does not count, so it can neither fake a forced
// interleaving nor fail a "must not wait" case.
async function waitingOnLock(pid: number): Promise<boolean> {
  const { rows } = await monitor.query(
    "select 1 from pg_locks where pid = $1 and not granted and locktype in ('transactionid', 'tuple')",
    [pid],
  );
  return rows.length > 0;
}

// B4/D3 release two opposite-order callers at once. That only resolves to
// one winner + P0077 while both functions lock rows in ONE order whatever
// the array order is; a plan driven by the array (the unnest Function Scan
// as the nested loop's OUTER side) would deadlock instead. Refuse to run
// them — loudly — if this mode's plan has become that shape.
async function assertLockOrderIndependentOfArray(mode: Mode): Promise<void> {
  await monitor.query("begin");
  try {
    for (const g of MODE_GUCS[mode]) await monitor.query(g);
    const { rows } = await monitor.query(
      `explain (costs off) update public.test_requests t set status = 'requested'
         from unnest($1::uuid[], $2::uuid[]) as x(id, holder)
        where t.id = x.id and t.status = 'in_progress' and t.assigned_to = x.holder and t.deleted_at is null`,
      [fx.P, x3(fx.med1)],
    );
    const lines = rows.map((r) => String(r["QUERY PLAN"]));
    const fnAt = lines.findIndex((l) => l.includes("Function Scan on x"));
    const tAt = lines.findIndex((l) => / on test_requests t\b/.test(l) && /Scan/.test(l));
    if (fnAt === -1 || tAt === -1 || fnAt < tAt) {
      throw new Fail(`plan shape changed: the unclaim now locks in ARRAY order (${lines.map((l) => l.trim()).join(" / ")}) — opposite-order callers can deadlock (40P01); see the header`);
    }
  } finally {
    await monitor.query("rollback");
  }
}

// Strict: the actor's in-flight statement must be observed blocked on a
// heavyweight lock within ~5s, or the interleaving was not achieved.
async function mustWait(a: Actor, why: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await waitingOnLock(a.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Fail(`interleaving not reached: ${a.name} never waited on a lock (${why})`);
}

// The opposite: the call must answer while the other side is still open,
// without ever blocking on a lock.
async function mustNotWait(a: Actor, p: Promise<Outcome>, why: string): Promise<Outcome> {
  let done = false;
  const tracked = p.then((o) => {
    done = true;
    return o;
  });
  for (let i = 0; i < 50 && !done; i++) {
    if (!done && (await waitingOnLock(a.pid))) {
      throw new Fail(`${a.name} blocked on a lock but should have answered at once (${why})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!done) throw new Fail(`${a.name} did not answer within 5s (${why})`);
  return tracked;
}

// Which of `ids` are row-locked by someone else right now (FOR UPDATE SKIP
// LOCKED from a throwaway transaction, rolled back at once).
async function lockedBySomeoneElse(ids: readonly string[]): Promise<string[]> {
  const c = await connect();
  try {
    await c.query("begin");
    const { rows } = await c.query<{ id: string }>(
      "select id from public.test_requests where id = any($1::uuid[]) for update skip locked",
      [ids],
    );
    await c.query("rollback");
    const free = new Set(rows.map((r) => r.id));
    return ids.filter((id) => !free.has(id));
  } finally {
    await c.end();
  }
}

// An outside transaction (as postgres) holding FOR UPDATE on rows, so several
// actors can be lined up behind it and released at the same instant.
async function holdRows(ids: readonly string[]): Promise<Client> {
  const c = await connect();
  await c.query("begin");
  await c.query("select id from public.test_requests where id = any($1::uuid[]) for update", [ids]);
  return c;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Reset members to a known committed state (as postgres). holder null =
// requested + unassigned; otherwise in_progress under that holder.
async function setState(ids: readonly string[], holder: string | null): Promise<void> {
  await monitor.query(
    `update public.test_requests
        set status = $2, assigned_to = $3, started_at = $4,
            deleted_at = null, deleted_by = null, delete_reason = null
      where id = any($1::uuid[])`,
    [ids, holder ? "in_progress" : "requested", holder, holder ? new Date() : null],
  );
}

async function resetAll(): Promise<void> {
  await setState(ALL_TESTS, null);
}

// "st:holder" per member, in the order given: `req:-`, `ip:M1`, `del:…`.
async function stateOf(ids: readonly string[]): Promise<string[]> {
  const { rows } = await monitor.query<{
    id: string;
    status: string;
    assigned_to: string | null;
    deleted_at: Date | null;
    started_at: Date | null;
  }>(
    "select id, status, assigned_to, deleted_at, started_at from public.test_requests where id = any($1::uuid[])",
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return "missing";
    const st = r.status === "requested" ? "req" : r.status === "in_progress" ? "ip" : r.status;
    const who = r.assigned_to ? (NAMES[r.assigned_to] ?? "??") : "-";
    // A requested row must never carry a holder or a start time — that is the
    // orphan a lost race would leave behind.
    const orphan = r.status === "requested" && (r.assigned_to || r.started_at) ? "!orphan" : "";
    return `${r.deleted_at ? "del/" : ""}${st}:${who}${orphan}`;
  });
}

async function expectState(label: string, ids: readonly string[], want: string[]): Promise<void> {
  const got = await stateOf(ids);
  if (got.join(",") !== want.join(",")) {
    throw new Fail(`${label}: expected [${want.join(",")}], got [${got.join(",")}]`);
  }
}

// Never split: every live member shares one (status, holder).
async function expectWhole(label: string, ids: readonly string[]): Promise<string> {
  const got = await stateOf(ids);
  if (new Set(got).size !== 1) throw new Fail(`${label}: SPLIT panel [${got.join(",")}]`);
  return got[0];
}

function expectOk(label: string, o: Outcome, n: number): void {
  if (!o.ok) throw new Fail(`${label}: expected success (${n}), got ${o.code} ${o.message}`);
  if (o.n !== n) throw new Fail(`${label}: expected ${n} rows, got ${o.n}`);
}

function expectCode(label: string, o: Outcome, code: string): void {
  if (o.ok) throw new Fail(`${label}: expected ${code}, but it succeeded (${o.n})`);
  if (o.code !== code) throw new Fail(`${label}: expected ${code}, got ${o.code} ${o.message}`);
}

const x3 = (s: string) => [s, s, s];
const rev = <T>(xs: readonly T[]) => [...xs].reverse();

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

async function scenario(name: string, body: () => Promise<string | void>): Promise<void> {
  await resetAll();
  try {
    const note = await body();
    sink.push({ name, ok: true, detail: note ?? "" });
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    sink.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name} — ${detail}`);
  } finally {
    await closeActors();
  }
}

async function forcedScenarios(mode: Mode): Promise<void> {
  const { P, Q, R } = fx;
  const [p0, p1, p2] = P;
  const s = (n: string) => `[${mode}] ${n}`;

  // --- A. claim vs claim -----------------------------------------------------
  await scenario(s("A1 claim vs claim, first commits → second P0077, panel whole under first"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 claim", await claim(a, P), 3);
    await begin(b, mode);
    const pb = claim(b, P);
    await mustWait(b, "M2 queues behind M1's row locks");
    await a.c.query("commit");
    expectCode("M2 claim", await pb, "P0077");
    await b.c.query("rollback");
    await expectState("after", P, x3("ip:M1"));
  });

  await scenario(s("A2 claim vs claim, first rolls back → second claims all three"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 claim", await claim(a, P), 3);
    await begin(b, mode);
    const pb = claim(b, P);
    await mustWait(b, "M2 queues behind M1's row locks");
    await a.c.query("rollback");
    expectOk("M2 claim", await pb, 3);
    await b.c.query("commit");
    await expectState("after", P, x3("ip:M2"));
  });

  // The pre-0191 split: the panel claim has already taken some members when
  // it reaches one a single-test claim holds.
  await scenario(s("A3 single claim vs panel claim, single commits → panel claim rolls back its partial work"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 single claim of the last member", await claimOne(a, p2), 1);
    await begin(b, mode);
    const pb = claim(b, P);
    await mustWait(b, "M2's panel claim reaches the member M1 holds");
    const held = await lockedBySomeoneElse([p0, p1]);
    // Indexed (prod) plan: keys are scanned in id order, so M2 has provably
    // locked the other two members before blocking on the last one.
    if (mode === "indexed" && held.length !== 2) {
      throw new Fail(`interleaving not reached: M2 held ${held.length}/2 earlier members while blocked`);
    }
    await a.c.query("commit");
    expectCode("M2 panel claim", await pb, "P0077");
    await b.c.query("rollback");
    await expectState("after", P, ["req:-", "req:-", "ip:M1"]);
    return `M2 held ${held.length}/2 other members while blocked; all released`;
  });

  await scenario(s("A4 single claim vs panel claim, single rolls back → panel claimed whole"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 single claim", await claimOne(a, p2), 1);
    await begin(b, mode);
    const pb = claim(b, P);
    await mustWait(b, "M2's panel claim reaches the member M1 holds");
    await a.c.query("rollback");
    expectOk("M2 panel claim", await pb, 3);
    await b.c.query("commit");
    await expectState("after", P, x3("ip:M2"));
  });

  // --- B. claim vs unclaim ---------------------------------------------------
  await scenario(s("B1 claim while the holder's unclaim is in flight → refused at once, then lands whole"), async () => {
    await setState(P, fx.med1);
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 unclaim", await unclaim(a, P, x3(fx.med1)), 3);
    await begin(b, mode);
    // M2's snapshot still sees the panel held: nothing matches, nothing waits.
    expectCode("M2 claim", await mustNotWait(b, claim(b, P), "panel still held in M2's snapshot"), "P0077");
    await b.c.query("rollback");
    await a.c.query("commit");
    await expectState("after unclaim", P, x3("req:-"));
    await begin(b, mode);
    expectOk("M2 retry", await claim(b, P), 3);
    await b.c.query("commit");
    await expectState("after retry", P, x3("ip:M2"));
  });

  await scenario(s("B2 unclaim while a claim is in flight → refused at once, claim lands whole"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(b, mode);
    expectOk("M2 claim", await claim(b, P), 3);
    await begin(a, mode);
    // M1 believes it still holds the panel (stale tab): nothing is in progress
    // under M1 in its snapshot, so it neither waits nor hands anything back.
    expectCode("M1 unclaim", await mustNotWait(a, unclaim(a, P, x3(fx.med1)), "nothing in progress in M1's snapshot"), "P0077");
    await a.c.query("rollback");
    await b.c.query("commit");
    await expectState("after", P, x3("ip:M2"));
  });

  await scenario(s("B3 admin unclaim vs holder's own unclaim → second P0077, handed back once"), async () => {
    await setState(P, fx.med1);
    const adm = await actor("A1", fx.admin1);
    const own = await actor("M1", fx.med1);
    await begin(adm, mode);
    expectOk("A1 unclaim", await unclaim(adm, P, x3(fx.med1)), 3);
    await begin(own, mode);
    const po = unclaim(own, P, x3(fx.med1));
    await mustWait(own, "M1 queues behind A1's hand-back");
    await adm.c.query("commit");
    expectCode("M1 unclaim", await po, "P0077");
    await own.c.query("rollback");
    await expectState("after", P, x3("req:-"));
  });

  // Two hand-backs of the same panel whose member lists arrive in opposite
  // orders, released at the same instant from behind an outside lock.
  await scenario(s("B4 two unclaims, opposite member order, released together → one lands, other P0077"), async () => {
    await assertLockOrderIndependentOfArray(mode);
    await setState(P, fx.med1);
    const adm = await actor("A1", fx.admin1);
    const own = await actor("M1", fx.med1);
    const gate = await holdRows(P);
    try {
      await begin(adm, mode);
      await begin(own, mode);
      const pa = andEnd(adm, unclaim(adm, P, x3(fx.med1)));
      const po = andEnd(own, unclaim(own, rev(P), x3(fx.med1)));
      await mustWait(adm, "A1 lined up behind the gate");
      await mustWait(own, "M1 lined up behind the gate");
      await gate.query("rollback");
      const [ra, ro] = await Promise.all([pa, po]);
      const oks = [ra, ro].filter((o) => o.ok);
      const errs = [ra, ro].filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
      if (oks.length !== 1 || errs.length !== 1 || errs[0].code !== "P0077") {
        throw new Fail(
          `expected one success + one P0077, got A1=${ra.ok ? `ok(${ra.n})` : ra.code} M1=${ro.ok ? `ok(${ro.n})` : ro.code}`,
        );
      }
    } finally {
      await gate.end();
    }
    await expectState("after", P, x3("req:-"));
  });

  // --- C. admin unclaim vs reassign of one member ---------------------------
  await scenario(s("C1 reassign first, admin unclaim queued → unclaim P0077, nothing handed back"), async () => {
    await setState(P, fx.med1);
    const re = await actor("A2", fx.admin2);
    const un = await actor("A1", fx.admin1);
    await begin(re, mode);
    expectOk("A2 reassign p1 → M3", await reassign(re, p1, fx.med3), 1);
    await begin(un, mode);
    const pu = unclaim(un, P, x3(fx.med1));
    await mustWait(un, "A1's hand-back reaches the member A2 is reassigning");
    await re.c.query("commit");
    expectCode("A1 unclaim", await pu, "P0077");
    await un.c.query("rollback");
    await expectState("after", P, ["ip:M1", "ip:M3", "ip:M1"]);
    // Recovery: the admin re-reads the per-member holders and hands it back.
    await begin(un, mode);
    expectOk("A1 unclaim with fresh holders", await unclaim(un, P, [fx.med1, fx.med3, fx.med1]), 3);
    await un.c.query("commit");
    await expectState("after recovery", P, x3("req:-"));
  });

  await scenario(s("C2 admin unclaim first, reassign queued → reassign finds nothing, no orphan holder"), async () => {
    await setState(P, fx.med1);
    const un = await actor("A1", fx.admin1);
    const re = await actor("A2", fx.admin2);
    await begin(un, mode);
    expectOk("A1 unclaim", await unclaim(un, P, x3(fx.med1)), 3);
    await begin(re, mode);
    const pr = reassign(re, p1, fx.med3);
    await mustWait(re, "A2's reassign queues behind A1's hand-back");
    await un.c.query("commit");
    expectOk("A2 reassign (status moved on)", await pr, 0);
    await re.c.query("commit");
    await expectState("after", P, x3("req:-"));
  });

  // --- D. overlapping panels in one call ------------------------------------
  await scenario(s("D1 claim P+Q in one call vs claim Q+R → second P0077, R untouched"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 claim P+Q", await claim(a, [...P, ...Q]), 6);
    await begin(b, mode);
    const pb = claim(b, [...Q, ...R]);
    await mustWait(b, "M2 reaches Q, which M1 holds");
    await a.c.query("commit");
    expectCode("M2 claim Q+R", await pb, "P0077");
    await b.c.query("rollback");
    await expectState("P", P, x3("ip:M1"));
    await expectState("Q", Q, x3("ip:M1"));
    await expectState("R", R, x3("req:-"));
  });

  await scenario(s("D2 claim P+Q vs claim Q+R, first rolls back → second takes Q and R whole"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 claim P+Q", await claim(a, [...P, ...Q]), 6);
    await begin(b, mode);
    const pb = claim(b, [...Q, ...R]);
    await mustWait(b, "M2 reaches Q, which M1 holds");
    await a.c.query("rollback");
    expectOk("M2 claim Q+R", await pb, 6);
    await b.c.query("commit");
    await expectState("P", P, x3("req:-"));
    await expectState("Q", Q, x3("ip:M2"));
    await expectState("R", R, x3("ip:M2"));
  });

  await scenario(s("D3 claim P+Q vs claim Q+P (opposite order), released together → one wins, no deadlock"), async () => {
    await assertLockOrderIndependentOfArray(mode);
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    const gate = await holdRows([...P, ...Q]);
    let winner = "";
    try {
      await begin(a, mode);
      await begin(b, mode);
      const pa = andEnd(a, claim(a, [...P, ...Q]));
      const pb = andEnd(b, claim(b, [...rev(Q), ...rev(P)]));
      await mustWait(a, "M1 lined up behind the gate");
      await mustWait(b, "M2 lined up behind the gate");
      await gate.query("rollback");
      const [ra, rb] = await Promise.all([pa, pb]);
      const oks = [ra, rb].filter((o) => o.ok);
      const errs = [ra, rb].filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
      if (oks.length !== 1 || errs.length !== 1 || errs[0].code !== "P0077") {
        throw new Fail(
          `expected one success + one P0077, got M1=${ra.ok ? `ok(${ra.n})` : ra.code} M2=${rb.ok ? `ok(${rb.n})` : rb.code}`,
        );
      }
      winner = ra.ok ? "M1" : "M2";
    } finally {
      await gate.end();
    }
    await expectState("P", P, x3(`ip:${winner}`));
    await expectState("Q", Q, x3(`ip:${winner}`));
    return `${winner} won`;
  });

  // The app's bulk bar calls the RPC once per panel, each in its own
  // transaction. Two selections that cross ([P, Q] vs [Q, P]) end with each
  // panel whole under one holder — never a panel split between them.
  await scenario(s("D4 crossing bulk selections, one call per panel → each panel whole, one holder each"), async () => {
    const a = await actor("M1", fx.med1);
    const b = await actor("M2", fx.med2);
    await begin(a, mode);
    expectOk("M1 bulk: P", await claim(a, P), 3);
    await begin(b, mode);
    expectOk("M2 bulk: Q", await claim(b, Q), 3);
    await b.c.query("commit");
    await begin(b, mode);
    const pbP = claim(b, P);
    await mustWait(b, "M2 bulk: P queues behind M1");
    await a.c.query("commit");
    expectCode("M2 bulk: P", await pbP, "P0077");
    await b.c.query("rollback");
    await begin(a, mode);
    expectCode("M1 bulk: Q", await mustNotWait(a, claim(a, Q), "Q already committed to M2"), "P0077");
    await a.c.query("rollback");
    await expectState("P", P, x3("ip:M1"));
    await expectState("Q", Q, x3("ip:M2"));
  });

  // --- E. claim vs queue Delete of one member -------------------------------
  await scenario(s("E1 queue Delete of one member first, panel claim queued → P0077, nothing claimed"), async () => {
    const del = await actor("service_role", null);
    const b = await actor("M2", fx.med2);
    await begin(del, mode);
    expectOk("delete p1", await queueDelete(del, [p1], fx.visits.P), 1);
    await begin(b, mode);
    const pb = claim(b, P);
    await mustWait(b, "M2 reaches the member being deleted");
    await del.c.query("commit");
    expectCode("M2 claim", await pb, "P0077");
    await b.c.query("rollback");
    await expectState("after", P, ["req:-", "del/req:-", "req:-"]);
  });
}

// Free races: no forced ordering, both sides fired together, many rounds.
// Proves nothing about WHICH interleaving happened — only that none of them
// broke the invariant.
async function freeRaces(mode: Mode, rounds: number): Promise<void> {
  const { P, Q } = fx;
  const s = (n: string) => `[${mode}] ${n}`;

  await scenario(s(`F1 ${rounds}× three-way claim race on one panel → exactly one winner, never split`), async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < rounds; i++) {
      await resetAll();
      const racers = [
        await actor("M1", fx.med1),
        await actor("M2", fx.med2),
        await actor("M3", fx.med3),
      ];
      for (const r of racers) await begin(r, mode);
      const outs = await Promise.all(
        racers.map((r) => andEnd(r, claim(r, i % 2 ? rev(P) : P))),
      );
      const wins = outs.filter((o) => o.ok && o.n === 3).length;
      const bad = outs.filter((o) => !o.ok && o.code !== "P0077");
      if (wins !== 1 || bad.length) {
        throw new Fail(`round ${i}: ${outs.map((o) => (o.ok ? `ok(${o.n})` : o.code)).join(" ")}`);
      }
      const w = await expectWhole(`round ${i}`, P);
      tally[w] = (tally[w] ?? 0) + 1;
      await closeActors();
    }
    return Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(" ");
  });

  await scenario(s(`F2 ${rounds}× claim P+Q vs claim Q+P → one winner, both panels whole`), async () => {
    for (let i = 0; i < rounds; i++) {
      await resetAll();
      const a = await actor("M1", fx.med1);
      const b = await actor("M2", fx.med2);
      await begin(a, mode);
      await begin(b, mode);
      const outs = await Promise.all([
        andEnd(a, claim(a, [...P, ...Q])),
        andEnd(b, claim(b, [...rev(Q), ...rev(P)])),
      ]);
      const wins = outs.filter((o) => o.ok && o.n === 6).length;
      const bad = outs.filter((o) => !o.ok && o.code !== "P0077");
      if (wins !== 1 || bad.length) {
        throw new Fail(`round ${i}: ${outs.map((o) => (o.ok ? `ok(${o.n})` : o.code)).join(" ")}`);
      }
      const wp = await expectWhole(`round ${i} P`, P);
      const wq = await expectWhole(`round ${i} Q`, Q);
      if (wp !== wq) throw new Fail(`round ${i}: P=${wp} Q=${wq} — one call landed on half its panels`);
      await closeActors();
    }
  });

  await scenario(s(`F3 ${rounds}× holder unclaim vs someone else's claim → panel whole every round`), async () => {
    for (let i = 0; i < rounds; i++) {
      await setState(P, fx.med1);
      const own = await actor("M1", fx.med1);
      const b = await actor("M2", fx.med2);
      await begin(own, mode);
      await begin(b, mode);
      const [ro, rb] = await Promise.all([
        andEnd(own, unclaim(own, P, x3(fx.med1))),
        andEnd(b, claim(b, P)),
      ]);
      if (!ro.ok) throw new Fail(`round ${i}: the holder's unclaim failed (${ro.code})`);
      if (!rb.ok && rb.code !== "P0077") throw new Fail(`round ${i}: claim ${rb.code}`);
      await expectState(`round ${i}`, P, x3(rb.ok ? "ip:M2" : "req:-"));
      await closeActors();
    }
  });
}

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------

async function sweepTagged(like: string): Promise<void> {
  // Children first. Scoped to rows this runner's tag shape minted.
  await monitor.query(
    `delete from public.test_requests
      where visit_id in (select id from public.visits where visit_number like $1)`,
    [`V-${like.toUpperCase()}%`],
  );
  await monitor.query("delete from public.visits where visit_number like $1", [`V-${like.toUpperCase()}%`]);
  await monitor.query("delete from public.patients where drm_id like $1", [`DRM-${like.toUpperCase()}%`]);
  await monitor.query("delete from public.services where code like $1", [`${like.toUpperCase()}%`]);
  await monitor.query("delete from public.report_groups where code like $1", [`${like.toUpperCase()}%`]);
  await monitor.query(
    "delete from public.staff_profiles where id in (select id from auth.users where email like $1)",
    [`${like}%@example.test`],
  );
  await monitor.query("delete from auth.users where email like $1", [`${like}%@example.test`]);
}

async function countTagged(like: string): Promise<number> {
  const up = like.toUpperCase();
  const { rows } = await monitor.query<{ n: string }>(
    `select (select count(*) from auth.users where email like $1)
          + (select count(*) from public.staff_profiles where full_name like $2)
          + (select count(*) from public.services where code like $3)
          + (select count(*) from public.report_groups where code like $3)
          + (select count(*) from public.patients where drm_id like $4)
          + (select count(*) from public.visits where visit_number like $5)
          + (select count(*) from public.test_requests where id = any($6::uuid[])) as n`,
    [`${like}%@example.test`, `${like}%`, `${up}%`, `DRM-${up}%`, `V-${up}%`, ALL_TESTS],
  );
  return Number(rows[0].n);
}

async function seed(): Promise<void> {
  const users: Array<[string, string, string]> = [
    [fx.med1, "medtech", "m1"],
    [fx.med2, "medtech", "m2"],
    [fx.med3, "medtech", "m3"],
    [fx.admin1, "admin", "a1"],
    [fx.admin2, "admin", "a2"],
  ];
  await monitor.query("begin");
  for (const [id, role, k] of users) {
    await monitor.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
      [id, `${TAG}-${k}@example.test`],
    );
    await monitor.query(
      "insert into public.staff_profiles (id, full_name, role, is_active) values ($1, $2, $3, true)",
      [id, `${TAG} ${k.toUpperCase()}`, role],
    );
  }
  await monitor.query("insert into public.report_groups (id, code, name) values ($1, $2, $3)", [
    fx.group,
    TAG_UP,
    `${TAG} Chemistry`,
  ]);
  for (const [i, id] of fx.services.entries()) {
    await monitor.query(
      `insert into public.services (id, code, name, price_php, kind, section, report_group_id)
       values ($1, $2, $3, 100, 'lab_test', 'chemistry', $4)`,
      [id, `${TAG_UP}-${i}`, `${TAG} test ${i}`, fx.group],
    );
  }
  await monitor.query(
    `insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
     values ($1, $2, 'Pcc', 'Fixture', '1990-01-01', 'female')`,
    [fx.patient, `DRM-${TAG_UP}`],
  );
  for (const key of ["P", "Q", "R"] as const) {
    await monitor.query(
      `insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
       values ($1, $2, $3, (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0)`,
      [fx.visits[key], `V-${TAG_UP}-${key}`, fx.patient],
    );
    for (const [i, id] of fx[key].entries()) {
      await monitor.query(
        `insert into public.test_requests (id, visit_id, service_id, requested_by, status)
         values ($1, $2, $3, $4, 'requested')`,
        [id, fx.visits[key], fx.services[i], fx.med1],
      );
    }
  }
  await monitor.query("commit");
}

// Print the plan each mode gives the two UPDATEs inside the functions.
async function printPlans(): Promise<void> {
  for (const mode of ["seq", "indexed"] as Mode[]) {
    await monitor.query("begin");
    for (const g of MODE_GUCS[mode]) await monitor.query(g);
    const claimPlan = await monitor.query(
      `explain (costs off) update public.test_requests set status = 'in_progress'
        where id = any($1::uuid[]) and status = 'requested' and assigned_to is null and deleted_at is null`,
      [fx.P],
    );
    const unclaimPlan = await monitor.query(
      `explain (costs off) update public.test_requests t set status = 'requested'
         from unnest($1::uuid[], $2::uuid[]) as x(id, holder)
        where t.id = x.id and t.status = 'in_progress' and t.assigned_to = x.holder and t.deleted_at is null`,
      [fx.P, x3(fx.med1)],
    );
    await monitor.query("rollback");
    const flat = (r: QueryResult) =>
      r.rows.map((row) => String(row["QUERY PLAN"]).trim()).filter((l) => !/^(Filter|Join Filter|Index Cond|Recheck)/.test(l.replace(/^->\s*/, ""))).join(" / ");
    console.log(`  plan [${mode}] claim:   ${flat(claimPlan)}`);
    console.log(`  plan [${mode}] unclaim: ${flat(unclaimPlan)}`);
  }
}

// ---------------------------------------------------------------------------
// Control rounds (--control): prove the proof can fail
// ---------------------------------------------------------------------------
//
// Each mutant is a copy of the live 0191 functions with one guard removed,
// created in a throwaway schema (never in public — the local stack is shared,
// so other sessions keep calling the real functions throughout). The forced
// scenarios run against the copy, and the round PASSES only when every
// scenario named in `mustFail` fails in both plan modes.

interface Mutant {
  key: string;
  what: string;
  fn: "claim_panel_members" | "unclaim_panel_members";
  from: string;
  to: string;
  mustFail: string[];
}

const MUTANTS: Mutant[] = [
  {
    key: "A",
    what: "claim keeps whatever matched (the pre-0191 split)",
    fn: "claim_panel_members",
    from: "if v_claimed <> v_wanted then",
    to: "if false then",
    mustFail: ["A1", "A3", "D1"],
  },
  {
    key: "B",
    what: "unclaim ignores the holder the operator saw",
    fn: "unclaim_panel_members",
    from: "and t.assigned_to = x.holder",
    to: "",
    mustFail: ["C1"],
  },
  {
    key: "D",
    what: "unclaim keeps whatever matched",
    fn: "unclaim_panel_members",
    from: "if v_unclaimed <> v_wanted then",
    to: "if false then",
    mustFail: ["C1", "B3"],
  },
  {
    key: "C",
    what: "claim ignores deleted_at",
    fn: "claim_panel_members",
    from: "and deleted_at is null;",
    to: ";",
    mustFail: ["E1"],
  },
];

async function controlRounds(): Promise<void> {
  const schema = `pcc_ctl_${TAG.slice(4)}`;
  const defs: Record<string, string> = {};
  for (const [fn, sig] of [
    ["claim_panel_members", "uuid[]"],
    ["unclaim_panel_members", "uuid[], uuid[]"],
  ]) {
    const { rows } = await monitor.query<{ d: string }>(
      `select pg_get_functiondef('public.${fn}(${sig})'::regprocedure) as d`,
    );
    defs[fn] = rows[0].d.replace(`FUNCTION public.${fn}(`, `FUNCTION ${schema}.${fn}(`);
  }

  for (const m of MUTANTS) {
    if (!defs[m.fn].includes(m.from)) throw new Error(`control ${m.key}: "${m.from}" not found in ${m.fn}`);
    await monitor.query(`drop schema if exists ${schema} cascade`);
    await monitor.query(`create schema ${schema}`);
    try {
      for (const [fn, def] of Object.entries(defs)) {
        await monitor.query(fn === m.fn ? def.replace(m.from, m.to) : def);
      }
      await monitor.query(`grant usage on schema ${schema} to authenticated, service_role`);
      await monitor.query(`grant execute on all functions in schema ${schema} to authenticated, service_role`);

      console.log(`\ncontrol ${m.key}: ${m.what}`);
      const caught: Result[] = [];
      sink = caught;
      fnSchema = schema;
      for (const mode of ["seq", "indexed"] as Mode[]) await forcedScenarios(mode);
      const failedIds = caught.filter((r) => !r.ok).map((r) => r.name);
      const missed = (["seq", "indexed"] as Mode[]).flatMap((mode) =>
        m.mustFail
          .filter((id) => !failedIds.some((n) => n.startsWith(`[${mode}] ${id} `)))
          .map((id) => `[${mode}] ${id}`),
      );
      const ok = missed.length === 0;
      results.push({
        name: `control ${m.key} (${m.what})`,
        ok,
        detail: ok ? `caught by ${failedIds.length} scenario(s)` : `NOT caught by ${missed.join(", ")}`,
      });
      console.log(`  ${ok ? "PASS" : "FAIL"}  control ${m.key} — ${ok ? `caught by ${failedIds.length} scenario(s)` : `NOT caught by ${missed.join(", ")}`}`);
    } finally {
      sink = results;
      fnSchema = "public";
      await monitor.query(`drop schema if exists ${schema} cascade`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Remove this run's fixtures (and its control schema) and prove none are left.
async function teardown(): Promise<void> {
  await closeActors();
  await monitor.query(`drop schema if exists pcc_ctl_${TAG.slice(4)} cascade`);
  await sweepTagged(TAG);
  const left = await countTagged(TAG);
  if (left > 0) {
    results.push({ name: "teardown", ok: false, detail: `${left} fixture rows left behind` });
    console.log(`  FAIL  teardown — ${left} fixture rows left behind`);
  } else {
    console.log("  teardown: every fixture row removed");
  }
}

async function main(): Promise<void> {
  const rounds = Number(process.env.PCC_ROUNDS ?? 25);
  monitor = await connect();

  // One run at a time on the shared stack: the startup sweep below removes
  // EVERY pcc- fixture, which would pull a concurrent run's live rows out from
  // under it. Session-level, so it lasts until the monitor disconnects.
  const { rows: lock } = await monitor.query<{ got: boolean }>(
    "select pg_try_advisory_lock(hashtext('panel-claim:concurrency-proof')) as got",
  );
  if (!lock[0].got) {
    console.error("[panel-claim:concurrency-proof] another run is in progress on this stack — try again when it finishes.");
    await monitor.end();
    process.exit(3);
  }

  let seeded = false;
  // Ctrl-C: tear down before exiting, so committed fixtures never outlive the
  // run (open transactions roll back when their connections close).
  process.once("SIGINT", () => {
    console.log("\n  interrupted — tearing down");
    teardown()
      .catch((e) => console.error(e))
      .finally(() => process.exit(130));
  });
  try {
    const { rows: fn } = await monitor.query<{ n: string }>(
      "select count(*) as n from pg_proc where proname in ('claim_panel_members', 'unclaim_panel_members')",
    );
    if (Number(fn[0].n) !== 2) throw new Error("0191 is not applied to the local stack");

    await sweepTagged("pcc-");
    // Control-round schemas a crashed run left behind (always pcc_ctl_<hex>).
    const { rows: stale } = await monitor.query<{ n: string }>(
      "select nspname as n from pg_namespace where nspname ~ '^pcc_ctl_[0-9a-f]{6}$'",
    );
    for (const { n } of stale) await monitor.query(`drop schema ${n} cascade`);
    console.log(`panel-claim concurrency proof — fixtures tagged ${TAG}`);
    await seed();
    seeded = true;
    await printPlans();

    for (const mode of ["seq", "indexed"] as Mode[]) {
      await forcedScenarios(mode);
      await freeRaces(mode, rounds);
    }
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
