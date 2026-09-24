// Hand-run local database proofs for Sheet Sync (migration
// supabase/migrations/0170_sheet_sync_foundation.sql).
//
// Modeled on scripts/perf/rls-equivalence-prove.ts: everything happens inside
// ONE transaction that is unconditionally rolled back at the end, so this
// script never leaves anything behind and can be re-run without a db:reset.
// Unlike that script (which snapshots-diffs-snapshots), this one exercises
// real RPC call sequences — leases, fencing, fills, reverts — because those
// invariants can't be proven by a before/after row-visibility diff.
//
// STRUCTURE
// ---------
// Each of the 11 checks below is its own named `check()` block, wrapped in a
// SAVEPOINT: on success the savepoint is released (its mutations persist, so
// later checks can build on earlier state — e.g. the "Lease + fencing" check
// leaves nothing running, "Create" leaves a real created patient behind);
// on failure it rolls back (so one broken check does not corrupt the ones
// after it) and the failure is recorded as a FAIL line.
//
// Inside a check, `expectPgError()` wraps a nested savepoint around a single
// call that is expected to throw a specific SQLSTATE (42501 permission
// denied, P0062/P0063/P0064, or 22023) — Postgres aborts the transaction on
// any error, and only ROLLBACK TO SAVEPOINT can recover it, so every
// "this must fail" assertion needs its own savepoint. `scoped()` is the same
// mechanism used the other way: always undo, even on success — for the
// ownership-trigger probes in check 3, which deliberately mutate the shared
// fixture patient and must not let that mutation leak into later checks.
//
// GOTCHA: now() IS FROZEN FOR THE WHOLE SCRIPT. Every statement in this
// script runs inside one transaction, and Postgres's `now()` returns the
// transaction's start time everywhere inside it — including inside the
// migration's own PL/pgSQL (`last_seen_at = now()`, `heartbeat_at = now()`,
// …). So two upserts of the same review item, a heartbeat, and a run's
// started_at can all carry the IDENTICAL timestamp; "last_seen_at moved" is
// not observable here. Where the plan describes a timestamp-based proof
// (review-item dedupe), this script instead proves the update actually ran
// by checking that `run_id` moved to the new run — a signal `now()` freezing
// cannot fake.
//
// LEASE INDEPENDENCE: checks 4-11 each acquire and finish their own lease(s)
// rather than passing a lease token between checks. That costs a few extra
// RPC round trips but means a failure in one check's lease dance can never
// leave a stray "running" row that makes an unrelated later check fail for
// the wrong reason.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { Client, type QueryResult, type QueryResultRow } from "pg";

requireLocalOrExplicitProd("sheet-sync:db-proof", {
  writes: "nothing — every check runs in one transaction that is rolled back",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Belt-and-suspenders on top of the guard above: this script must NEVER run
// against a non-local host, even with --prod (unlike the seed/import runners,
// there is no legitimate reason to run a lease/fencing/revert proof against
// the live clinic database).
if (!/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error(
    `[sheet-sync:db-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// RPC results are jsonb with a shape specific to each function; narrowly
// typing each one would be pure noise for a proof script.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

type DbRole = "postgres" | "anon" | "authenticated" | "service_role";
type Claims = Record<string, string> | null;

interface Fixtures {
  adminId: string;
  receptionId: string;
  inactiveAdminId: string;
  patientPId: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  async function q<R extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<R>> {
    return db.query<R>(sql, params);
  }

  function describeError(err: unknown): string {
    if (err instanceof Error) {
      const code = (err as Error & { code?: string }).code;
      const first = err.message.split("\n")[0];
      return code ? `[${code}] ${first}` : first;
    }
    return String(err);
  }

  function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
  }

  async function setRole(role: DbRole, claims: Claims): Promise<void> {
    if (role === "postgres") {
      await q("reset role");
      await q("select set_config('request.jwt.claims', '', true)");
      return;
    }
    await q(`set local role ${role}`);
    await q("select set_config('request.jwt.claims', $1, true)", [
      claims ? JSON.stringify(claims) : "",
    ]);
  }

  /** Runs fn(); if it throws, undoes the throw's transaction-abort state and re-asserts the code matches. */
  async function expectPgError(
    label: string,
    code: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    await q("savepoint sp_err");
    let caught: unknown = null;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    await q("rollback to savepoint sp_err");
    if (!caught) {
      throw new Error(`${label}: expected error ${code}, but the call succeeded`);
    }
    const gotCode = (caught as Error & { code?: string }).code;
    if (gotCode !== code) {
      throw new Error(
        `${label}: expected code ${code}, got ${gotCode ?? "?"} (${describeError(caught)})`,
      );
    }
  }

  /** Runs fn(); on any error, rethrows with `label` attached so a FAIL line says which sub-assertion broke. */
  async function expectOk<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new Error(`${label}: unexpected error — ${describeError(err)}`);
    }
  }

  /** Always undoes fn()'s mutations, success or failure — for probes that must not leak state into later checks. */
  async function scoped<T>(fn: () => Promise<T>): Promise<T> {
    await q("savepoint sp_scoped");
    try {
      return await fn();
    } finally {
      await q("rollback to savepoint sp_scoped").catch(() => {});
    }
  }

  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    await q("savepoint sp_check");
    try {
      await setRole("postgres", null);
      await fn();
      await q("release savepoint sp_check");
      results.push({ name, ok: true, detail: "" });
      console.log(`PASS ${name}`);
    } catch (err) {
      await q("rollback to savepoint sp_check").catch(() => {});
      const detail = describeError(err);
      results.push({ name, ok: false, detail });
      console.log(`FAIL ${name} — ${detail}`);
    } finally {
      await setRole("postgres", null).catch(() => {});
    }
  }

  async function acquire(
    trigger: string,
    dryRun = false,
  ): Promise<{ token: string; runId: string; status: string }> {
    const r = await q<{ j: Json }>(
      `select public.sheet_sync_acquire($1, null, $2) as j`,
      [trigger, dryRun],
    );
    const j = r.rows[0].j;
    return { token: j.lease_token, runId: j.run_id, status: j.status };
  }

  async function finish(token: string, status = "succeeded"): Promise<void> {
    await q(
      `select public.sheet_sync_finish($1::uuid, $2, '{}'::jsonb, '{}'::jsonb, null)`,
      [token, status],
    );
  }

  async function setupFixtures(): Promise<Fixtures> {
    const ids = await q<{ id: string }>(`
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, '', now(), now(), now()
      from unnest(array[
        'sheet-sync-proof-admin@example.test',
        'sheet-sync-proof-reception@example.test',
        'sheet-sync-proof-inactive-admin@example.test'
      ]) as email
      returning id
    `);
    const [adminId, receptionId, inactiveAdminId] = ids.rows.map((r) => r.id);

    await q(
      `insert into public.staff_profiles (id, full_name, role, is_active) values
         ($1, 'Proof Admin', 'admin', true),
         ($2, 'Proof Reception', 'reception', true),
         ($3, 'Proof Inactive Admin', 'admin', false)`,
      [adminId, receptionId, inactiveAdminId],
    );

    // "one patient P (referral_source = 'walk_in') inserted as postgres with
    // no setting -> assert origin staff, row_version = 0."
    const p = await q<{ id: string; origin: string | null; rv: string }>(`
      insert into public.patients (first_name, last_name, birthdate, referral_source)
      values ('Juan', 'Dela Cruz', '1990-05-14', 'walk_in')
      returning id, referral_source_origin as origin, row_version::text as rv
    `);
    assert(
      p.rows[0].origin === "staff",
      `fixture patient P: expected origin 'staff' on insert, got ${p.rows[0].origin}`,
    );
    assert(
      p.rows[0].rv === "0",
      `fixture patient P: expected row_version 0 on insert, got ${p.rows[0].rv}`,
    );

    await q(`update public.sheet_sync_settings set paused = false where id`);

    // One throwaway run + one dummy row per admin-read table, so check 1's
    // count-based ACL probes exercise tables that actually hold a row, not
    // just RLS-on-empty (which a missing policy could pass by accident).
    const seedRun = await q<{ id: string }>(
      `insert into public.sheet_sync_runs (trigger, status, ended_at) values ('manual','succeeded', now()) returning id`,
    );
    const seedRunId = seedRun.rows[0].id;

    await q(
      `insert into public.sheet_sync_review_items (tab, item_key, kind) values ('customers','probe-review-1','ambiguous_patient')`,
    );
    await q(
      `insert into public.sheet_sync_changes (run_id, patient_id, change_kind, row_version_after) values ($1, gen_random_uuid(), 'create', 0)`,
      [seedRunId],
    );
    await q(
      `insert into public.sheet_patient_links (link_key, decision, method) values ('probe-link-1','create','admin')`,
    );
    await q(
      `insert into public.patient_acquisition_facts (patient_id) values ($1)`,
      [p.rows[0].id],
    );
    await q(
      `insert into public.referral_source_aliases (raw_normalized, referral_source_id) values ('probe-alias-1','other')`,
    );
    await q(
      `insert into public.sheet_customer_rows
         (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, link_state, row_hash, run_id)
       values (1, 'probe-src-1', 'Probe Person', 'probe|person', 'probe', 'probe-link-cust', 'unlinked', 'hash-cust-1', $1)`,
      [seedRunId],
    );
    await q(
      `insert into public.sheet_encounter_lines
         (tab, sheet_row, service_date, name_raw, name_norm, loose_key, identity_key, raw, row_hash, run_id)
       values ('lab', 1, current_date, 'Probe Person', 'probe|person', 'probe', 'name:probe|person', '{}'::jsonb, 'hash-enc-1', $1)`,
      [seedRunId],
    );
    await q(
      `insert into public.sheet_mirror_staging (run_id, tab, row) values ($1, 'lab', '{}'::jsonb)`,
      [seedRunId],
    );

    return {
      adminId,
      receptionId,
      inactiveAdminId,
      patientPId: p.rows[0].id,
    };
  }

  // ---------------------------------------------------------------------
  await q("begin");
  try {
    const fx = await setupFixtures();

    const READ_TABLES = [
      "sheet_sync_settings",
      "sheet_sync_runs",
      "sheet_sync_review_items",
      "sheet_sync_changes",
      "sheet_patient_links",
      "patient_acquisition_facts",
      "referral_source_aliases",
      "sheet_customer_rows",
      "sheet_encounter_lines",
    ];

    // 1. ACL matrix ---------------------------------------------------
    await check("ACL matrix", async () => {
      const principals: {
        label: string;
        role: DbRole;
        claims: Claims;
        expect: "some" | "zero" | "denied";
      }[] = [
        {
          label: "admin",
          role: "authenticated",
          claims: { sub: fx.adminId, role: "authenticated" },
          expect: "some",
        },
        {
          label: "reception",
          role: "authenticated",
          claims: { sub: fx.receptionId, role: "authenticated" },
          expect: "zero",
        },
        {
          label: "inactive admin",
          role: "authenticated",
          claims: { sub: fx.inactiveAdminId, role: "authenticated" },
          expect: "zero",
        },
        { label: "anon", role: "anon", claims: null, expect: "denied" },
        {
          label: "portal patient",
          role: "anon",
          claims: { role: "anon", patient_id: fx.patientPId },
          expect: "denied",
        },
      ];

      for (const p of principals) {
        for (const t of READ_TABLES) {
          await setRole(p.role, p.claims);
          const label = `ACL ${p.label}/${t}`;
          if (p.expect === "denied") {
            await expectPgError(label, "42501", () =>
              q(`select count(*) from public.${t}`),
            );
          } else {
            const n = Number(
              (
                await expectOk(label, () =>
                  q<{ n: string }>(`select count(*)::text as n from public.${t}`),
                )
              ).rows[0].n,
            );
            if (p.expect === "some") {
              assert(n > 0, `${label}: expected >0 rows, got ${n}`);
            } else {
              assert(n === 0, `${label}: expected 0 rows, got ${n}`);
            }
          }
        }
        // sheet_mirror_staging: no policy AND no grant for any JWT role.
        await setRole(p.role, p.claims);
        await expectPgError(
          `ACL ${p.label}/sheet_mirror_staging`,
          "42501",
          () => q(`select count(*) from public.sheet_mirror_staging`),
        );
      }
    });

    // 2. RPC ACL --------------------------------------------------------
    await check("RPC ACL", async () => {
      const NIL = "00000000-0000-0000-0000-000000000000";
      const rpcs: { name: string; sql: string }[] = [
        {
          name: "sheet_sync_acquire",
          sql: `select public.sheet_sync_acquire('probe'::text, null::uuid, true::boolean)`,
        },
        {
          name: "sheet_sync_heartbeat",
          sql: `select public.sheet_sync_heartbeat('${NIL}'::uuid)`,
        },
        {
          name: "sheet_sync_finish",
          sql: `select public.sheet_sync_finish('${NIL}'::uuid, 'succeeded', '{}'::jsonb, '{}'::jsonb, null)`,
        },
        {
          name: "sheet_mirror_stage",
          sql: `select public.sheet_mirror_stage('${NIL}'::uuid, 'lab', '[]'::jsonb)`,
        },
        {
          name: "sheet_mirror_commit",
          sql: `select public.sheet_mirror_commit('${NIL}'::uuid, 'lab')`,
        },
        {
          name: "sheet_sync_apply_customer_ops",
          sql: `select public.sheet_sync_apply_customer_ops('${NIL}'::uuid, '[]'::jsonb)`,
        },
        {
          name: "sheet_sync_upsert_review",
          sql: `select public.sheet_sync_upsert_review('${NIL}'::uuid, 'customers', '[]'::jsonb, false)`,
        },
        {
          name: "sheet_resort_apply",
          sql: `select public.sheet_resort_apply('${NIL}'::uuid, array[]::uuid[], null, null)`,
        },
        {
          name: "sheet_alias_apply",
          sql: `select public.sheet_alias_apply('${NIL}'::uuid, 'probe', 'other', null)`,
        },
        {
          name: "sheet_sync_revert_run",
          sql: `select public.sheet_sync_revert_run('${NIL}'::uuid, '${NIL}'::uuid)`,
        },
        {
          name: "sheet_review_resolve",
          sql: `select public.sheet_review_resolve('${NIL}'::uuid, null, 'dismiss', null)`,
        },
        {
          name: "sheet_resort_candidates",
          sql: `select * from public.sheet_resort_candidates()`,
        },
      ];

      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      for (const rpc of rpcs) {
        await expectPgError(`RPC ${rpc.name} as authenticated`, "42501", () =>
          q(rpc.sql),
        );
      }

      await setRole("service_role", null);
      const a = await expectOk("service_role acquire", () => acquire("manual", true));
      assert(
        a.status === "running",
        `service_role acquire: expected status running, got ${a.status}`,
      );
      await finish(a.token);
    });

    // 3. Ownership trigger ------------------------------------------------
    await check("Ownership trigger", async () => {
      // Authenticated admin spoofs referral_source_origin directly in the
      // UPDATE — the trigger must ignore it and stamp 'staff' (no
      // app.referral_origin set), and row_version must go up by exactly 1.
      await scoped(async () => {
        await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
        const r = await q<{ origin: string | null; rv: string }>(
          `update public.patients set referral_source = 'online_google', referral_source_origin = 'sheet'
             where id = $1
           returning referral_source_origin as origin, row_version::text as rv`,
          [fx.patientPId],
        );
        assert(
          r.rows[0].origin === "staff",
          `spoofed-origin update: expected origin 'staff', got ${r.rows[0].origin}`,
        );
        assert(
          r.rows[0].rv === "1",
          `spoofed-origin update: expected row_version 1, got ${r.rows[0].rv}`,
        );
      });

      // postgres, no app.referral_origin setting -> also defaults to 'staff'.
      await scoped(async () => {
        await setRole("postgres", null);
        const r = await q<{ origin: string | null }>(
          `update public.patients set referral_source = 'online_facebook' where id = $1
           returning referral_source_origin as origin`,
          [fx.patientPId],
        );
        assert(
          r.rows[0].origin === "staff",
          `postgres direct change: expected origin 'staff', got ${r.rows[0].origin}`,
        );
      });

      // resolve_patient_guarded (service_role only) stamps 'patient' for a
      // brand-new row.
      await setRole("service_role", null);
      const created = await q<{ id: string }>(
        `select id from public.resolve_patient_guarded(
           'sheet-sync-proof-resolve@example.test', 'Santos', '1985-05-05'::date,
           jsonb_build_object('first_name','Maria','last_name','Santos','birthdate','1985-05-05','referral_source','online_facebook')
         )`,
      );
      assert(
        created.rows.length === 1,
        `resolve_patient_guarded: expected 1 row, got ${created.rows.length}`,
      );
      const newId = created.rows[0].id;
      const origin1 = await q<{ origin: string | null }>(
        `select referral_source_origin as origin from public.patients where id = $1`,
        [newId],
      );
      assert(
        origin1.rows[0].origin === "patient",
        `resolve_patient_guarded: expected origin 'patient', got ${origin1.rows[0].origin}`,
      );

      // Setting the new row's source to NULL clears the origin too.
      const cleared = await q<{ origin: string | null; source: string | null }>(
        `update public.patients set referral_source = null where id = $1
         returning referral_source_origin as origin, referral_source as source`,
        [newId],
      );
      assert(
        cleared.rows[0].source === null,
        `sanity: expected referral_source null, got ${cleared.rows[0].source}`,
      );
      assert(
        cleared.rows[0].origin === null,
        `null-source update: expected origin null, got ${cleared.rows[0].origin}`,
      );
    });

    // 4. Pause ------------------------------------------------------------
    await check("Pause", async () => {
      await setRole("service_role", null);
      await q(`update public.sheet_sync_settings set paused = true where id`);

      const skip = await q<{ j: Json }>(
        `select public.sheet_sync_acquire('cron', null, false) as j`,
      );
      assert(
        skip.rows[0].j.status === "skipped_paused",
        `paused cron (dry_run=false): expected skipped_paused, got ${JSON.stringify(skip.rows[0].j)}`,
      );
      const skipRunStatus = await q<{ status: string }>(
        `select status from public.sheet_sync_runs where id = $1`,
        [skip.rows[0].j.run_id],
      );
      assert(
        skipRunStatus.rows[0].status === "skipped_paused",
        `paused cron: expected the run row's status to be skipped_paused, got ${skipRunStatus.rows[0].status}`,
      );

      const dry = await acquire("cron", true);
      assert(
        dry.status === "running",
        `paused cron (dry_run=true): expected running, got ${dry.status}`,
      );
      await finish(dry.token);

      await q(`update public.sheet_sync_settings set paused = false where id`);
    });

    // 5. Lease + fencing ----------------------------------------------------
    await check("Lease + fencing", async () => {
      await setRole("service_role", null);

      const a = await acquire("manual", false);
      assert(a.status === "running", `acquire A: expected running, got ${a.status}`);

      await expectPgError("acquire B while A's lease is fresh", "P0062", () =>
        q(`select public.sheet_sync_acquire('cli', null, false)`),
      );

      await q(
        `update public.sheet_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`,
        [a.runId],
      );

      const b = await acquire("cli", false);
      assert(
        b.status === "running",
        `acquire B after A went stale: expected running, got ${b.status}`,
      );
      const aStatus = await q<{ status: string }>(
        `select status from public.sheet_sync_runs where id = $1`,
        [a.runId],
      );
      assert(
        aStatus.rows[0].status === "failed",
        `A after being superseded: expected status failed, got ${aStatus.rows[0].status}`,
      );

      await expectPgError("stage with A's superseded token", "P0063", () =>
        q(`select public.sheet_mirror_stage($1::uuid, 'lab', '[]'::jsonb)`, [a.token]),
      );
      await expectPgError("finish with A's superseded token", "P0063", () =>
        q(`select public.sheet_sync_finish($1::uuid, 'succeeded', '{}'::jsonb, '{}'::jsonb, null)`, [
          a.token,
        ]),
      );

      await finish(b.token);
    });

    // 6. Snapshot atomicity --------------------------------------------
    await check("Snapshot atomicity", async () => {
      await setRole("service_role", null);

      const before = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_encounter_lines where tab = 'lab'`,
      );
      assert(
        before.rows[0].n === "1",
        `baseline: expected the 1 pre-existing lab row, got ${before.rows[0].n}`,
      );

      const c = await acquire("manual", false);
      assert(c.status === "running", `acquire C: expected running, got ${c.status}`);

      const chunk = (from: number) =>
        JSON.stringify(
          [0, 1].map((i) => ({
            sheet_row: from + i,
            service_date: "2026-09-20",
            name_raw: `Probe Lab ${from + i}`,
            name_norm: `probe lab ${from + i}`,
            loose_key: `probelab${from + i}`,
            identity_key: `name:probelab${from + i}|2026-09-20`,
            raw: {},
            row_hash: `hash-lab-${from + i}`,
          })),
        );

      for (const from of [1, 3, 5]) {
        const staged = await q<{ sheet_mirror_stage: number }>(
          `select public.sheet_mirror_stage($1::uuid, 'lab', $2::jsonb)`,
          [c.token, chunk(from)],
        );
        assert(
          staged.rows[0].sheet_mirror_stage === 2,
          `stage chunk starting at ${from}: expected 2 rows staged, got ${staged.rows[0].sheet_mirror_stage}`,
        );
      }

      const mid = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_encounter_lines where tab = 'lab'`,
      );
      assert(
        mid.rows[0].n === "1",
        `after staging, before commit: expected the pre-existing row untouched, got ${mid.rows[0].n}`,
      );

      const committed = await q<{ sheet_mirror_commit: number }>(
        `select public.sheet_mirror_commit($1::uuid, 'lab')`,
        [c.token],
      );
      assert(
        committed.rows[0].sheet_mirror_commit === 6,
        `commit: expected 6 rows inserted, got ${committed.rows[0].sheet_mirror_commit}`,
      );

      const after = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_encounter_lines where tab = 'lab'`,
      );
      assert(
        after.rows[0].n === "6",
        `after commit: expected exactly 6 rows (full replace), got ${after.rows[0].n}`,
      );

      const stagingLeft = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_mirror_staging
           where run_id = (select id from public.sheet_sync_runs where lease_token = $1)`,
        [c.token],
      );
      assert(
        stagingLeft.rows[0].n === "0",
        `after commit: expected C's staging rows cleared, got ${stagingLeft.rows[0].n}`,
      );

      await finish(c.token);

      // A stale token must not be able to commit, and must leave live rows alone.
      const d = await acquire("manual", false);
      await q(
        `update public.sheet_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`,
        [d.runId],
      );
      const e = await acquire("cli", false);

      await expectPgError("commit with a stale/superseded token", "P0063", () =>
        q(`select public.sheet_mirror_commit($1::uuid, 'lab')`, [d.token]),
      );

      const final = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_encounter_lines where tab = 'lab'`,
      );
      assert(
        final.rows[0].n === "6",
        `after the stale-token attempt: expected the 6 committed rows untouched, got ${final.rows[0].n}`,
      );

      await finish(e.token);
    });

    // 7. Conditional fill never overwrites -------------------------------
    await check("Conditional fill never overwrites", async () => {
      await setRole("service_role", null);

      const patient = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate, phone, referral_source)
         values ('Ana', 'Bautista', '1992-02-02', '+639170000000', 'walk_in')
         returning id`,
      );
      const qId = patient.rows[0].id;

      const lease = await acquire("manual", false);
      const ops = JSON.stringify([
        {
          op: "fill",
          patient_id: qId,
          fields: {
            phone: "+639171111111",
            email: "q@example.com",
            referral_source: "online_facebook",
          },
        },
      ]);

      const r1 = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [lease.token, ops],
      );
      assert(
        r1.rows[0].j.counts.filled === 1,
        `fill #1: expected counts.filled=1, got ${JSON.stringify(r1.rows[0].j)}`,
      );

      const after1 = await q<{ phone: string; email: string; source: string; rv: string }>(
        `select phone, email, referral_source as source, row_version::text as rv
           from public.patients where id = $1`,
        [qId],
      );
      assert(
        after1.rows[0].phone === "+639170000000",
        `fill #1: phone should stay unchanged, got ${after1.rows[0].phone}`,
      );
      assert(
        after1.rows[0].email === "q@example.com",
        `fill #1: email (was null) should be filled, got ${after1.rows[0].email}`,
      );
      assert(
        after1.rows[0].source === "walk_in",
        `fill #1: referral_source is staff-owned and should stay unchanged, got ${after1.rows[0].source}`,
      );
      assert(
        after1.rows[0].rv === "1",
        `fill #1: expected row_version 1, got ${after1.rows[0].rv}`,
      );

      const changeCount = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_sync_changes
           where run_id = $1 and patient_id = $2`,
        [lease.runId, qId],
      );
      assert(
        changeCount.rows[0].n === "1",
        `fill #1: expected exactly 1 sheet_sync_changes row, got ${changeCount.rows[0].n}`,
      );
      const changeCol = await q<{ column_name: string }>(
        `select column_name from public.sheet_sync_changes where run_id = $1 and patient_id = $2`,
        [lease.runId, qId],
      );
      assert(
        changeCol.rows[0].column_name === "email",
        `fill #1: expected the recorded column to be 'email', got ${changeCol.rows[0].column_name}`,
      );

      // Second, identical op -> no-op update suppressed.
      const r2 = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [lease.token, ops],
      );
      assert(
        r2.rows[0].j.counts.skipped === 1,
        `fill #2 (identical): expected counts.skipped=1, got ${JSON.stringify(r2.rows[0].j)}`,
      );
      const after2 = await q<{ rv: string }>(
        `select row_version::text as rv from public.patients where id = $1`,
        [qId],
      );
      assert(
        after2.rows[0].rv === "1",
        `fill #2 (identical): row_version must stay 1 (no-op), got ${after2.rows[0].rv}`,
      );

      await finish(lease.token);
    });

    // 8. Sheet-owned channel follows the sheet -----------------------------
    await check("Sheet-owned channel follows the sheet", async () => {
      await setRole("service_role", null);

      const patient = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate, referral_source)
         values ('Carlos', 'Villanueva', '1988-08-08', 'other')
         returning id`,
      );
      const rId = patient.rows[0].id;

      const lease1 = await acquire("resort", false);
      const n = await q<{ sheet_resort_apply: number }>(
        `select public.sheet_resort_apply($1::uuid, $2::uuid[], 'other', 'online_google')`,
        [lease1.token, [rId]],
      );
      assert(
        n.rows[0].sheet_resort_apply === 1,
        `resort apply: expected 1 row updated, got ${n.rows[0].sheet_resort_apply}`,
      );
      const after1 = await q<{ source: string; origin: string }>(
        `select referral_source as source, referral_source_origin as origin from public.patients where id = $1`,
        [rId],
      );
      assert(
        after1.rows[0].source === "online_google",
        `resort apply: expected source online_google, got ${after1.rows[0].source}`,
      );
      assert(
        after1.rows[0].origin === "sheet",
        `resort apply: expected origin 'sheet', got ${after1.rows[0].origin}`,
      );
      await finish(lease1.token);

      const lease2 = await acquire("manual", false);
      const opsNull = JSON.stringify([
        { op: "fill", patient_id: rId, fields: { referral_source: null } },
      ]);
      await q(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb)`, [
        lease2.token,
        opsNull,
      ]);
      const after2 = await q<{ source: string | null; origin: string | null }>(
        `select referral_source as source, referral_source_origin as origin from public.patients where id = $1`,
        [rId],
      );
      assert(
        after2.rows[0].source === null,
        `fill with referral_source:null: expected source null, got ${after2.rows[0].source}`,
      );
      assert(
        after2.rows[0].origin === null,
        `fill with referral_source:null: expected origin null, got ${after2.rows[0].origin}`,
      );
      await finish(lease2.token);
    });

    // 9. Create -------------------------------------------------------------
    await check("Create", async () => {
      await setRole("service_role", null);
      const lease = await acquire("manual", false);

      const linkKeys = ["sheet:create-check:link-1", "sheet:create-check:link-2"];
      const op = {
        op: "create",
        create_key: "create-check-1",
        method: "auto_exact",
        fields: {
          first_name: "Rosa",
          last_name: "Fernandez",
          sex: "female",
          phone: "+639172223333",
          email: "rosa.fernandez@example.test",
          address: "Quezon City",
          referral_source: "walk_in",
        },
        link_keys: linkKeys,
        facts: { registered_on: "2026-09-01", new_repeat: "new", source_ref: "sheet-row-9001" },
      };
      const r = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [lease.token, JSON.stringify([op])],
      );
      assert(
        r.rows[0].j.counts.created === 1,
        `create: expected counts.created=1, got ${JSON.stringify(r.rows[0].j)}`,
      );
      const newId = r.rows[0].j.created["create-check-1"];
      assert(
        typeof newId === "string" && newId.length > 0,
        `create: expected a created patient id, got ${JSON.stringify(r.rows[0].j)}`,
      );

      const row = await q<{
        legacy_import_run_id: string | null;
        origin: string | null;
        birthdate: string | null;
      }>(
        `select legacy_import_run_id, referral_source_origin as origin, birthdate::text as birthdate
           from public.patients where id = $1`,
        [newId],
      );
      assert(
        row.rows[0].legacy_import_run_id !== null,
        `create: expected legacy_import_run_id to be set`,
      );
      assert(
        row.rows[0].origin === "sheet",
        `create: expected origin 'sheet', got ${row.rows[0].origin}`,
      );
      assert(
        row.rows[0].birthdate === null,
        `create: expected no birthdate (constraint satisfied via legacy_import_run_id), got ${row.rows[0].birthdate}`,
      );

      const changeRows = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_sync_changes
           where run_id = $1 and patient_id = $2 and change_kind = 'create'`,
        [lease.runId, newId],
      );
      assert(
        changeRows.rows[0].n === "1",
        `create: expected exactly 1 create change row, got ${changeRows.rows[0].n}`,
      );

      const linkRows = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_patient_links
           where link_key = any($1::text[]) and patient_id = $2`,
        [linkKeys, newId],
      );
      assert(
        linkRows.rows[0].n === String(linkKeys.length),
        `create: expected ${linkKeys.length} link rows, got ${linkRows.rows[0].n}`,
      );

      const factsRow = await q<{ n: string }>(
        `select count(*)::text as n from public.patient_acquisition_facts where patient_id = $1`,
        [newId],
      );
      assert(
        factsRow.rows[0].n === "1",
        `create: expected 1 facts row, got ${factsRow.rows[0].n}`,
      );

      const runRow = await q<{ legacy_import_run_id: string | null }>(
        `select legacy_import_run_id from public.sheet_sync_runs where id = $1`,
        [lease.runId],
      );
      assert(
        runRow.rows[0].legacy_import_run_id !== null,
        `create: expected the run to carry legacy_import_run_id`,
      );

      await finish(lease.token);
    });

    // 10. Revert --------------------------------------------------------
    await check("Revert", async () => {
      await setRole("service_role", null);

      // --- Run S: fill T's email; revert restores it. ---
      const t = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Teresa', 'Ocampo', '1995-03-03') returning id`,
      );
      const tId = t.rows[0].id;
      const leaseS = await acquire("manual", false);
      const opsS = JSON.stringify([
        { op: "fill", patient_id: tId, fields: { email: "teresa@example.test" } },
      ]);
      const rS = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [leaseS.token, opsS],
      );
      assert(
        rS.rows[0].j.counts.filled === 1,
        `revert setup (S): expected filled=1, got ${JSON.stringify(rS.rows[0].j)}`,
      );
      await finish(leaseS.token);

      const leaseRevS = await acquire("revert", false);
      const revS = await q<{ j: Json }>(
        `select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`,
        [leaseRevS.token, leaseS.runId],
      );
      assert(
        revS.rows[0].j.restored === 1,
        `revert S: expected restored=1, got ${JSON.stringify(revS.rows[0].j)}`,
      );
      const tAfter = await q<{ email: string | null }>(
        `select email from public.patients where id = $1`,
        [tId],
      );
      assert(
        tAfter.rows[0].email === null,
        `revert S: expected email restored to null, got ${tAfter.rows[0].email}`,
      );
      await finish(leaseRevS.token);

      // --- Run U: fill V's email; a later staff touch blocks the revert. ---
      const v = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Victor', 'Aquino', '1993-07-07') returning id`,
      );
      const vId = v.rows[0].id;
      const leaseU = await acquire("manual", false);
      const opsU = JSON.stringify([
        { op: "fill", patient_id: vId, fields: { email: "victor@example.test" } },
      ]);
      const rU = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [leaseU.token, opsU],
      );
      assert(
        rU.rows[0].j.counts.filled === 1,
        `revert setup (U): expected filled=1, got ${JSON.stringify(rU.rows[0].j)}`,
      );
      await finish(leaseU.token);

      await q(`update public.patients set address = 'Touched by reception' where id = $1`, [
        vId,
      ]);
      const vEmailBefore = (
        await q<{ email: string }>(`select email from public.patients where id = $1`, [vId])
      ).rows[0].email;

      const leaseRevU = await acquire("revert", false);
      const revU = await q<{ j: Json }>(
        `select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`,
        [leaseRevU.token, leaseU.runId],
      );
      assert(
        revU.rows[0].j.blocked === 1,
        `revert U: expected blocked=1, got ${JSON.stringify(revU.rows[0].j)}`,
      );
      const vAfter = await q<{ email: string }>(
        `select email from public.patients where id = $1`,
        [vId],
      );
      assert(
        vAfter.rows[0].email === vEmailBefore,
        `revert U: V's email should be unchanged (${vEmailBefore}), got ${vAfter.rows[0].email}`,
      );
      await finish(leaseRevU.token);

      // --- Run W: create a patient; revert deletes it; second revert -> 22023. ---
      const leaseW = await acquire("manual", false);
      const opW = {
        op: "create",
        create_key: "revert-w-1",
        method: "auto_exact",
        fields: { first_name: "Wilma", last_name: "Domingo", referral_source: "walk_in" },
        link_keys: ["sheet:revert-w:link-1"],
        facts: { registered_on: "2026-09-02", new_repeat: "new", source_ref: "sheet-row-9002" },
      };
      const rW = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [leaseW.token, JSON.stringify([opW])],
      );
      const wId = rW.rows[0].j.created["revert-w-1"];
      assert(
        typeof wId === "string",
        `revert W setup: expected a created patient id, got ${JSON.stringify(rW.rows[0].j)}`,
      );
      await finish(leaseW.token);

      const leaseRevW = await acquire("revert", false);
      const revW = await q<{ j: Json }>(
        `select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`,
        [leaseRevW.token, leaseW.runId],
      );
      assert(
        revW.rows[0].j.deleted === 1,
        `revert W: expected deleted=1, got ${JSON.stringify(revW.rows[0].j)}`,
      );
      const wGone = await q<{ n: string }>(
        `select count(*)::text as n from public.patients where id = $1`,
        [wId],
      );
      assert(wGone.rows[0].n === "0", `revert W: expected patient W gone, found ${wGone.rows[0].n}`);
      await finish(leaseRevW.token);

      const leaseRevW2 = await acquire("revert", false);
      await expectPgError("second revert of the same run", "22023", () =>
        q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid)`, [
          leaseRevW2.token,
          leaseW.runId,
        ]),
      );
      await finish(leaseRevW2.token);
    });

    // 11. Review upsert -----------------------------------------------------
    await check("Review upsert", async () => {
      await setRole("service_role", null);

      const itemKey = "probe-review-upsert-1";
      const lease1 = await acquire("manual", false);
      const items1 = JSON.stringify([
        { kind: "unmapped_source", item_key: itemKey, payload: { raw: "first" } },
      ]);
      const r1 = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`,
        [lease1.token, items1],
      );
      assert(
        r1.rows[0].j.opened === 1,
        `upsert #1: expected opened=1, got ${JSON.stringify(r1.rows[0].j)}`,
      );
      await finish(lease1.token);

      const row1 = await q<{ n: string; run_id: string }>(
        `select count(*)::text as n, max(run_id::text) as run_id from public.sheet_sync_review_items
           where kind = 'unmapped_source' and item_key = $1`,
        [itemKey],
      );
      assert(row1.rows[0].n === "1", `after upsert #1: expected 1 row, got ${row1.rows[0].n}`);
      assert(
        row1.rows[0].run_id === lease1.runId,
        `after upsert #1: expected run_id ${lease1.runId}, got ${row1.rows[0].run_id}`,
      );

      // Two upserts of the same (kind, item_key) -> still one open row. `now()`
      // is frozen for this whole script (see header comment), so the proof
      // that the second upsert actually touched the row is that its run_id
      // moved to the SECOND run, not that a timestamp advanced.
      const lease2 = await acquire("manual", false);
      const items2 = JSON.stringify([
        { kind: "unmapped_source", item_key: itemKey, payload: { raw: "second" } },
      ]);
      const r2 = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`,
        [lease2.token, items2],
      );
      assert(
        r2.rows[0].j.updated === 1,
        `upsert #2: expected updated=1, got ${JSON.stringify(r2.rows[0].j)}`,
      );
      const row2 = await q<{ n: string; run_id: string }>(
        `select count(*)::text as n, max(run_id::text) as run_id from public.sheet_sync_review_items
           where kind = 'unmapped_source' and item_key = $1`,
        [itemKey],
      );
      assert(
        row2.rows[0].n === "1",
        `after upsert #2: expected dedupe to keep exactly 1 row, got ${row2.rows[0].n}`,
      );
      assert(
        row2.rows[0].run_id === lease2.runId,
        `after upsert #2: expected run_id to move to ${lease2.runId}, got ${row2.rows[0].run_id}`,
      );

      // Dismiss it -> the next upsert must not reopen it.
      const itemId = (
        await q<{ id: string }>(
          `select id from public.sheet_sync_review_items where kind = 'unmapped_source' and item_key = $1`,
          [itemKey],
        )
      ).rows[0].id;
      await q(`select public.sheet_review_resolve($1::uuid, null, 'dismiss', null)`, [itemId]);

      const r3 = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`,
        [lease2.token, items2],
      );
      assert(
        r3.rows[0].j.opened === 0 && r3.rows[0].j.updated === 0,
        `upsert after dismiss: expected no reopen, got ${JSON.stringify(r3.rows[0].j)}`,
      );
      const stillDismissed = await q<{ status: string }>(
        `select status from public.sheet_sync_review_items where id = $1`,
        [itemId],
      );
      assert(
        stillDismissed.rows[0].status === "dismissed",
        `upsert after dismiss: expected status to stay dismissed, got ${stillDismissed.rows[0].status}`,
      );

      // p_clear_absent=true with an empty list resolves the OTHER open items of that tab.
      const otherKey = "probe-review-clear-absent-1";
      await q(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false)`,
        [
          lease2.token,
          JSON.stringify([{ kind: "invalid_row", item_key: otherKey, payload: {} }]),
        ],
      );
      const clear = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', '[]'::jsonb, true) as j`,
        [lease2.token],
      );
      assert(
        clear.rows[0].j.cleared >= 1,
        `clear_absent: expected at least 1 row cleared, got ${JSON.stringify(clear.rows[0].j)}`,
      );
      const otherRow = await q<{ status: string }>(
        `select status from public.sheet_sync_review_items where kind = 'invalid_row' and item_key = $1`,
        [otherKey],
      );
      assert(
        otherRow.rows[0].status === "resolved",
        `clear_absent: expected the other open item resolved, got ${otherRow.rows[0].status}`,
      );

      // sheet_review_resolve on an already-resolved item -> P0064.
      const otherId = (
        await q<{ id: string }>(
          `select id from public.sheet_sync_review_items where kind = 'invalid_row' and item_key = $1`,
          [otherKey],
        )
      ).rows[0].id;
      await expectPgError("resolve an already-handled review item", "P0064", () =>
        q(`select public.sheet_review_resolve($1::uuid, null, 'dismiss', null)`, [otherId]),
      );

      await finish(lease2.token);
    });
  } finally {
    // Never persisted. This proof never writes anything real.
    await db.query("rollback");
    await db.end();
  }
}

main()
  .then(() => {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed.`);
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
  })
  .catch((err) => {
    console.error("\nsheet-sync:db-proof crashed before finishing:");
    console.error(err);
    process.exit(1);
  });
