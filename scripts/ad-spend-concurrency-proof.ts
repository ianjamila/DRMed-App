// Concurrency proof for public.ad_spend_import (supabase/migrations/0189_patient_sources.sql).
//
// Unlike scripts/patient-sources-db-proof.ts (one rolled-back transaction), this proof needs REAL
// concurrent sessions, so it COMMITS. It therefore:
//   - refuses any non-local host and refuses the shared default stack (port 54322) unless
//     --allow-shared is passed (don't: other sessions use it),
//   - namespaces all rows under campaign_key 'concproof-*' / dates in 2031, and best-effort cleans up.
//
// Two real sessions = two pg Clients, each `begin; set local role authenticated;
// set_config('request.jwt.claims', {sub: <admin>})` — the same impersonation the other proofs use.
// Overlap is FORCED, not hoped for: session A runs its import and keeps its transaction open;
// session B is then fired; a third monitor connection waits until B is either blocked on an
// advisory lock (pg_locks granted=false) or has finished; only then does A commit.
// With the lock, B is observed blocked and finishes after A commits. Without it (CONTROL), B
// finishes while A is still open and both commit -> doubled spend.
//
// Run (isolated stack; see the report for how it was built):
//   npx tsx scripts/ad-spend-concurrency-proof.ts postgresql://postgres:postgres@127.0.0.1:57322/postgres
//   (or DB_URL=... npx tsx scripts/ad-spend-concurrency-proof.ts). Add --no-control to skip the
//   control (which does CREATE OR REPLACE of ad_spend_import without the lock, then restores it).
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { Client } from "pg";

const argv = process.argv.slice(2);
const DB_URL = argv.find((a) => a.startsWith("postgres")) ?? process.env.DB_URL ?? "";
const ALLOW_SHARED = argv.includes("--allow-shared");
const RUN_CONTROL = !argv.includes("--no-control");

// The repo-wide seatbelt (scripts/lib/guard-coverage.test.ts): the guard judges
// SUPABASE_DB_URL, so hand it the URL this run will really use. It is IN
// ADDITION to this script's own local-only / not-54322 refusals below.
if (DB_URL) process.env.SUPABASE_DB_URL = DB_URL;
requireLocalOrExplicitProd("ad-spend:concurrency-proof", {
  writes: "COMMITS rows under campaign_key 'concproof-*' (dates in 2031) and a fixture admin, best-effort removed at the end",
});

if (!DB_URL) throw new Error("Pass a postgres URL (arg or DB_URL).");
const u = new URL(DB_URL);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) throw new Error(`Refusing non-local host ${u.hostname}`);
if (u.port === "54322" && !ALLOW_SHARED) throw new Error("Refusing the shared local stack (54322). Use an isolated stack.");

const HOLD_LOOKUP_MS = 3000; // how long to wait for B to become blocked before deciding it is not

type Row = { spend_date: string; platform: string; campaign_key: string; ad_key: string; campaign_label: string; spend_php: number; impressions?: number; clicks?: number };
const mk = (date: string, campaign: string, ad: string, spend: number): Row => ({
  spend_date: date, platform: "meta", campaign_key: campaign, ad_key: ad, campaign_label: campaign.toUpperCase(), spend_php: spend, impressions: 10, clicks: 1,
});

const results: { name: string; ok: boolean; detail: string }[] = [];
let adminId = "";

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}\n     ${detail}`);
}

async function admin() {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session = own connection + own transaction impersonating the admin. */
class Session {
  c!: Client;
  pid = 0;
  async open() {
    this.c = await admin();
    this.pid = (await this.c.query("select pg_backend_pid() as p")).rows[0].p;
    await this.c.query("begin");
    await this.c.query("set local role authenticated");
    await this.c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: adminId, role: "authenticated" })]);
    return this;
  }
  async imp(rows: Row[], rejected = 0, uploadId?: string) {
    return this.c.query("select public.ad_spend_import(coalesce($1::uuid, gen_random_uuid()), $2::jsonb, $3::int) as r", [uploadId ?? null, JSON.stringify(rows), rejected]);
  }
  async commit() { await this.c.query("commit"); }
  async rollback() { await this.c.query("rollback").catch(() => {}); }
  async close() { await this.c.end().catch(() => {}); }
}

type Outcome = { ok: boolean; value?: unknown; code?: string; msg?: string; endedAt: number };

/**
 * A imports (txn stays open) -> B fired -> monitor waits for B blocked-or-done -> A commits -> B commits.
 * Returns what the monitor saw, when things happened, and each session's outcome.
 */
async function overlap(
  a: { rows: Row[]; rejected?: number },
  b: { rows: Row[]; rejected?: number },
  opts: { uploadA?: string; uploadB?: string } = {},
) {
  const A = await new Session().open();
  const B = await new Session().open();
  const mon = await admin();
  const t0 = Date.now();
  const out: { A?: Outcome; B?: Outcome; bBlocked: boolean; bWaitEvent: string | null; lockRow: unknown; bDoneBeforeACommit: boolean; aCommitAt: number; t0: number } = {
    bBlocked: false, bWaitEvent: null, lockRow: null, bDoneBeforeACommit: false, aCommitAt: 0, t0,
  };
  try {
    try { out.A = { ok: true, value: (await A.imp(a.rows, a.rejected ?? 0, opts.uploadA)).rows[0].r, endedAt: Date.now() - t0 }; }
    catch (e) { const er = e as Error & { code?: string }; out.A = { ok: false, code: er.code, msg: er.message, endedAt: Date.now() - t0 }; }

    let bSettled = false;
    const bP: Promise<Outcome> = B.imp(b.rows, b.rejected ?? 0, opts.uploadB).then(
      (r) => { bSettled = true; return { ok: true, value: r.rows[0].r, endedAt: Date.now() - t0 }; },
      (e: Error & { code?: string }) => { bSettled = true; return { ok: false, code: e.code, msg: e.message, endedAt: Date.now() - t0 }; },
    );

    const deadline = Date.now() + HOLD_LOOKUP_MS;
    while (Date.now() < deadline && !bSettled) {
      const w = await mon.query(
        `select a.wait_event_type, a.wait_event, l.locktype, l.granted, l.classid, l.objid
           from pg_stat_activity a join pg_locks l on l.pid = a.pid and l.locktype = 'advisory' and not l.granted
          where a.pid = $1`, [B.pid]);
      if (w.rows.length) { out.bBlocked = true; out.bWaitEvent = `${w.rows[0].wait_event_type}/${w.rows[0].wait_event}`; out.lockRow = w.rows[0]; break; }
      await sleep(25);
    }
    out.bDoneBeforeACommit = bSettled;
    out.aCommitAt = Date.now() - t0;
    if (out.A.ok) await A.commit(); else await A.rollback();
    out.B = await bP;
    if (out.B.ok) await B.commit(); else await B.rollback();
  } finally {
    await A.rollback(); await B.rollback();
    await A.close(); await B.close(); await mon.end();
  }
  return out;
}

async function snapshot(db: Client, campaignPrefix: string, date?: string) {
  const r = await db.query(
    `select spend_date::text d, campaign_key, ad_key, spend_php::text s
       from public.ad_spend_daily where campaign_key like $1 ${date ? "and spend_date = $2::date" : ""}
      order by 1, 2, 3`, date ? [campaignPrefix + "%", date] : [campaignPrefix + "%"]);
  const sum = r.rows.reduce((t, x) => t + Number(x.s), 0);
  return { rows: r.rows as { d: string; campaign_key: string; ad_key: string; s: string }[], sum, text: r.rows.map((x) => `${x.campaign_key}|${x.ad_key}=${x.s}`).join(", ") };
}

async function clean(db: Client, prefix: string) {
  await db.query("delete from public.ad_spend_daily where campaign_key like $1", [prefix + "%"]);
}

const TOTAL = (d: string, c: string, s: number) => mk(d, c, "(campaign)", s);

async function case1(db: Client, label: string, tag: string, date: string, totalFirst: boolean, expectSerialised: boolean) {
  const camp = `concproof-${tag}`;
  await clean(db, camp);
  const totals = [TOTAL(date, camp, 1000)];
  const perAd = [mk(date, camp, "adA", 600), mk(date, camp, "adB", 400)];
  const o = await overlap(
    { rows: totalFirst ? totals : perAd },
    { rows: totalFirst ? perAd : totals },
  );
  const snap = await snapshot(db, camp, date);
  const kinds = new Set(snap.rows.map((r) => (r.ad_key === "(campaign)" ? "total" : "ad")));
  const oneRep = kinds.size === 1;
  const noDouble = snap.sum === 1000;
  const loser = o.B;
  console.log(`   [${label}] A ${totalFirst ? "total" : "per-ad"} then B ${totalFirst ? "per-ad" : "total"}: B blocked=${o.bBlocked} (${o.bWaitEvent}) B done before A commit=${o.bDoneBeforeACommit}; B outcome=${loser?.ok ? JSON.stringify(loser.value) : `${loser?.code} ${loser?.msg}`}`);
  const serialisedOk = expectSerialised ? o.bBlocked && !o.bDoneBeforeACommit : true;
  return { o, snap, oneRep, noDouble, serialisedOk };
}

async function main() {
  const db = await admin();
  const dbInfo = (await db.query("select current_setting('server_version') v, inet_server_port() p")).rows[0];
  console.log(`Connected: postgres ${dbInfo.v} on port ${dbInfo.p}`);

  // Fixture: committed admin (cleaned up at the end).
  const email = `ad-spend-conc-proof-${Date.now()}@example.test`;
  adminId = (await db.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '', now(), now(), now()) returning id`, [email])).rows[0].id;
  await db.query("insert into public.staff_profiles (id, full_name, role, is_active) values ($1, 'Conc Proof Admin', 'admin', true)", [adminId]);

  const sigDef = "select pg_get_functiondef('public.ad_spend_import(uuid,jsonb,integer)'::regprocedure) d";
  const originalDef: string = (await db.query(sigDef)).rows[0].d;
  if (!/pg_advisory_xact_lock\(hashtext\('ad_spend_import'\)\)/.test(originalDef)) throw new Error("Deployed ad_spend_import has no advisory lock (unexpected)");

  async function suite(control: boolean) {
    const P = control ? "concproof-ctl" : "concproof";

    // ---- Case 1 (+5 lock bites): total vs per-ad, same campaign/day, both orders ----
    for (const [totalFirst, n] of [[true, "a"], [false, "b"]] as const) {
      const r = await case1(db, control ? "control" : "locked", `${control ? "ctl-" : ""}c1${n}`, "2031-01-01", totalFirst, !control);
      if (!control) {
        record(`Case 1${n} ${totalFirst ? "total-then-per-ad" : "per-ad-then-total"}: exactly one representation, no doubled spend`,
          r.oneRep && r.noDouble, `final rows: ${r.snap.text}; sum=${r.snap.sum}; loser B ${r.o.B?.ok ? "WAITED then replaced (inserted/replaced=" + JSON.stringify(r.o.B.value) + ")" : "REFUSED " + r.o.B?.code}`);
        record(`Case 5${n} lock bites: B blocked on advisory lock until A committed`,
          r.o.bBlocked && !r.o.bDoneBeforeACommit && (r.o.B?.endedAt ?? 0) >= r.o.aCommitAt,
          `monitor saw B pid waiting ${r.o.bWaitEvent}, ungranted advisory lock ${JSON.stringify(r.o.lockRow)}; A commit at ${r.o.aCommitAt}ms, B returned at ${r.o.B?.endedAt}ms`);
      } else {
        // In the control the bug is EXPECTED: record PASS when we can reproduce the double.
        record(`CONTROL ${totalFirst ? "total-then-per-ad" : "per-ad-then-total"} (lock removed): spend CAN double`,
          !r.noDouble && !r.oneRep && !r.o.bBlocked,
          `B blocked=${r.o.bBlocked}, B finished before A commit=${r.o.bDoneBeforeACommit}; final rows: ${r.snap.text}; sum=${r.snap.sum} (correct would be 1000)`);
      }
    }
    if (control) return;

    // ---- Case 2: same per-ad breakdown, partial uploads: siblings preserved ----
    {
      const camp = `${P}-c2`; await clean(db, camp);
      // pre-existing sibling ad0 (committed) plus A uploads ad1, B uploads ad2 concurrently
      const seed = await new Session().open(); await seed.imp([mk("2031-01-02", camp, "ad0", 50)]); await seed.commit(); await seed.close();
      const o = await overlap({ rows: [mk("2031-01-02", camp, "ad1", 100)] }, { rows: [mk("2031-01-02", camp, "ad2", 200)] });
      const s = await snapshot(db, camp, "2031-01-02");
      record("Case 2 per-ad partial uploads A=ad1, B=ad2 (+ pre-existing ad0): all siblings kept",
        s.rows.length === 3 && s.sum === 350 && o.bBlocked && !!o.A?.ok && !!o.B?.ok,
        `final rows: ${s.text}; sum=${s.sum} (expect 350); B blocked=${o.bBlocked}`);
      // and empty-day start
      const camp2 = `${P}-c2e`; await clean(db, camp2);
      const o2 = await overlap({ rows: [mk("2031-01-03", camp2, "ad1", 100)] }, { rows: [mk("2031-01-03", camp2, "ad2", 200)] });
      const s2 = await snapshot(db, camp2, "2031-01-03");
      record("Case 2b same, starting from an EMPTY campaign-day: no lost update",
        s2.rows.length === 2 && s2.sum === 300 && !!o2.A?.ok && !!o2.B?.ok, `final rows: ${s2.text}; sum=${s2.sum} (expect 300)`);
    }

    // ---- Case 3: breakdown change with rejected rows vs a normal import ----
    {
      const camp = `${P}-c3`; await clean(db, camp);
      const otherDay = mk("2031-01-05", camp, "adZ", 999); // same file, different day: must NOT be saved if the file is refused
      // A normal total import commits; B is per-ad with p_rejected_count=1 -> breakdown change -> refuse
      const o = await overlap({ rows: [TOTAL("2031-01-04", camp, 1000)] }, { rows: [mk("2031-01-04", camp, "adA", 600), mk("2031-01-04", camp, "adB", 400), otherDay], rejected: 1 });
      const s = await snapshot(db, camp);
      const refused = !o.B?.ok && o.B?.code === "22023" && /\[breakdown change\]/.test(o.B?.msg ?? "");
      record("Case 3a total (normal) vs per-ad with rejected>0: loser REFUSED, no partial state",
        refused && s.rows.length === 1 && s.rows[0].ad_key === "(campaign)" && s.sum === 1000 && o.bBlocked,
        `B ${o.B?.ok ? "succeeded" : "refused " + o.B?.code}; final rows: ${s.text}; sum=${s.sum}; adZ on other day saved? ${s.rows.some((r) => r.ad_key === "adZ")}`);

      // reverse: per-ad normal commits first, then a total file with rejected>0
      const camp2 = `${P}-c3b`; await clean(db, camp2);
      const o2 = await overlap({ rows: [mk("2031-01-06", camp2, "adA", 600), mk("2031-01-06", camp2, "adB", 400)] }, { rows: [TOTAL("2031-01-06", camp2, 1000), mk("2031-01-07", camp2, "(campaign)", 5)], rejected: 2 });
      const s2 = await snapshot(db, camp2);
      record("Case 3b per-ad (normal) vs total with rejected>0: loser REFUSED, no partial state",
        !o2.B?.ok && o2.B?.code === "22023" && s2.rows.length === 2 && s2.sum === 1000 && !s2.rows.some((r) => r.d === "2031-01-07") && o2.bBlocked,
        `B ${o2.B?.ok ? "succeeded" : "refused " + o2.B?.code}; final rows: ${s2.text}; sum=${s2.sum}`);

      // Rejected>0 file that does NOT change breakdown is still allowed (sanity, not over-refusing)
      const o3 = await overlap({ rows: [mk("2031-01-08", camp2, "adA", 1)] }, { rows: [mk("2031-01-08", camp2, "adB", 2)], rejected: 3 });
      const s3 = await snapshot(db, camp2, "2031-01-08");
      record("Case 3c same-breakdown upload with rejected>0 is NOT refused (sibling kept)", !!o3.B?.ok && s3.rows.length === 2 && s3.sum === 3, `final rows: ${s3.text}`);
    }

    // ---- Case 4: two concurrent identical uploads ----
    for (const same of [false, true]) {
      const camp = `${P}-c4${same ? "s" : "d"}`; await clean(db, camp);
      const rows = [mk("2031-01-09", camp, "adA", 600), mk("2031-01-09", camp, "adB", 400)];
      const up = same ? "11111111-1111-1111-1111-11111111111" + (same ? "1" : "2") : undefined;
      const o = await overlap({ rows }, { rows }, { uploadA: up, uploadB: up });
      const s = await snapshot(db, camp, "2031-01-09");
      record(`Case 4${same ? "b (same upload_id)" : "a (different upload_ids)"} identical uploads idempotent`,
        s.rows.length === 2 && s.sum === 1000 && !!o.A?.ok && !!o.B?.ok,
        `B result ${JSON.stringify(o.B?.value)}; final rows: ${s.text}; sum=${s.sum}`);
    }

    // ---- Case 5c: unracy simultaneous Promise.all rounds (no forced hold) ----
    {
      let bad = 0; const N = 25; const camp = `${P}-c5r`;
      for (let i = 0; i < N; i++) {
        await clean(db, camp);
        const A = await new Session().open(); const B = await new Session().open();
        const ra = [TOTAL("2031-02-01", camp, 1000)];
        const rb = [mk("2031-02-01", camp, "adA", 600), mk("2031-02-01", camp, "adB", 400)];
        const run = async (S: Session, rows: Row[]) => { try { await S.imp(rows); await S.commit(); return true; } catch { await S.rollback(); return false; } };
        await Promise.all([run(A, ra), run(B, rb)]);
        await A.close(); await B.close();
        const s = await snapshot(db, camp, "2031-02-01");
        const kinds = new Set(s.rows.map((r) => (r.ad_key === "(campaign)" ? "t" : "a")));
        if (kinds.size !== 1 || s.sum !== 1000) bad++;
      }
      record(`Case 5c ${N} unforced Promise.all races (total vs per-ad): never a doubled/mixed state`, bad === 0, `${bad} of ${N} rounds ended mixed/doubled`);
    }

    // ---- Case 6 (P5, 0193): a DIRECT RPC call mixing a campaign total and per-ad rows for one
    // group is refused 22023 [mixed breakdown] and writes nothing (the parser refuses such a file,
    // but the RPC must not trust it). Also an id:-keyed + name-keyed mix, and a clean sibling group
    // in the same call is not saved either (all-or-nothing).
    {
      const camp = `${P}-c6`; await clean(db, camp);
      const D = "2031-04-01";
      const attempts: [string, Row[]][] = [
        ["total + per-ad-name", [TOTAL(D, camp, 1000), mk(D, camp, "adA", 600), mk(D, `${camp}-ok`, "adZ", 5)]],
        ["per-ad-name + per-ad-id", [mk(D, camp, "adA", 600), mk(D, camp, "id:123", 400)]],
      ];
      for (const [label, rows] of attempts) {
        const S6 = await new Session().open();
        let out: Outcome;
        try { out = { ok: true, value: (await S6.imp(rows)).rows[0].r, endedAt: 0 }; }
        catch (e) { const er = e as Error & { code?: string }; out = { ok: false, code: er.code, msg: er.message, endedAt: 0 }; }
        await S6.rollback(); await S6.close();
        // (the failed statement aborts its transaction, so nothing can have been committed either way;
        // the stronger evidence is the SEPARATE committing session below)
        const s6 = await snapshot(db, camp);
        record(`Case 6 (P5) direct RPC ${label}: refused 22023 [mixed breakdown], nothing written`,
          !out.ok && out.code === "22023" && /\[mixed breakdown\]/.test(out.msg ?? "") && s6.rows.length === 0,
          `outcome ${out.ok ? "SUCCEEDED " + JSON.stringify(out.value) : "refused " + out.code + " " + out.msg}; rows left=${s6.rows.length}`);
      }
      // Committing variant: if the guard were missing the import would succeed and COMMIT a mixed group.
      const S7 = await new Session().open();
      let refused = false;
      try { await S7.imp([TOTAL(D, camp, 1000), mk(D, camp, "adA", 600)]); await S7.commit(); } catch { refused = true; await S7.rollback(); }
      await S7.close();
      const s7 = await snapshot(db, camp);
      record("Case 6b (P5) the same mixed call, with a COMMIT attempted: refused and no mixed group persisted",
        refused && s7.rows.length === 0, `refused=${refused}; rows persisted=${s7.rows.length} (${s7.text})`);
    }

    // ---- Case 5d: ad_spend_delete also serialises behind an open import ----
    {
      const camp = `${P}-c5d`; await clean(db, camp);
      const A = await new Session().open(); const B = await new Session().open(); const mon = await admin();
      await A.imp([mk("2031-03-01", camp, "adA", 10)]);
      let settled = false;
      const bP = B.c.query("select public.ad_spend_delete('meta','2031-03-01','2031-03-01') as r").then((r) => { settled = true; return r; });
      await sleep(600);
      const blocked = (await mon.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted", [B.pid])).rows.length === 1;
      const wasSettled = settled;
      await A.commit(); const r = await bP; await B.commit();
      const s = await snapshot(db, camp, "2031-03-01");
      record("Case 5d ad_spend_delete blocks behind an open import, then removes it (no orphan)", blocked && !wasSettled && s.rows.length === 0, `delete blocked=${blocked}; deleted=${JSON.stringify(r.rows[0].r)}; rows left=${s.rows.length}`);
      await A.close(); await B.close(); await mon.end();
    }
  }

  try {
    await suite(false);
    if (RUN_CONTROL) {
      // CONTROL: strip the lock line in THIS database only, prove the double, then restore.
      const stripped = originalDef.replace(/^\s*perform pg_advisory_xact_lock\(hashtext\('ad_spend_import'\)\);\s*$/m, "  -- (control) lock removed");
      if (stripped === originalDef) throw new Error("control: could not strip the lock line");
      await db.query(stripped);
      try { await suite(true); }
      finally {
        await db.query(originalDef);
        const restored: string = (await db.query(sigDef)).rows[0].d;
        record("Control restore: ad_spend_import is byte-identical to the original again", restored === originalDef, restored === originalDef ? "definition restored" : "DEFINITION DIFFERS - re-run migration 0189");
      }
    }
  } finally {
    for (const p of ["concproof", "concproof-ctl"]) await clean(db, p).catch(() => {});
    const cl = await db.query("delete from public.audit_log where actor_id = $1", [adminId]).then(() => "audit rows removed").catch((e) => `audit cleanup skipped: ${e.message}`);
    const cl2 = await db.query("delete from public.staff_profiles where id = $1", [adminId]).then(async () => { await db.query("delete from auth.users where id=$1", [adminId]); return "fixture admin removed"; }).catch((e) => `fixture left in place: ${e.message}`);
    console.log(`cleanup: ${cl}; ${cl2}`);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
