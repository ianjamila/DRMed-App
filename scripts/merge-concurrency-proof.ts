/**
 * merge:concurrency-proof — two-session proof for the atomic patient merge
 * and undo-merge (0196: merge_patients_guarded / undo_patient_merge_guarded).
 *
 * LOCAL ONLY. Commits its own tagged fixtures (two connections cannot see each
 * other's uncommitted rows), runs each race with two real connections, and
 * removes everything in `finally` — then proves nothing tagged is left. Never
 * touches rows it did not mint (the local stack is shared).
 *
 *   M1a visit insert on the source first  → merge waits, then moves the visit
 *   M1b merge first                       → the visit insert waits, then P0058
 *   M2  delete_patient(keep) first        → merge waits, then P0058
 *   M3  two merges of one source          → second waits, then P0058
 *   M4  A→B racing B→C                    → P0072, retry re-parents A to C
 *   M5  result link on the source first   → merge waits, P0072, retry succeeds
 *   M5b merge first                       → the link waits, then P0072/P0058
 *   M6  result link spanning both records → undo waits, P0072, retry refuses (split)
 *   M7  row-first visit edit vs merge     → free race ×20, both converge with one retry
 *   M8  double undo                       → second waits, then P0079
 *   M9  undo vs an edit of a filled field → undo waits on the row, keeps the edit
 *
 * --control: copies undo_patient_merge_guarded into the throwaway schema
 * merge_proof_ctl with its lock statements removed (the result-membership
 * and lifecycle locks, the ledger row's FOR UPDATE and the patient rows'
 * FOR NO KEY UPDATE), owned by patient_merge_writer like the real one, and
 * passes only if M8 FAILS against the copy: without the ledger lock the second
 * undo reads a stale "not undone" row and succeeds a second time.
 * (A lock-free MERGE copy is NOT a useful control: 0184's a_lifecycle_guard
 * takes its own lifecycle lock and re-asserts the patient in every moved
 * row's trigger, so M1b still waits and refuses without the function's own
 * locks — defence in depth, confirmed 2026-09-30. The function-level locks
 * add ordering (no membership inversion) and the ledger serialisation that
 * the undo control proves.)
 *
 * Run: npm run merge:concurrency-proof [-- --control]   (local stack, 0196 applied)
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd, hostOf, isLocalHost } from "./lib/env-guard";
import { randomUUID } from "node:crypto";
import pg from "pg";

requireLocalOrExplicitProd("merge:concurrency-proof", {
  writes:
    "creates and then removes temporary staff, patients, visits, lines, results, merges and their audit rows; --control also creates and drops the schema merge_proof_ctl",
});

const DB_URL = process.env.MERGE_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!isLocalHost(hostOf(DB_URL))) {
  console.error("merge:concurrency-proof takes real locks and writes fixtures — it runs against the LOCAL stack only.");
  process.exit(1);
}
const CONTROL = process.argv.includes("--control");

const ADMIN = randomUUID();
const SERVICE = randomUUID();
const TAG = `MGP${Date.now().toString(36).toUpperCase()}`;
const made = { patients: [] as string[], results: [] as string[] };
let seq = 0;
let TEMPLATE: string | null = null;

type Client = pg.Client & { pid: number };
const results: { name: string; ok: boolean; detail: string }[] = [];

async function connect(): Promise<Client> {
  const c = new pg.Client({ connectionString: DB_URL }) as Client;
  await c.connect();
  await c.query("set lock_timeout = '15s'");
  c.pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  return c;
}

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

async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? `error: ${(e as Error).message}`;
  }
}

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

// --- fixtures (committed through the supervisor connection) -------------------
async function patient(s: pg.Client, label: string, phone: string | null = null): Promise<string> {
  seq++;
  const { rows } = await s.query(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, phone)
     values ($1, 'Proof', $2, '1990-01-01', $3) returning id`,
    [`DRM-${TAG}${seq}`, `${label}${seq}`, phone],
  );
  made.patients.push(rows[0].id);
  return rows[0].id as string;
}
const visitSql = `insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php)
                  values ($1, $2, 'unpaid', 0, 0) returning id`;
async function visit(c: pg.Client, p: string): Promise<string> {
  return (await c.query(visitSql, [`V-${TAG}-${++seq}`, p])).rows[0].id as string;
}
async function line(c: pg.Client, v: string): Promise<string> {
  const { rows } = await c.query(
    `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php, parent_id, is_package_header)
     values ($1, $2, 'in_progress', $3, 0, 0, null, false) returning id`,
    [v, SERVICE, ADMIN],
  );
  return rows[0].id as string;
}
async function result(c: pg.Client, lines: string[]): Promise<string> {
  const r = (await c.query(
    `insert into public.results (generation_kind, uploaded_by) values ('structured', $1) returning id`, [ADMIN],
  )).rows[0].id as string;
  made.results.push(r);
  for (const l of lines) await c.query(`insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)`, [r, l]);
  return r;
}
async function asService(c: pg.Client) {
  await c.query("set local role service_role");
}
function mergeQ(c: pg.Client, keep: string, src: string, fn = "public.merge_patients_guarded") {
  return c.query(`select ${fn}($1, $2, $3, $4::jsonb) as r`, [keep, src, ADMIN, JSON.stringify({ source: "admin" })]);
}
function undoQ(c: pg.Client, mergeId: string) {
  return c.query(`select public.undo_patient_merge_guarded($1, $2, null) as r`, [mergeId, ADMIN]);
}
async function mergeCommitted(s: pg.Client, keep: string, src: string): Promise<string> {
  await s.query("begin");
  await asService(s);
  const { rows } = await mergeQ(s, keep, src);
  await s.query("commit");
  return rows[0].r.merge_id as string;
}
async function ownerOf(s: pg.Client, table: string, id: string): Promise<string | null> {
  return ((await s.query(`select patient_id from public.${table} where id = $1`, [id])).rows[0]?.patient_id ?? null) as string | null;
}
async function markerOf(s: pg.Client, p: string): Promise<string | null> {
  return ((await s.query(`select merged_into_id from public.patients where id = $1`, [p])).rows[0]?.merged_into_id ?? null) as string | null;
}
/** One transaction on `c`, retried ONCE on P0072/40P01/40001 — the app's withLifecycleRetry. */
async function withRetry(c: Client, fn: (c: Client) => Promise<unknown>): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await c.query("begin");
    const st = await stateOf(fn(c));
    await c.query(st === "ok" ? "commit" : "rollback");
    if (st === "ok" || !["P0072", "40P01", "40001"].includes(st) || attempt === 1) return st;
  }
  return "unreachable";
}

async function seed(s: pg.Client) {
  await s.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [ADMIN, `${TAG.toLowerCase()}-admin@example.test`],
  );
  await s.query(`insert into public.staff_profiles (id, full_name, role, is_active) values ($1, 'Merge Proof Admin', 'admin', true)`, [ADMIN]);
  await s.query(`insert into public.services (id, code, name, price_php, kind) values ($1, $2, 'Merge proof lab', 100, 'lab_test')`, [SERVICE, `${TAG}-LAB`]);
  TEMPLATE = (await s.query(`insert into public.result_templates (service_id, layout) values ($1, 'simple') returning id`, [SERVICE])).rows[0].id;
}

async function cleanup(s: pg.Client) {
  const ids = made.patients;
  await s.query("begin");
  // Local-only teardown of rows this run minted: replica mode skips the
  // lifecycle guards (some fixtures end deleted) and per-row RI ordering.
  await s.query("set local session_replication_role = replica");
  if (ids.length > 0) {
    await s.query(`delete from public.critical_alerts where patient_id = any($1::uuid[])`, [ids]);
    await s.query(
      `delete from public.result_test_requests where test_request_id in
         (select tr.id from public.test_requests tr join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[]))`,
      [ids],
    );
  }
  if (made.results.length > 0) await s.query(`delete from public.results where id = any($1::uuid[])`, [made.results]);
  if (ids.length > 0) {
    for (const sql of [
      `delete from public.test_requests where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
      `delete from public.visits where patient_id = any($1::uuid[])`,
      `delete from public.appointments where patient_id = any($1::uuid[])`,
      `delete from public.patient_consents where patient_id = any($1::uuid[])`,
      `delete from public.appointment_attachments where patient_id = any($1::uuid[])`,
      `delete from public.patient_merges where keep_id = any($1::uuid[]) or source_id = any($1::uuid[])`,
      `delete from public.audit_log where patient_id = any($1::uuid[])`,
      `delete from public.patients where id = any($1::uuid[])`,
    ]) await s.query(sql, [ids]);
  }
  await s.query(`delete from public.audit_log where actor_id = $1`, [ADMIN]);
  if (TEMPLATE) {
    await s.query(`delete from public.result_template_params where template_id = $1`, [TEMPLATE]);
    await s.query(`delete from public.result_templates where id = $1`, [TEMPLATE]);
  }
  await s.query(`delete from public.services where id = $1`, [SERVICE]);
  await s.query(`delete from public.staff_profiles where id = $1`, [ADMIN]);
  await s.query(`delete from auth.users where id = $1`, [ADMIN]);
  await s.query("commit");
  if (CONTROL) await s.query("drop schema if exists merge_proof_ctl cascade");
  const { rows } = await s.query(`select count(*)::int as n from public.patients where drm_id like $1`, [`DRM-${TAG}%`]);
  if (rows[0].n !== 0) throw new Error(`cleanup left ${rows[0].n} tagged patients behind`);
}

/** undo_patient_merge_guarded with every lock statement removed, in a throwaway schema. */
async function makeUndoMutant(s: pg.Client): Promise<string> {
  const { rows } = await s.query(
    `select pg_get_functiondef('public.undo_patient_merge_guarded(uuid, uuid, jsonb)'::regprocedure) as d`,
  );
  let d = rows[0].d as string;
  d = d.replace(/CREATE OR REPLACE FUNCTION public\.undo_patient_merge_guarded/i, "CREATE OR REPLACE FUNCTION merge_proof_ctl.undo_patient_merge_guarded");
  d = d
    .replace(/perform public\.lifecycle_lock_results\([^;]*;/g, "")
    .replace(/perform public\.lifecycle_lock\([^;]*;/g, "")
    .replace(/select \* into m from public\.patient_merges where id = p_merge_id for update;/g, "")
    .replace(/perform 1 from public\.patients p[\s\S]*?for no key update;/g, "");
  if (/lifecycle_lock|for no key update|\bfor update;/i.test(d) || !/merge_proof_ctl\./.test(d)) {
    throw new Error("mutant: the function text changed shape — update makeUndoMutant's patterns");
  }
  await s.query("create schema if not exists merge_proof_ctl");
  // Owned by the private writer like the real function, so the 0196 rollback
  // guard (current_user = patient_merge_writer) behaves the same.
  await s.query("grant usage, create on schema merge_proof_ctl to patient_merge_writer");
  await s.query(d);
  await s.query("alter function merge_proof_ctl.undo_patient_merge_guarded(uuid, uuid, jsonb) owner to patient_merge_writer");
  await s.query("revoke create on schema merge_proof_ctl from patient_merge_writer");
  await s.query("grant execute on function merge_proof_ctl.undo_patient_merge_guarded(uuid, uuid, jsonb) to postgres");
  return "merge_proof_ctl.undo_patient_merge_guarded";
}

/** M8's body, parameterised by the SECOND undo's function so --control can run it against the mutant. */
async function m8(a: Client, b: Client, s: Client, secondFn: string) {
  const k = await patient(s, "K");
  const src = await patient(s, "S");
  await visit(s, src);
  const mid = await mergeCommitted(s, k, src);
  await a.query("begin");
  await asService(a);
  await undoQ(a, mid);
  await b.query("begin");
  if (secondFn.startsWith("public.")) await asService(b);
  const p = stateOf(b.query(`select ${secondFn}($1, $2, null) as r`, [mid, ADMIN]));
  expectEq("second undo waits", await stillWaiting(p), true);
  await a.query("commit");
  expectEq("second undo refused", await p, "P0079");
}

async function main() {
  const s = await connect();
  try {
    await seed(s);

    // concurrency-proof: merge_patients_guarded
    await race("M1a visit insert on the source first → merge waits, then moves it", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      await a.query("begin");
      const v = (await a.query(visitSql, [`V-${TAG}-${++seq}`, src])).rows[0].id as string;
      await b.query("begin");
      await asService(b);
      const p = stateOf(mergeQ(b, k, src));
      expectEq("merge waits", await stillWaiting(p), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, b), "lifecycle");
      await a.query("commit");
      expectEq("merge then succeeds", await p, "ok");
      await b.query("commit");
      expectEq("the new visit moved to keep", await ownerOf(sv, "visits", v), k);
      expectEq("source is a tombstone", await markerOf(sv, src), k);
    });

    await race("M1b merge first → a visit insert on the source waits, then P0058", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      await visit(sv, src);
      await b.query("begin");
      await asService(b);
      await mergeQ(b, k, src);
      await a.query("begin");
      const p = stateOf(a.query(visitSql, [`V-${TAG}-${++seq}`, src]));
      expectEq("the visit insert waits for the merge", await stillWaiting(p), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, a), "lifecycle");
      await b.query("commit");
      expectEq("the insert is refused once the source is a tombstone", await p, "P0058");
      await a.query("rollback");
      const { rows } = await sv.query(`select count(*)::int as n from public.visits where patient_id = $1`, [src]);
      expectEq("nothing is stranded on the tombstone", rows[0].n, 0);
    });

    await race("M2 delete_patient(keep) first → merge waits, then P0058", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      await a.query("begin");
      await asService(a);
      await a.query(`select public.delete_patient($1, 'test_record', null, $2, null)`, [k, ADMIN]);
      await b.query("begin");
      await asService(b);
      const p = stateOf(mergeQ(b, k, src));
      expectEq("merge waits", await stillWaiting(p), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, b), "lifecycle");
      await a.query("commit");
      expectEq("merge refused: keep is deleted", await p, "P0058");
      await b.query("rollback");
      expectEq("source untouched", `${await ownerOf(sv, "visits", v)}|${await markerOf(sv, src)}`, `${src}|null`);
    });

    await race("M3 two merges of one source → the second waits, then P0058", async (a, b, sv) => {
      const k1 = await patient(sv, "K1");
      const k2 = await patient(sv, "K2");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      await a.query("begin");
      await asService(a);
      await mergeQ(a, k1, src);
      await b.query("begin");
      await asService(b);
      const p = stateOf(mergeQ(b, k2, src));
      expectEq("second merge waits", await stillWaiting(p), true);
      await a.query("commit");
      expectEq("second merge refused", await p, "P0058");
      await b.query("rollback");
      expectEq("source merged into k1 only, visit on k1", `${await markerOf(sv, src)}|${await ownerOf(sv, "visits", v)}`, `${k1}|${k1}`);
    });

    await race("M4 A→B racing B→C → P0072, the retry re-parents A to C", async (a, b, sv) => {
      const x = await patient(sv, "X");
      const bb = await patient(sv, "B");
      const c = await patient(sv, "C");
      const vx = await visit(sv, x);
      const vb = await visit(sv, bb);
      await a.query("begin");
      await asService(a);
      await mergeQ(a, bb, x);
      await b.query("begin");
      await asService(b);
      const first = stateOf(mergeQ(b, c, bb));
      expectEq("B→C waits", await stillWaiting(first), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, b), "lifecycle");
      await a.query("commit");
      expectEq("first attempt sees the chain change", await first, "P0072");
      await b.query("rollback");
      expectEq("the retry succeeds", await withRetry(b, async (cl) => { await asService(cl); await mergeQ(cl, c, bb); }), "ok");
      expectEq("chain flattened: X→C, B→C",
        `${await markerOf(sv, x)}|${await markerOf(sv, bb)}`, `${c}|${c}`);
      expectEq("every visit on C", `${await ownerOf(sv, "visits", vx)}|${await ownerOf(sv, "visits", vb)}`, `${c}|${c}`);
    });

    await race("M5 result link on the source first → merge waits, P0072, retry succeeds", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      const l = await line(sv, v);
      await a.query("begin");
      const r = await result(a, [l]);
      await b.query("begin");
      await asService(b);
      const first = stateOf(mergeQ(b, k, src));
      expectEq("merge waits", await stillWaiting(first), true);
      await a.query("commit");
      expectEq("the new result is outside the locked set → P0072", await first, "P0072");
      await b.query("rollback");
      expectEq("the retry succeeds", await withRetry(b, async (cl) => { await asService(cl); await mergeQ(cl, k, src); }), "ok");
      expectEq("the linked visit moved with its result", await ownerOf(sv, "visits", v), k);
      const { rows } = await sv.query(`select count(*)::int as n from public.result_test_requests where result_id = $1`, [r]);
      expectEq("the result still links its test", rows[0].n, 1);
    });

    await race("M5b merge first → a result link on the source waits, then P0072/P0058", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      const l = await line(sv, v);
      await b.query("begin");
      await asService(b);
      await mergeQ(b, k, src);
      await a.query("begin");
      const p = stateOf(result(a, [l]));
      expectEq("the link waits", await stillWaiting(p), true);
      await b.query("commit");
      const st = await p;
      expectEq("the link is refused with a retryable/inactive code", st === "P0072" || st === "P0058", true);
      await a.query("rollback");
      expectEq("the app's retry then links it on keep", await withRetry(a, (cl) => result(cl, [l])), "ok");
      expectEq("the visit is on keep", await ownerOf(sv, "visits", v), k);
    });

    await race("M6 a result spanning both records → undo waits, P0072, retry refuses (split)", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const vs = await visit(sv, src);
      const mid = await mergeCommitted(sv, k, src);
      const vk = await visit(sv, k);
      const ls = await line(sv, vs);
      const lk = await line(sv, vk);
      await a.query("begin");
      await result(a, [ls, lk]);
      await b.query("begin");
      await asService(b);
      const first = stateOf(undoQ(b, mid));
      expectEq("undo waits", await stillWaiting(first), true);
      await a.query("commit");
      expectEq("first attempt: P0072", await first, "P0072");
      await b.query("rollback");
      expectEq("retry: refused as a split result", await withRetry(b, async (cl) => { await asService(cl); await undoQ(cl, mid); }), "P0079");
      expectEq("nothing changed", `${await ownerOf(sv, "visits", vs)}|${await markerOf(sv, src)}`, `${k}|${k}`);
    });

    await race("M7 row-first visit edit vs merge — free race ×20, both converge", async (a, b, sv) => {
      let retried = 0;
      for (let i = 0; i < 20; i++) {
        const k = await patient(sv, "K");
        const src = await patient(sv, "S");
        const v = await visit(sv, src);
        const [ra, rb] = await Promise.all([
          withRetry(a, (cl) => cl.query(`update public.visits set notes = $1 where id = $2`, [`round ${i}`, v])),
          withRetry(b, async (cl) => { await asService(cl); await mergeQ(cl, k, src); }),
        ]);
        expectEq(`round ${i}: edit converged`, ra, "ok");
        expectEq(`round ${i}: merge converged`, rb, "ok");
        const { rows } = await sv.query(`select patient_id, notes from public.visits where id = $1`, [v]);
        expectEq(`round ${i}: visit on keep with the edit`, `${rows[0].patient_id}|${rows[0].notes}`, `${k}|round ${i}`);
        expectEq(`round ${i}: source merged`, await markerOf(sv, src), k);
        if (ra !== "ok" || rb !== "ok") retried++;
      }
      console.log(`  (M7: ${retried}/20 rounds needed the retry)`);
    });

    // concurrency-proof: undo_patient_merge_guarded
    await race("M8 double undo → the second waits, then P0079", (a, b, sv) =>
      m8(a, b, sv, "public.undo_patient_merge_guarded"));

    await race("M9 undo vs an edit of a filled field → undo waits on the row, keeps the edit", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S", "09170000001");
      const mid = await mergeCommitted(sv, k, src);                // fills k.phone
      await a.query("begin");
      await a.query(`update public.patients set phone = '09170000009' where id = $1`, [k]);
      await b.query("begin");
      await asService(b);
      const p = undoQ(b, mid);
      const st = stateOf(p);
      expectEq("undo waits", await stillWaiting(st), true);
      expectEq("…on the patient row", await waitingOn(sv, b), "row");
      await a.query("commit");
      expectEq("undo succeeds", await st, "ok");
      const report = (await p).rows[0].r as { kept_fields: string[] };
      await b.query("commit");
      expectEq("the edited phone is kept and reported",
        `${((await sv.query(`select phone from public.patients where id = $1`, [k])).rows[0].phone)}|${report.kept_fields.join(",")}`,
        "09170000009|phone");
    });

    if (CONTROL) {
      const fn = await makeUndoMutant(s);
      await race("CONTROL M8 against the lock-free undo mutant must FAIL", async (a, b, sv) => {
        let broke = false;
        try {
          await m8(a, b, sv, fn);
        } catch {
          broke = true;
        }
        expectEq("the proof catches an undo without locks", broke, true);
      });
    }
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
