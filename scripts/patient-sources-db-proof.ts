// Hand-run local database proof for Patient Sources (Sheet Sync PR 2,
// supabase/migrations/0189_patient_sources.sql).
//
// Modeled on scripts/sheet-sync-db-proof.ts: everything happens inside ONE
// transaction that is unconditionally rolled back at the end, so this script
// never leaves anything behind in the shared local stack and can be re-run
// without a db:reset.
//
// ISOLATION (Codex plan review #5): every check body runs inside scoped(),
// which ALWAYS rolls back its savepoint — unlike sheet-sync's check(), which
// releases (persists) on success. Each check therefore starts from exactly
// the fixtures built once in setupFixtures() (three staff, a proof service, a
// throwaway sheet_sync_runs row, converted_at = null) and nothing any other
// check inserted. Checks never rely on another check's rows.
//
// The View-as probe inside check 1 flips fx.adminId's view_as_role and
// restores it in a `finally` before the next function's probe, so it can
// never leak into a later probe even if an assertion throws mid-loop.
//
// Dates: node-pg returns `date` columns as JS Date objects unless the column
// is cast — every date read in this script is cast `::text` in SQL so
// comparisons are plain 'YYYY-MM-DD' strings, never a Date/timezone trap.
//
// CONTROL ROUNDS (prove the proof can fail) — apply ONE at a time to the
// LOCAL migration file only, `psql -f` it, re-run this script, confirm the
// named FAIL, then revert and re-apply before moving to the next letter (they
// touch different functions/lines so do not need separate rounds):
//
//   PSQL=/opt/homebrew/opt/libpq/bin/psql
//   DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   MIG=supabase/migrations/0189_patient_sources.sql
//
//   A. _patient_sources_encounters, sheet branch: the ELSE clause of the
//      `case when l.patient_id is null then 'name:' || l.loose_key` emits the
//      RAW patient_id instead of the resolved survivor. Expect: FAIL Merged A
//      -> B, same day (served_confirmed delta becomes 2, not 1 — the sheet
//      line's identity no longer matches the app visit's).
//        else 'patient:' || s.survivor_id::text end,
//        -> else 'patient:' || l.patient_id::text end,
//   B. _patient_sources_identities, the `surv` CTE: drop the deleted-survivor
//      filter. Expect: FAIL Deleted survivor drops out (via C2, the
//      registration-only deleted patient, which the encounters-level filter
//      alone cannot catch since it never had an encounter).
//        join public.patients sp on sp.id = s.survivor_id
//        where sp.deleted_at is null
//        -> join public.patients sp on sp.id = s.survivor_id
//   G. confirmed_reg: least() instead of coalesce() for the group reg date.
//      Expect: FAIL Group registration date (P18) — (i) picks the earlier
//      app-native date instead of letting the sheet date win.
//        coalesce(min(m.fact_on), min(m.app_on)) as reg_on,
//        -> least(min(m.fact_on), min(m.app_on)) as reg_on,
//   C. confirmed_reg: bool_and() instead of bool_or() for the tie rule.
//      Expect: FAIL Merged-group facts rule (the tie sub-step: an undated
//      member no longer wins Returning).
//        then coalesce(bool_or(m.sheet_new_repeat = 'repeat') filter (where m.fact_on = m.min_fact_on), false)
//        -> then coalesce(bool_and(m.sheet_new_repeat = 'repeat') filter (where m.fact_on = m.min_fact_on), false)
//   D. patient_sources_summary: drop the has_role gate. Expect: FAIL ACL
//      matrix - functions (reception/inactive-admin/anon calls that used to
//      be refused now succeed or fail with the wrong code).
//        if not public.has_role(array['admin']) then
//        raise exception 'Patient Sources is for admins only' using errcode = '42501';
//        end if;
//        perform public._ps_assert_mirror_mode();
//        (delete those three lines from patient_sources_summary only)
//   E. _patient_sources_encounters + _ps_revenue_lines: the mirror-window
//      predicate becomes unconditional true. Expect: FAIL Stream (a) filters
//      (the imported visit dated inside the mirror window is now served).
//        and (v.visit_date < v_window or v.legacy_import_run_id is null)
//        -> and true
//      (two occurrences — one in each function; mutate both, or the encounters
//      one alone is enough to fail check 14's assertions)
//   F. _patient_sources_identities, `member`: drop the Manila cast.
//      Expect: FAIL App-native registration, Manila date (created_at read as
//      the UTC day instead of the Manila day).
//        then (p.created_at at time zone 'Asia/Manila')::date end as app_on
//        -> then p.created_at::date end as app_on
//
//   for each letter: edit $MIG, then
//     $PSQL $DB -v ON_ERROR_STOP=1 -f $MIG
//     npm run patient-sources:db-proof
//   then revert the edit and re-apply before the next letter, and once more
//   at the end to confirm all-PASS.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import { looseKeyOf } from "../src/lib/sheet-sync/names";

requireLocalOrExplicitProd("patient-sources:db-proof", {
  writes: "nothing — every check runs in one transaction that is rolled back",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Belt-and-suspenders on top of the guard above: this script must NEVER run
// against a non-local host.
if (!/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error(
    `[patient-sources:db-proof] refusing to run against a non-local DB_URL (${DB_URL}). ` +
      "This script only ever runs against the local Supabase stack.",
  );
  process.exit(2);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

type DbRole = "postgres" | "anon" | "authenticated";
type Claims = Record<string, unknown> | null;

interface Fixtures {
  adminId: string;
  receptionId: string;
  inactiveAdminId: string;
  patientPId: string;
  serviceId: string;
  runId: string;
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

  /** Always undoes fn()'s mutations, success or failure. */
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

  async function setupFixtures(): Promise<Fixtures> {
    const ids = await q<{ id: string }>(`
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, '', now(), now(), now()
      from unnest(array[
        'patient-sources-proof-admin@example.test',
        'patient-sources-proof-reception@example.test',
        'patient-sources-proof-inactive-admin@example.test'
      ]) as email
      returning id
    `);
    const [adminId, receptionId, inactiveAdminId] = ids.rows.map((r) => r.id);

    await q(
      `insert into public.staff_profiles (id, full_name, role, is_active) values
         ($1, 'PS Proof Admin', 'admin', true),
         ($2, 'PS Proof Reception', 'reception', true),
         ($3, 'PS Proof Inactive Admin', 'admin', false)`,
      [adminId, receptionId, inactiveAdminId],
    );

    const p = await q<{ id: string }>(`
      insert into public.patients (first_name, last_name, birthdate)
      values ('Probe', 'PatientSourcesPortal', '1990-01-01')
      returning id
    `);

    const svc = await q<{ id: string }>(
      `insert into public.services (code, name, price_php) values ('PS-PROOF', 'Proof test', 500) returning id`,
    );

    const run = await q<{ id: string }>(
      `insert into public.sheet_sync_runs (trigger, status, ended_at) values ('manual','succeeded', now()) returning id`,
    );

    await q(`update public.sheet_sync_settings set converted_at = null where id`);

    return {
      adminId,
      receptionId,
      inactiveAdminId,
      patientPId: p.rows[0].id,
      serviceId: svc.rows[0].id,
      runId: run.rows[0].id,
    };
  }

  let fx: Fixtures;

  const JUNE = { from: "2026-06-01", to: "2026-06-30" };
  const asAdmin = () => setRole("authenticated", { sub: fx.adminId, role: "authenticated" });

  const COUNT_FIELDS = [
    "new_confirmed", "new_unconfirmed", "returning_first_recorded", "served_confirmed",
    "served_unconfirmed", "undated_registrations", "source_recorded", "source_total",
  ] as const;
  type Summary = Record<(typeof COUNT_FIELDS)[number], number>;
  async function summary(from = JUNE.from, to = JUNE.to): Promise<Summary> {
    await asAdmin();
    const r = await q<Record<string, string>>(
      `select ${COUNT_FIELDS.join(", ")} from public.patient_sources_summary($1, $2)`, [from, to]);
    await setRole("postgres", null);
    return Object.fromEntries(COUNT_FIELDS.map((k) => [k, Number(r.rows[0][k])])) as Summary;
  }
  function delta(before: Summary, after: Summary): Summary {
    return Object.fromEntries(COUNT_FIELDS.map((k) => [k, after[k] - before[k]])) as Summary;
  }
  const allZero = (d: Summary) => COUNT_FIELDS.every((k) => d[k] === 0);

  async function patient(
    last: string,
    first: string,
    opts: { source?: string; createdAt?: string; imported?: boolean } = {},
  ): Promise<string> {
    const runId = opts.imported
      ? (await q<{ id: string }>(`insert into public.legacy_import_runs (source, dry_run) values ('patient-sources-proof', false) returning id`)).rows[0].id
      : null;
    const r = await q<{ id: string }>(
      `insert into public.patients (first_name, last_name, birthdate, referral_source, created_at, legacy_import_run_id)
       values ($1, $2, '1990-01-01', $3, coalesce($4::timestamptz, now()), $5) returning id`,
      [first, last, opts.source ?? null, opts.createdAt ?? null, runId],
    );
    return r.rows[0].id;
  }
  async function visit(patientId: string, date: string, pricePhp = 0, opts: { imported?: boolean } = {}): Promise<string> {
    const runId = opts.imported
      ? (await q<{ id: string }>(`insert into public.legacy_import_runs (source, dry_run) values ('patient-sources-proof', false) returning id`)).rows[0].id
      : null;
    const v = await q<{ id: string }>(
      `insert into public.visits (patient_id, visit_date, legacy_import_run_id) values ($1, $2, $3) returning id`,
      [patientId, date, runId],
    );
    if (pricePhp > 0) {
      await q(
        `insert into public.test_requests (visit_id, service_id, requested_by, final_price_php) values ($1, $2, $3, $4)`,
        [v.rows[0].id, fx.serviceId, fx.adminId, pricePhp],
      );
    }
    return v.rows[0].id;
  }
  async function sheetLine(date: string, looseKey: string, patientId: string | null, revenuePhp = 0): Promise<void> {
    await q(
      `insert into public.sheet_encounter_lines
         (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id, identity_key, revenue_php, raw, row_hash, run_id)
       values ('lab', 1, $1, $2, $2, $2, $3, $4, $5, '{}'::jsonb, md5(random()::text), $6)`,
      [date, looseKey, patientId, patientId ? `patient:${patientId}` : `name:${looseKey}`, revenuePhp, fx.runId],
    );
  }
  async function customerRow(
    looseKey: string,
    opts: { patientId?: string | null; source?: string | null; registeredOn?: string | null; referredBy?: string | null } = {},
  ): Promise<void> {
    await q(
      `insert into public.sheet_customer_rows
         (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, registered_on, referral_source_id,
          referred_by_raw, patient_id, link_state, row_hash, run_id)
       values (1, md5(random()::text), $1, $1, $1, md5(random()::text), $2, $3, $4, $5, $6, md5(random()::text), $7)`,
      [looseKey, opts.registeredOn ?? null, opts.source ?? null, opts.referredBy ?? null, opts.patientId ?? null,
       opts.patientId ? "linked" : "unlinked", fx.runId],
    );
  }
  async function facts(patientId: string, registeredOn: string | null, newRepeat: "new" | "repeat" | null): Promise<void> {
    await q(
      `insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat) values ($1, $2, $3)`,
      [patientId, registeredOn, newRepeat],
    );
  }
  async function softDelete(patientId: string): Promise<void> {
    // 0167's lifecycle guard (enforce_patient_lifecycle) only lets a session
    // whose current_user is literally 'patient_lifecycle_writer' touch these
    // columns (delete_patient()/restore_patient() are SECURITY DEFINER, owned
    // by that role). The local Supabase `postgres` role is not a real
    // superuser (rolsuper = false), so session_replication_role='replica' is
    // refused (42501) — SET ROLE to the writer role instead, which `postgres`
    // is a member of.
    await q(`set local role patient_lifecycle_writer`);
    await q(
      `update public.patients set deleted_at = now(), deleted_by = $2, delete_reason = 'duplicate', delete_note = 'proof' where id = $1`,
      [patientId, fx.adminId],
    );
    await q(`reset role`);
  }

  // -- Report-surface readers (always via admin, always restore to postgres) --
  async function identityRow(identity: string): Promise<
    { first_date: string | null; basis: string; is_returning: boolean; confirmed: boolean; channel: string } | undefined
  > {
    const r = await q<{ first_date: string | null; basis: string; is_returning: boolean; confirmed: boolean; channel: string }>(
      `select first_date::text as first_date, basis, is_returning, confirmed, channel
         from public._patient_sources_identities() where identity = $1`,
      [identity],
    );
    return r.rows[0];
  }
  async function seriesRows(from: string, to: string, grain: string, mode: string) {
    await asAdmin();
    const r = await q<{ bucket_start: string; channel: string; confirmed: number; unconfirmed: number }>(
      `select bucket_start::text as bucket_start, channel, confirmed, unconfirmed
         from public.patient_sources_series($1, $2, $3, $4)`,
      [from, to, grain, mode],
    );
    await setRole("postgres", null);
    return r.rows;
  }
  function bucketTotal(rows: { bucket_start: string; confirmed: number; unconfirmed: number }[], bucket: string): number {
    return rows.filter((r) => r.bucket_start === bucket).reduce((s, r) => s + r.confirmed + r.unconfirmed, 0);
  }
  async function revenueRows(from = JUNE.from, to = JUNE.to) {
    await asAdmin();
    const r = await q<{ channel: string; confirmed_php: string; unconfirmed_php: string }>(
      `select channel, confirmed_php, unconfirmed_php from public.patient_sources_revenue($1, $2)`,
      [from, to],
    );
    await setRole("postgres", null);
    return r.rows.map((x) => ({ channel: x.channel, confirmed: Number(x.confirmed_php), unconfirmed: Number(x.unconfirmed_php) }));
  }
  async function revenueTotal(from = JUNE.from, to = JUNE.to): Promise<number> {
    const rows = await revenueRows(from, to);
    return rows.reduce((s, r) => s + r.confirmed + r.unconfirmed, 0);
  }
  async function overlapsRows(from = JUNE.from, to = JUNE.to) {
    await asAdmin();
    const r = await q<{ patient_id: string; drm_id: string; service_date: string; app_php: string; sheet_php: string }>(
      `select patient_id, drm_id, service_date::text as service_date, app_php, sheet_php
         from public.patient_sources_overlaps($1, $2)`,
      [from, to],
    );
    await setRole("postgres", null);
    return r.rows;
  }
  async function peopleRows(from: string, to: string, mode: string, channel: string | null, limit: number, offset: number) {
    await asAdmin();
    const r = await q<{
      identity_kind: string; identity: string; patient_id: string | null; drm_id: string | null;
      display_name: string | null; first_date: string; total_count: string;
    }>(
      `select identity_kind, identity, patient_id, drm_id, display_name, first_date::text as first_date, total_count::text as total_count
         from public.patient_sources_people($1, $2, $3, $4, $5, $6)`,
      [from, to, mode, channel, limit, offset],
    );
    await setRole("postgres", null);
    return r.rows;
  }
  async function referrersRows(from = JUNE.from, to = JUNE.to, limit = 20) {
    await asAdmin();
    const r = await q<{ doctor_label: string; new_confirmed: number; new_unconfirmed: number }>(
      `select doctor_label, new_confirmed, new_unconfirmed from public.patient_sources_referrers($1, $2, $3)`,
      [from, to, limit],
    );
    await setRole("postgres", null);
    return r.rows;
  }

  // ---------------------------------------------------------------------
  await q("begin");
  try {
    fx = await setupFixtures();

    // 1. ACL matrix — functions -------------------------------------------
    await check("ACL matrix - functions", () => scoped(async () => {
      const FUNCS: { name: string; sql: string }[] = [
        { name: "patient_sources_summary", sql: `select public.patient_sources_summary('2026-06-01'::date,'2026-06-30'::date)` },
        { name: "patient_sources_series", sql: `select public.patient_sources_series('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text)` },
        { name: "patient_sources_revenue", sql: `select public.patient_sources_revenue('2026-06-01'::date,'2026-06-30'::date)` },
        { name: "patient_sources_overlaps", sql: `select public.patient_sources_overlaps('2026-06-01'::date,'2026-06-30'::date)` },
        { name: "patient_sources_referrers", sql: `select public.patient_sources_referrers('2026-06-01'::date,'2026-06-30'::date,20::int)` },
        { name: "patient_sources_people", sql: `select public.patient_sources_people('2026-06-01'::date,'2026-06-30'::date,'new'::text,null::text,50::int,0::int)` },
        { name: "ad_spend_import", sql: `select public.ad_spend_import(gen_random_uuid(), '[{"spend_date":"2026-06-01","platform":"meta","campaign_key":"c","ad_key":"a","campaign_label":"C","spend_php":1}]'::jsonb)` },
        { name: "ad_spend_delete", sql: `select public.ad_spend_delete('meta'::text,'2026-06-01'::date,'2026-06-01'::date)` },
        { name: "ad_spend_daily_totals", sql: `select public.ad_spend_daily_totals('2026-06-01'::date,'2026-06-30'::date)` },
        { name: "ad_spend_coverage", sql: `select public.ad_spend_coverage()` },
      ];
      const principals: { label: string; role: DbRole; claims: Claims; expect: "denied" | "ok" }[] = [
        { label: "anon", role: "anon", claims: null, expect: "denied" },
        { label: "portal patient", role: "anon", claims: { role: "anon", patient_id: fx.patientPId }, expect: "denied" },
        { label: "reception", role: "authenticated", claims: { sub: fx.receptionId, role: "authenticated" }, expect: "denied" },
        { label: "inactive admin", role: "authenticated", claims: { sub: fx.inactiveAdminId, role: "authenticated" }, expect: "denied" },
        { label: "admin", role: "authenticated", claims: { sub: fx.adminId, role: "authenticated" }, expect: "ok" },
      ];

      for (const p of principals) {
        for (const fn of FUNCS) {
          await setRole(p.role, p.claims);
          const label = `ACL ${p.label}/${fn.name}`;
          if (p.expect === "denied") {
            await expectPgError(label, "42501", () => q(fn.sql));
          } else {
            await expectOk(label, () => q(fn.sql));
          }
        }
      }

      // Admin viewing as reception, run LAST per function, restored at once.
      for (const fn of FUNCS) {
        await setRole("postgres", null);
        await q(
          `update public.staff_profiles set view_as_role = 'reception', view_as_until = now() + interval '1 hour' where id = $1`,
          [fx.adminId],
        );
        try {
          await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
          await expectPgError(`ACL admin-viewing-as-reception/${fn.name}`, "42501", () => q(fn.sql));
        } finally {
          await setRole("postgres", null);
          await q(`update public.staff_profiles set view_as_role = null, view_as_until = null where id = $1`, [fx.adminId]);
        }
      }

      // Helper functions: no EXECUTE for anyone with a JWT role.
      const HELPERS: { name: string; sql: string }[] = [
        { name: "_ps_name_norm", sql: `select public._ps_name_norm('x')` },
        { name: "_ps_loose_key", sql: `select public._ps_loose_key('x','y')` },
        { name: "_ps_doctor_norm", sql: `select public._ps_doctor_norm('x')` },
        { name: "_ps_survivors", sql: `select * from public._ps_survivors()` },
        { name: "_ps_assert_mirror_mode", sql: `select public._ps_assert_mirror_mode()` },
        { name: "_ps_check_period", sql: `select public._ps_check_period('2026-06-01'::date,'2026-06-30'::date)` },
        { name: "_ps_bucket", sql: `select public._ps_bucket('2026-06-01'::date,'day'::text,'2026-06-01'::date)` },
        { name: "_patient_sources_encounters", sql: `select * from public._patient_sources_encounters()` },
        { name: "_patient_sources_identities", sql: `select * from public._patient_sources_identities()` },
        { name: "_ps_revenue_lines", sql: `select * from public._ps_revenue_lines('2026-06-01'::date,'2026-06-30'::date)` },
      ];
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      for (const h of HELPERS) {
        await expectPgError(`RPC ${h.name} as authenticated admin`, "42501", () => q(h.sql));
      }
    }));

    // 2. ACL matrix — table -------------------------------------------------
    await check("ACL matrix - table", () => scoped(async () => {
      await setRole("postgres", null);
      await q(
        `insert into public.ad_spend_daily (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php, upload_id)
         values ('2026-06-01','meta','c','a','C',1,gen_random_uuid())`,
      );

      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const n = await expectOk("admin select ad_spend_daily", () =>
        q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily`));
      assert(Number(n.rows[0].n) > 0, `admin: expected >0 rows, got ${n.rows[0].n}`);
      await expectPgError("admin insert ad_spend_daily", "42501", () =>
        q(`insert into public.ad_spend_daily (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php, upload_id)
           values ('2026-06-02','meta','c2','a2','C2',1,gen_random_uuid())`));

      await setRole("authenticated", { sub: fx.receptionId, role: "authenticated" });
      const n2 = await expectOk("reception select ad_spend_daily", () =>
        q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily`));
      assert(Number(n2.rows[0].n) === 0, `reception: expected 0 rows (RLS-hidden), got ${n2.rows[0].n}`);

      await setRole("anon", null);
      await expectPgError("anon select ad_spend_daily", "42501", () => q(`select count(*) from public.ad_spend_daily`));
    }));

    // 3. Name-key parity ------------------------------------------------------
    await check("Name-key parity", () => scoped(async () => {
      await setRole("postgres", null);
      const cases: [string, string][] = [
        ["Dela Cruz", "Juan Santos"],
        ["O'Brian", "Ma. Luisa"],
        ["Peñafrancia", "José Mari"],
        ["  de  la  PAZ ", "ana-marie"],
        ["Nuñez", "Ñiño"],
        ["", ""],
      ];
      for (const [last, first] of cases) {
        const r = await q<{ k: string }>(`select public._ps_loose_key($1,$2) as k`, [last, first]);
        const expected = looseKeyOf({ last, first, middle: null });
        assert(r.rows[0].k === expected, `loose key for (${last}, ${first}): expected "${expected}", got "${r.rows[0].k}"`);
      }
    }));

    // 4. Doctor normaliser ------------------------------------------------
    await check("Doctor normaliser", () => scoped(async () => {
      await setRole("postgres", null);
      for (const raw of ["Dr. Juan Santos", "dra juan santos", "DOC Juan  Santos", "Doctor Juan Santos."]) {
        const r = await q<{ k: string | null }>(`select public._ps_doctor_norm($1) as k`, [raw]);
        assert(r.rows[0].k === "juan santos", `doctor norm of "${raw}": expected 'juan santos', got ${r.rows[0].k}`);
      }
      for (const raw of ["N/A", "none", " ", "Dr."]) {
        const r = await q<{ k: string | null }>(`select public._ps_doctor_norm($1) as k`, [raw]);
        assert(r.rows[0].k === null, `doctor norm of "${raw}": expected null, got ${r.rows[0].k}`);
      }
    }));

    // 5. Merged A -> B, same day -------------------------------------------
    await check("Merged A -> B, same day", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      const revBefore = await revenueTotal();

      const aId = await patient("Zzproofa", "Alpha");
      const bId = await patient("Zzproofb", "Beta");
      await q(`update public.patients set merged_into_id = $1 where id = $2`, [bId, aId]);
      await visit(bId, "2026-06-10", 300);
      await sheetLine("2026-06-10", "zzproofb|beta", aId, 250);

      const after = await summary();
      const d = delta(before, after);
      assert(d.served_confirmed === 1, `served_confirmed delta: expected 1, got ${d.served_confirmed}`);
      assert(d.new_confirmed === 1, `new_confirmed delta: expected 1, got ${d.new_confirmed}`);

      const ov = await overlapsRows();
      const row = ov.find((r) => r.patient_id === bId);
      assert(!!row, `overlaps: expected a row for B's survivor id, got ${JSON.stringify(ov)}`);
      assert(row!.service_date === "2026-06-10", `overlaps: expected date 2026-06-10, got ${row!.service_date}`);
      assert(Number(row!.app_php) === 300, `overlaps app_php: expected 300, got ${row!.app_php}`);
      assert(Number(row!.sheet_php) === 250, `overlaps sheet_php: expected 250, got ${row!.sheet_php}`);

      const revAfter = await revenueTotal();
      assert(revAfter - revBefore === 300, `revenue total delta: expected +300 (sheet overlap excluded), got ${revAfter - revBefore}`);
    }));

    // 6. Deleted survivor drops out ----------------------------------------
    await check("Deleted survivor drops out", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      const revBefore = await revenueTotal();

      const cId = await patient("Zzproofc", "Charlie");
      await visit(cId, "2026-06-11", 100);
      await sheetLine("2026-06-12", "zzproofc|charlie", cId, 60);
      const c2Id = await patient("Zzproofc2", "Charlie2", { createdAt: "2026-06-15T02:00:00Z" });

      await softDelete(cId);
      await softDelete(c2Id);

      const after = await summary();
      const d = delta(before, after);
      assert(allZero(d), `expected an all-zero delta after deleting C and C2, got ${JSON.stringify(d)}`);
      const revAfter = await revenueTotal();
      assert(revAfter === revBefore, `revenue should be unchanged, before=${revBefore} after=${revAfter}`);

      const served = await peopleRows(JUNE.from, JUNE.to, "served", null, 1000, 0);
      assert(!served.some((r) => r.patient_id === cId || r.patient_id === c2Id), "served list must not include deleted C/C2");
      assert(!served.some((r) => r.identity === "name:zzproofc|charlie"), "served list must not fall back to a name: row for C's loose key");
      const news = await peopleRows(JUNE.from, JUNE.to, "new", null, 1000, 0);
      assert(!news.some((r) => r.patient_id === cId || r.patient_id === c2Id), "new list must not include deleted C/C2");
    }));

    // 7. Repeat -> Returning ------------------------------------------------
    await check("Repeat -> Returning", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      const rId = await patient("Zzproofr", "Romeo");
      await facts(rId, "2026-06-05", "repeat");
      await visit(rId, "2026-06-13");
      const after = await summary();
      const d = delta(before, after);
      assert(d.returning_first_recorded === 1, `expected returning_first_recorded delta 1, got ${d.returning_first_recorded}`);
      assert(d.new_confirmed === 0, `expected new_confirmed delta 0, got ${d.new_confirmed}`);
    }));

    // 8. Merged-group facts rule --------------------------------------------
    await check("Merged-group facts rule", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();

      const sId = await patient("Zzproofs", "Sierra");
      const mId = await patient("Zzproofm", "Mike");
      await facts(sId, "2026-06-10", "new");
      await facts(mId, "2026-06-05", "repeat");
      await q(`update public.patients set merged_into_id = $1 where id = $2`, [sId, mId]);

      let after = await summary();
      let d = delta(before, after);
      assert(d.returning_first_recorded === 1, `M earlier + repeat: expected returning_first_recorded delta 1, got ${d.returning_first_recorded}`);

      await q(`update public.patient_acquisition_facts set registered_on = '2026-06-10' where patient_id = $1`, [mId]);
      after = await summary();
      d = delta(before, after);
      assert(d.returning_first_recorded === 1, `tie (both 06-10): still expected returning_first_recorded delta 1, got ${d.returning_first_recorded}`);

      await q(`update public.patient_acquisition_facts set registered_on = '2026-06-20' where patient_id = $1`, [mId]);
      after = await summary();
      d = delta(before, after);
      assert(d.new_confirmed === 1, `M later (06-20): expected new_confirmed delta 1, got ${d.new_confirmed}`);
      assert(d.returning_first_recorded === 0, `M later (06-20): expected returning_first_recorded delta back to 0, got ${d.returning_first_recorded}`);

      const rows = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      assert(bucketTotal(rows, "2026-06-10") >= 1, `expected the day series to show +1 on 2026-06-10, got ${bucketTotal(rows, "2026-06-10")}`);
    }));

    // 8b. Group registration date (P18) --------------------------------------
    await check("Group registration date (P18)", () => scoped(async () => {
      await setRole("postgres", null);

      // (i) a sheet date wins over an earlier app sign-up
      const before1 = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      const b0601 = bucketTotal(before1, "2026-06-01");
      const b0610 = bucketTotal(before1, "2026-06-10");
      const a1Id = await patient("Zzproofa1", "AppNative1", { createdAt: "2026-06-01T02:00:00Z" });
      const i1Id = await patient("Zzproofi1", "Imported1", { imported: true });
      await facts(i1Id, "2026-06-10", "new");
      await q(`update public.patients set merged_into_id = $1 where id = $2`, [i1Id, a1Id]);
      const after1 = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      assert(bucketTotal(after1, "2026-06-01") === b0601, `(i) expected no change on 2026-06-01, got ${bucketTotal(after1, "2026-06-01")} vs baseline ${b0601}`);
      assert(bucketTotal(after1, "2026-06-10") === b0610 + 1, `(i) expected +1 on 2026-06-10, got ${bucketTotal(after1, "2026-06-10")} vs baseline ${b0610}`);
      const idI1 = await identityRow(`patient:${i1Id}`);
      assert(idI1?.first_date === "2026-06-10", `(i) expected first_date 2026-06-10 (sheet date wins), got ${idI1?.first_date}`);

      // (ii) app sign-up kept when the group's only facts row has no date
      const a2Id = await patient("Zzproofa2", "AppNative2", { createdAt: "2026-06-04T02:00:00Z" });
      await facts(a2Id, null, null);
      const idA2 = await identityRow(`patient:${a2Id}`);
      assert(idA2?.basis === "registration", `(ii) expected basis registration, got ${JSON.stringify(idA2)}`);
      assert(idA2?.first_date === "2026-06-04", `(ii) expected first_date 2026-06-04 (app sign-up kept), got ${idA2?.first_date}`);

      // (iii) an imported-only merged group with no sheet date anywhere stays undated
      const beforeIII = await summary();
      const i2Id = await patient("Zzproofi2", "Imported2", { imported: true });
      const i3Id = await patient("Zzproofi3", "Imported3", { imported: true });
      await facts(i2Id, null, null);
      await q(`update public.patients set merged_into_id = $1 where id = $2`, [i3Id, i2Id]);
      const afterIII = await summary();
      const dIII = delta(beforeIII, afterIII);
      assert(dIII.undated_registrations === 1, `(iii) expected undated_registrations delta 1, got ${dIII.undated_registrations}`);
      const otherFields = COUNT_FIELDS.filter((k) => k !== "undated_registrations");
      assert(otherFields.every((k) => dIII[k] === 0), `(iii) expected no June day changes, got ${JSON.stringify(dIII)}`);
    }));

    // 9. Undated imported registration --------------------------------------
    await check("Undated imported registration", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      const uId = await patient("Zzproofu", "Uniform", { imported: true });
      const createdRow = await q<{ d: string }>(
        `select (created_at at time zone 'Asia/Manila')::date::text as d from public.patients where id = $1`, [uId]);
      const uDay = createdRow.rows[0].d;

      const before2026 = await seriesRows("2026-01-01", "2026-12-31", "day", "new");
      const beforeOnDay = bucketTotal(before2026, uDay);

      const after = await summary();
      const d = delta(before, after);
      assert(d.undated_registrations === 1, `expected undated_registrations delta 1, got ${d.undated_registrations}`);
      const others = COUNT_FIELDS.filter((k) => k !== "undated_registrations");
      assert(others.every((k) => d[k] === 0), `expected every other June count unchanged, got ${JSON.stringify(d)}`);

      const after2026 = await seriesRows("2026-01-01", "2026-12-31", "day", "new");
      const afterOnDay = bucketTotal(after2026, uDay);
      assert(afterOnDay === beforeOnDay, `expected no change to the series row on U's created_at day ${uDay}, before=${beforeOnDay} after=${afterOnDay}`);

      // Control: an old visit makes it before_window, not undated.
      await visit(uId, "2023-10-01");
      const afterVisit = await summary();
      const d2 = delta(before, afterVisit);
      assert(d2.undated_registrations === 0, `after an old visit: expected undated_registrations delta back to 0 (before_window), got ${d2.undated_registrations}`);
    }));

    // 10. App-native registration, Manila date -------------------------------
    await check("App-native registration, Manila date", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await seriesRows("2026-06-15", "2026-06-16", "day", "new");
      const b15 = bucketTotal(before, "2026-06-15");
      const b16 = bucketTotal(before, "2026-06-16");

      const nId = await patient("Zzproofn", "November", { createdAt: "2026-06-15T20:00:00Z" });
      const after = await seriesRows("2026-06-15", "2026-06-16", "day", "new");
      assert(bucketTotal(after, "2026-06-15") === b15, `expected nothing new on 2026-06-15, got ${bucketTotal(after, "2026-06-15")} vs baseline ${b15}`);
      assert(bucketTotal(after, "2026-06-16") === b16 + 1, `expected +1 on 2026-06-16, got ${bucketTotal(after, "2026-06-16")} vs baseline ${b16}`);
      const idN = await identityRow(`patient:${nId}`);
      assert(idN?.first_date === "2026-06-16", `expected first_date 2026-06-16 (Manila day), got ${idN?.first_date}`);
    }));

    // 11. Restatement ---------------------------------------------------------
    await check("Restatement", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      const b10 = bucketTotal(before, "2026-06-10");
      const b20 = bucketTotal(before, "2026-06-20");

      const n2Id = await patient("Zzproofn2", "Nueva", { createdAt: "2026-06-10T02:00:00Z" });
      const mid = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      assert(bucketTotal(mid, "2026-06-10") === b10 + 1, `expected +1 on 2026-06-10 from the registration, got ${bucketTotal(mid, "2026-06-10")}`);

      await visit(n2Id, "2026-06-20");
      const after = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      assert(bucketTotal(after, "2026-06-10") === b10, `expected 2026-06-10 back to baseline once the visit restates the date, got ${bucketTotal(after, "2026-06-10")}`);
      assert(bucketTotal(after, "2026-06-20") === b20 + 1, `expected the +1 to move to 2026-06-20, got ${bucketTotal(after, "2026-06-20")}`);
    }));

    // 12. Suppression -----------------------------------------------------
    await check("Suppression", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      await patient("Zzproofs", "Maria", { createdAt: "2026-06-11T02:00:00Z" });
      await sheetLine("2026-06-12", "zzproofs|maria", null, 0);
      const after = await summary();
      const d = delta(before, after);
      assert(d.new_confirmed === 0, `expected new_confirmed delta 0 (suppressed), got ${d.new_confirmed}`);
      assert(d.new_unconfirmed === 1, `expected new_unconfirmed delta 1, got ${d.new_unconfirmed}`);
    }));

    // 13. Name-identity channel ---------------------------------------------
    await check("Name-identity channel", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await seriesRows(JUNE.from, JUNE.to, "period", "new");
      const beforeGoogle = before.find((r) => r.channel === "online_google")?.unconfirmed ?? 0;
      const beforeNotRecorded = before.find((r) => r.channel === "not_recorded")?.unconfirmed ?? 0;

      await sheetLine("2026-06-05", "zzproofc|one", null, 0);
      await customerRow("zzproofc|one", { source: "online_google" });

      await sheetLine("2026-06-06", "zzproofc|two", null, 0);
      await customerRow("zzproofc|two", { source: "online_google" });
      await customerRow("zzproofc|two", { source: "online_facebook" });

      const after = await seriesRows(JUNE.from, JUNE.to, "period", "new");
      const afterGoogle = after.find((r) => r.channel === "online_google")?.unconfirmed ?? 0;
      const afterNotRecorded = after.find((r) => r.channel === "not_recorded")?.unconfirmed ?? 0;

      assert(afterGoogle === beforeGoogle + 1, `expected the single-customer-row key to add 1 to online_google, before=${beforeGoogle} after=${afterGoogle}`);
      assert(afterNotRecorded === beforeNotRecorded + 1, `expected the two-source key to fall back to not_recorded, before=${beforeNotRecorded} after=${afterNotRecorded}`);
    }));

    // 14. Stream (a) filters --------------------------------------------------
    await check("Stream (a) filters", () => scoped(async () => {
      await setRole("postgres", null);

      // imported visit inside the mirror window -> excluded
      const p1 = await patient("Zzproofw1", "InWindow", { imported: true });
      await visit(p1, "2026-06-14", 100, { imported: true });
      let served = await peopleRows(JUNE.from, JUNE.to, "served", null, 1000, 0);
      assert(!served.some((r) => r.patient_id === p1), "imported visit inside the mirror window must not be served");

      // imported visit BEFORE the window -> served, in May
      const p2 = await patient("Zzproofw2", "PreWindow", { imported: true });
      await visit(p2, "2026-05-20", 100, { imported: true });
      const mayServed = await peopleRows("2026-05-01", "2026-05-31", "served", null, 1000, 0);
      assert(mayServed.some((r) => r.patient_id === p2), "pre-window imported visit must be served in May");
      served = await peopleRows(JUNE.from, JUNE.to, "served", null, 1000, 0);
      assert(!served.some((r) => r.patient_id === p2), "pre-window imported visit must not be served in June");

      // deleted visit -> excluded
      const p3 = await patient("Zzproofw3", "Deleted", {});
      const v3 = await visit(p3, "2026-06-15");
      await q(`update public.visits set deleted_at = now(), deleted_by = $1, delete_reason = 'proof' where id = $2`, [fx.adminId, v3]);
      served = await peopleRows(JUNE.from, JUNE.to, "served", null, 1000, 0);
      assert(!served.some((r) => r.patient_id === p3), "a deleted visit must not be served");

      // live visit, soft-deleted test_request -> served but PHP 0 revenue
      const p4 = await patient("Zzproofw4", "ZeroRevenue", {});
      const v4 = await visit(p4, "2026-06-16", 100);
      await q(`update public.test_requests set deleted_at = now(), deleted_by = $1, delete_reason = 'proof' where visit_id = $2`, [fx.adminId, v4]);
      served = await peopleRows(JUNE.from, JUNE.to, "served", null, 1000, 0);
      assert(served.some((r) => r.patient_id === p4), "served must still include the visit even with its test_request soft-deleted");
      const lineCheck = await q<{ php: string }>(
        `select coalesce(sum(l.php),0)::text as php from public._ps_revenue_lines($1,$2) l where l.survivor_id = $3`,
        [JUNE.from, JUNE.to, p4],
      );
      assert(Number(lineCheck.rows[0].php) === 0, `expected PHP 0 revenue for the soft-deleted test_request's visit, got ${lineCheck.rows[0].php}`);

      // an encounter on 2023-11-30 (before the window) is ignored everywhere
      const p5 = await patient("Zzproofw5", "TooOld", {});
      await visit(p5, "2023-11-30", 100);
      const oldServed = await peopleRows("2023-01-01", "2023-12-31", "served", null, 1000, 0);
      assert(!oldServed.some((r) => r.patient_id === p5), "an encounter before 2023-12-01 must be ignored entirely");
    }));

    // 15. Volume > 1,000 ------------------------------------------------------
    await check("Volume > 1,000", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      await q(
        `insert into public.sheet_encounter_lines
           (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id, identity_key, revenue_php, raw, row_hash, run_id)
         select 'lab', g, date '2026-06-03', 'Zzproofv ' || g, 'zzproofv ' || g, 'zzproofv|' || g, null,
                'name:zzproofv|' || g, 0, '{}'::jsonb, md5('vol-' || g), $1
           from generate_series(1, 1200) as g`,
        [fx.runId],
      );
      const after = await summary();
      const d = delta(before, after);
      assert(d.new_unconfirmed === 1200, `expected new_unconfirmed delta 1200, got ${d.new_unconfirmed}`);

      for (const src of ["online_google", "online_facebook", "walk_in"]) {
        await q(
          `insert into public.sheet_customer_rows
             (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, registered_on, referral_source_id,
              patient_id, link_state, row_hash, run_id)
           select g, md5('cust-' || $2 || '-' || g), 'Zzproofw ' || g, 'zzproofw ' || g, 'zzproofw' || g || $2,
                  md5('link-' || $2 || '-' || g), null, $2, null, 'unlinked', md5('custhash-' || $2 || '-' || g), $1
             from generate_series(0, 399) as g`,
          [fx.runId, src],
        );
        await q(
          `insert into public.sheet_encounter_lines
             (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id, identity_key, revenue_php, raw, row_hash, run_id)
           select 'lab', g, date '2025-06-01' + g, 'Zzproofw ' || g, 'zzproofw ' || g, 'zzproofw' || g || $2, null,
                  'name:zzproofw' || g || $2, 0, '{}'::jsonb, md5('volw-' || $2 || '-' || g), $1
             from generate_series(0, 399) as g`,
          [fx.runId, src],
        );
      }

      const rows = await seriesRows("2025-06-01", "2026-07-05", "day", "new");
      assert(rows.length > 1000, `expected more than 1000 series rows, got ${rows.length}`);
    }));

    // 16. Summary = series ----------------------------------------------------
    await check("Summary = series", () => scoped(async () => {
      await setRole("postgres", null);

      // Replay check 5's merge (served + new confirmed with a same-day overlap).
      const aId = await patient("Zzproofsa", "Alpha16");
      const bId = await patient("Zzproofsb", "Beta16");
      await q(`update public.patients set merged_into_id = $1 where id = $2`, [bId, aId]);
      await visit(bId, "2026-06-10", 300);
      await sheetLine("2026-06-10", "zzproofsb|beta16", aId, 250);

      // Replay check 12's suppression.
      await patient("Zzproofss", "Maria16", { createdAt: "2026-06-11T02:00:00Z" });
      await sheetLine("2026-06-12", "zzproofss|maria16", null, 0);

      // Replay check 13's name-identity channel split.
      await sheetLine("2026-06-05", "zzproofsc|one", null, 0);
      await customerRow("zzproofsc|one", { source: "online_google" });
      await sheetLine("2026-06-06", "zzproofsc|two", null, 0);
      await customerRow("zzproofsc|two", { source: "online_google" });
      await customerRow("zzproofsc|two", { source: "online_facebook" });

      const s = await summary();
      const daySeries = await seriesRows(JUNE.from, JUNE.to, "day", "new");
      const sumConfirmed = daySeries.reduce((n, r) => n + r.confirmed, 0);
      const sumUnconfirmed = daySeries.reduce((n, r) => n + r.unconfirmed, 0);
      assert(sumConfirmed === s.new_confirmed, `day series confirmed sum ${sumConfirmed} != summary.new_confirmed ${s.new_confirmed}`);
      assert(sumUnconfirmed === s.new_unconfirmed, `day series unconfirmed sum ${sumUnconfirmed} != summary.new_unconfirmed ${s.new_unconfirmed}`);

      const periodServed = await seriesRows(JUNE.from, JUNE.to, "period", "served");
      const servedConfirmed = periodServed.reduce((n, r) => n + r.confirmed, 0);
      const servedUnconfirmed = periodServed.reduce((n, r) => n + r.unconfirmed, 0);
      assert(servedConfirmed === s.served_confirmed, `period served confirmed ${servedConfirmed} != summary.served_confirmed ${s.served_confirmed}`);
      assert(servedUnconfirmed === s.served_unconfirmed, `period served unconfirmed ${servedUnconfirmed} != summary.served_unconfirmed ${s.served_unconfirmed}`);

      const weekRows = await seriesRows(JUNE.from, JUNE.to, "week", "new");
      for (const r of weekRows) {
        const dow = new Date(`${r.bucket_start}T00:00:00Z`).getUTCDay();
        assert(dow === 1, `week bucket_start ${r.bucket_start} is not a Monday (dow=${dow})`);
      }
      const monthRows = await seriesRows(JUNE.from, JUNE.to, "month", "new");
      for (const r of monthRows) {
        const day = Number(r.bucket_start.slice(8, 10));
        assert(day === 1, `month bucket_start ${r.bucket_start} is not the 1st (day=${day})`);
      }
    }));

    // 17. Referrers -------------------------------------------------------
    await check("Referrers", () => scoped(async () => {
      await setRole("postgres", null);
      for (const [last, first, doc] of [
        ["Zzproofref1", "One", "Dr. Juan Santos"],
        ["Zzproofref2", "Two", "Dr. Juan Santos"],
        ["Zzproofref3", "Three", "dra juan santos"],
      ] as [string, string, string][]) {
        const id = await patient(last, first);
        await q(`update public.patients set referred_by_doctor = $1 where id = $2`, [doc, id]);
        await visit(id, "2026-06-15");
      }
      const rows = await referrersRows();
      const row = rows.find((r) => r.doctor_label === "Dr. Juan Santos");
      assert(!!row, `expected a referrer row labelled "Dr. Juan Santos", got ${JSON.stringify(rows)}`);
      assert(row!.new_confirmed === 3, `expected new_confirmed 3 for Dr. Juan Santos, got ${row!.new_confirmed}`);
    }));

    // 18. Converted mode ----------------------------------------------------
    await check("Converted mode", () => scoped(async () => {
      await setRole("postgres", null);
      await q(`update public.sheet_sync_settings set converted_at = now() where id`);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const calls: { name: string; sql: string; params: unknown[] }[] = [
        { name: "patient_sources_summary", sql: `select public.patient_sources_summary($1::date,$2::date)`, params: [JUNE.from, JUNE.to] },
        { name: "patient_sources_series", sql: `select public.patient_sources_series($1::date,$2::date,'day','new')`, params: [JUNE.from, JUNE.to] },
        { name: "patient_sources_revenue", sql: `select public.patient_sources_revenue($1::date,$2::date)`, params: [JUNE.from, JUNE.to] },
        { name: "patient_sources_overlaps", sql: `select public.patient_sources_overlaps($1::date,$2::date)`, params: [JUNE.from, JUNE.to] },
        { name: "patient_sources_referrers", sql: `select public.patient_sources_referrers($1::date,$2::date,20)`, params: [JUNE.from, JUNE.to] },
        { name: "patient_sources_people", sql: `select public.patient_sources_people($1::date,$2::date,'new',null,50,0)`, params: [JUNE.from, JUNE.to] },
      ];
      for (const c of calls) {
        await expectPgError(`${c.name} in converted mode`, "0A000", () => q(c.sql, c.params));
      }
    }));

    // 19. Bad args ----------------------------------------------------------
    await check("Bad args", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      await expectPgError("series bad grain", "22023", () =>
        q(`select public.patient_sources_series($1::date,$2::date,'year','new')`, [JUNE.from, JUNE.to]));
      await expectPgError("series bad mode", "22023", () =>
        q(`select public.patient_sources_series($1::date,$2::date,'day','all')`, [JUNE.from, JUNE.to]));
      await expectPgError("summary from > to", "22023", () =>
        q(`select public.patient_sources_summary('2026-06-30'::date,'2026-06-01'::date)`));
      await expectPgError("summary > 400 days", "22023", () =>
        q(`select public.patient_sources_summary('2025-01-01'::date,'2026-06-30'::date)`));
      await expectPgError("people bad mode", "22023", () =>
        q(`select public.patient_sources_people($1::date,$2::date,'everyone',null,50,0)`, [JUNE.from, JUNE.to]));
    }));

    // 20. People list -------------------------------------------------------
    await check("People list", () => scoped(async () => {
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_encounter_lines
           (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id, identity_key, revenue_php, raw, row_hash, run_id)
         select 'lab', g, date '2026-06-03', 'Zzproofp Person ' || g, 'zzproofp person ' || g, 'zzproofp|' || g, null,
                'name:zzproofp|' || g, 0, '{}'::jsonb, md5('ppl-' || g), $1
           from generate_series(1, 120) as g`,
        [fx.runId],
      );
      const confId = await patient("Zzproofpq", "Query");
      await visit(confId, "2026-06-03");

      const page0 = await peopleRows(JUNE.from, JUNE.to, "new", null, 50, 0);
      const page1 = await peopleRows(JUNE.from, JUNE.to, "new", null, 50, 50);
      const page2 = await peopleRows(JUNE.from, JUNE.to, "new", null, 50, 100);
      assert(page0.length === 50, `page0: expected 50 rows, got ${page0.length}`);
      assert(Number(page0[0].total_count) >= 120, `expected total_count >= 120, got ${page0[0].total_count}`);

      const all = [...page0, ...page1, ...page2];
      const identities = all.map((r) => r.identity);
      assert(new Set(identities).size === identities.length, "expected no duplicate identity across pages 0/50/100");
      for (let i = 1; i < all.length; i++) {
        const a = all[i - 1];
        const b = all[i];
        const ok = a.first_date < b.first_date || (a.first_date === b.first_date && a.identity <= b.identity);
        assert(ok, `expected sort by (first_date, identity); broke at index ${i}: ${JSON.stringify(a)} then ${JSON.stringify(b)}`);
      }

      const nameRow = all.find((r) => r.identity === "name:zzproofp|1");
      assert(!!nameRow && nameRow.display_name === "Zzproofp Person 1", `expected the typed name for a name row, got ${JSON.stringify(nameRow)}`);
      const confRow = all.find((r) => r.patient_id === confId);
      assert(!!confRow && confRow.display_name === "Zzproofpq, Query", `expected "Last, First" for a confirmed row, got ${JSON.stringify(confRow)}`);

      const past = await peopleRows(JUNE.from, JUNE.to, "new", null, 50, 5000);
      assert(past.length === 0, `expected 0 rows past the end, got ${past.length}`);
    }));

    // 21. Ad spend import/replace/zero/delete --------------------------------
    await check("Ad spend import/replace/zero/delete", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });

      const uploadId1 = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const r1 = await expectOk("first import", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadId1,
          JSON.stringify([
            { spend_date: "2026-06-01", platform: "meta", campaign_key: "c1", ad_key: "a1", campaign_label: "C1", spend_php: 100 },
            { spend_date: "2026-06-01", platform: "meta", campaign_key: "c1", ad_key: "a1", campaign_label: "C1", spend_php: 50 },
            { spend_date: "2026-06-01", platform: "meta", campaign_key: "c1", ad_key: "a2", campaign_label: "C1", spend_php: 10 },
          ]),
        ]));
      const j1 = r1.rows[0].ad_spend_import;
      assert(j1.inserted === 2 && j1.replaced === 0 && j1.days === 1, `first import: expected {inserted:2,replaced:0,days:1}, got ${JSON.stringify(j1)}`);

      let a1 = await q<{ php: string }>(`select spend_php::text as php from public.ad_spend_daily where campaign_key='c1' and ad_key='a1'`);
      assert(Number(a1.rows[0].php) === 150, `a1 after dup-sum: expected 150, got ${a1.rows[0].php}`);

      const uploadId2 = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const r2 = await expectOk("second import (a2 only)", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadId2,
          JSON.stringify([{ spend_date: "2026-06-01", platform: "meta", campaign_key: "c1", ad_key: "a2", campaign_label: "C1", spend_php: 20 }]),
        ]));
      const j2 = r2.rows[0].ad_spend_import;
      assert(j2.inserted === 0 && j2.replaced === 1, `second import: expected {inserted:0,replaced:1,...}, got ${JSON.stringify(j2)}`);
      a1 = await q<{ php: string }>(`select spend_php::text as php from public.ad_spend_daily where campaign_key='c1' and ad_key='a1'`);
      assert(Number(a1.rows[0].php) === 150, `a1 must be untouched by a partial upload, got ${a1.rows[0].php}`);

      const uploadId3 = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const r3 = await expectOk("zero correction", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadId3,
          JSON.stringify([{ spend_date: "2026-06-01", platform: "meta", campaign_key: "c1", ad_key: "a1", campaign_label: "C1", spend_php: 0, impressions: 0, clicks: 0 }]),
        ]));
      const j3 = r3.rows[0].ad_spend_import;
      assert(j3.inserted === 0 && j3.replaced === 1, `zero correction: expected {inserted:0,replaced:1,...}, got ${JSON.stringify(j3)}`);
      a1 = await q<{ php: string }>(`select spend_php::text as php from public.ad_spend_daily where campaign_key='c1' and ad_key='a1'`);
      assert(Number(a1.rows[0].php) === 0, `a1 after zero correction: expected 0, got ${a1.rows[0].php}`);

      const beforeCount = await q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily`);
      const uploadId4 = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      await expectPgError("negative spend all-or-nothing", "23514", () =>
        q(`select public.ad_spend_import($1::uuid, $2::jsonb)`, [
          uploadId4,
          JSON.stringify([
            { spend_date: "2026-06-02", platform: "meta", campaign_key: "c9", ad_key: "a9", campaign_label: "C9", spend_php: 5 },
            { spend_date: "2026-06-02", platform: "meta", campaign_key: "c9", ad_key: "a10", campaign_label: "C9", spend_php: -1 },
          ]),
        ]));
      const afterCount = await q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily`);
      assert(afterCount.rows[0].n === beforeCount.rows[0].n, `a rejected import must change nothing, before=${beforeCount.rows[0].n} after=${afterCount.rows[0].n}`);

      const auditRow = await q<{ metadata: Json }>(
        `select metadata from public.audit_log where action = 'ad_spend.imported' and resource_id = $1`, [uploadId1]);
      assert(auditRow.rows.length === 1, "expected exactly one audit row for the first import");
      const keys = Object.keys(auditRow.rows[0].metadata).sort();
      assert(JSON.stringify(keys) === JSON.stringify(["days", "inserted", "replaced"]), `expected audit metadata keys exactly inserted/replaced/days, got ${keys}`);

      const delN = await expectOk("ad_spend_delete", () =>
        q<{ ad_spend_delete: number }>(`select public.ad_spend_delete('meta','2026-06-01','2026-06-01') as ad_spend_delete`));
      assert(delN.rows[0].ad_spend_delete === 2, `expected ad_spend_delete to remove 2 rows (a1,a2), got ${delN.rows[0].ad_spend_delete}`);
      const delAudit = await q<{ n: string }>(`select count(*)::text as n from public.audit_log where action = 'ad_spend.deleted'`);
      assert(Number(delAudit.rows[0].n) >= 1, "expected an ad_spend.deleted audit row");

      await expectPgError("delete unknown platform", "22023", () => q(`select public.ad_spend_delete('tiktok','2026-06-01','2026-06-01')`));
    }));

    // 22. Whole history, not the period --------------------------------------
    await check("Whole history, not the period", () => scoped(async () => {
      await setRole("postgres", null);
      const beforeJune = await summary(JUNE.from, JUNE.to);
      const beforeMay = await summary("2026-05-01", "2026-05-31");

      const wId = await patient("Zzproofwh", "Whole");
      await visit(wId, "2026-05-20");
      await visit(wId, "2026-06-18");

      const afterJune = await summary(JUNE.from, JUNE.to);
      const afterMay = await summary("2026-05-01", "2026-05-31");

      const dJune = delta(beforeJune, afterJune);
      assert(dJune.served_confirmed === 1, `June: expected served_confirmed delta 1, got ${dJune.served_confirmed}`);
      assert(dJune.new_confirmed === 0, `June: expected new_confirmed delta 0 (first seen in May), got ${dJune.new_confirmed}`);

      const dMay = delta(beforeMay, afterMay);
      assert(dMay.new_confirmed === 1, `May: expected new_confirmed delta 1, got ${dMay.new_confirmed}`);
    }));

    // 23. Customers-only name identities (P6) --------------------------------
    await check("Customers-only name identities (P6)", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();

      await customerRow("zzproofk|dated", { registeredOn: "2026-06-08" });
      await customerRow("zzproofk|undated", {});
      await customerRow("zzproofk|two", { registeredOn: "2026-06-09", source: "online_google" });
      await customerRow("zzproofk|two", { registeredOn: "2026-06-12", source: "walk_in" });

      const after = await summary();
      const d = delta(before, after);
      assert(d.new_unconfirmed === 2, `expected new_unconfirmed delta 2 (dated + the two-row key), got ${d.new_unconfirmed}`);
      assert(d.undated_registrations === 1, `expected undated_registrations delta 1, got ${d.undated_registrations}`);

      const idDated = await identityRow("name:zzproofk|dated");
      assert(idDated?.first_date === "2026-06-08", `(i) expected first_date 2026-06-08, got ${idDated?.first_date}`);

      const idTwo = await identityRow("name:zzproofk|two");
      assert(idTwo?.first_date === "2026-06-09", `(iii) expected first_date 2026-06-09 (min across the two rows), got ${idTwo?.first_date}`);
      assert(idTwo?.channel === "not_recorded", `(iii) expected channel not_recorded for a 2-row key, got ${idTwo?.channel}`);
    }));
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
    console.error("\npatient-sources:db-proof crashed before finishing:");
    console.error(err);
    process.exit(1);
  });
