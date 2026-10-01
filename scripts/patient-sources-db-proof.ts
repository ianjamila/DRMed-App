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
//   MIG_LIVE — where each body lives NOW (a control that edits a superseded
//   body proves nothing): identity core + encounters + revenue lines =
//   0193_sync_review_gaps.sql; the five report RPCs + their rules =
//   0206_patient_sources_report.sql (_ps_sec_* helpers and wrappers);
//   patient_sources_people = 0189. Letters A, B, C, E, F, G, L edit the core
//   -> edit 0193 (psql -f 0193 is safe: create-or-replace + its own
//   post-conditions). Letter D edits the summary WRAPPER gate -> 0206 (and
//   drop summary from 0206's post-condition arrays for that round).
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
//   H. (2026-09-28 Codex recheck superseded this — see I/J/K/L below. Its
//      original mechanism, "delete every saved row in a touched campaign/day
//      regardless of kind", is EXACTLY control I's regression now — H is kept
//      here only as a pointer, not a separate round.)
//   I. ad_spend_import (Codex recheck #1, partial-preserve fix, 2026-09-28):
//      replace the kind-aware delete with an unconditional whole-group
//      delete (the prior round's bug — deletes every ad in the group, not
//      just the ones of a different kind):
//        delete from public.ad_spend_daily a
//        using ( select r.spend_date, r.platform, r.campaign_key, min(case …) as kind from … group by … ) g
//        where a.spend_date = g.spend_date and a.platform = g.platform and a.campaign_key = g.campaign_key
//          and (case …) <> g.kind;
//        -> delete from public.ad_spend_daily a
//           using ( select distinct r.spend_date, r.platform, r.campaign_key from … ) g
//           where a.spend_date = g.spend_date and a.platform = g.platform and a.campaign_key = g.campaign_key;
//      Expect: FAIL Ad spend import/replace/zero/delete. Confirmed 2026-09-28:
//        FAIL … — cz partial re-upload: expected replaced 1 (A's own prior
//        row), got {"days":1,"inserted":1,"replaced":2}
//      (the sibling ad B is wiped by a partial upload that only mentions A).
//   J. ad_spend_import (Codex recheck #1, incomplete-file guard, 2026-09-28):
//      delete the `if v_kind_changed and p_rejected_count > 0 then raise …`
//      block. Expect: FAIL Ad spend import/replace/zero/delete. Confirmed
//      2026-09-28:
//        FAIL … — kind change refused when the file had rejected rows:
//        expected error 22023, but the call succeeded
//      (a representation change from an incomplete file is silently allowed).
//   K. ad_spend_import (Codex recheck #3, concurrency, 2026-09-28): delete the
//      `perform pg_advisory_xact_lock(hashtext('ad_spend_import'));` line
//      (the FIRST occurrence, inside ad_spend_import). Expect: FAIL Ad spend
//      import: concurrent writes serialize. Confirmed 2026-09-28:
//        FAIL … — expected connection B to be REFUSED the ad_spend_import
//        lock while connection A's transaction is still open, got
//        {"got":true}
//   L. _patient_sources_identities, `confirmed` CASE (owner decision
//      2026-09-28): put registration back ahead of before_window:
//        when sup.survivor_id is not null then null
//        when ov.survivor_id is not null then null
//        else r.reg_on end as first_date,
//        …
//        when sup.survivor_id is not null then 'suppressed'
//        when ov.survivor_id is not null then 'before_window'
//        when r.reg_on is not null then 'registration'
//        -> when sup.survivor_id is not null then null
//           else r.reg_on end as first_date,
//           …
//           when sup.survivor_id is not null then 'suppressed'
//           when r.reg_on is not null then 'registration'
//           when ov.survivor_id is not null then 'before_window'
//      Expect: FAIL P5: an old visitor with a later registration date is not
//      New. Confirmed 2026-09-28:
//        FAIL … — expected basis 'before_window' (not 'registration'), got
//        {"first_date":"2026-06-15","basis":"registration", …}
//   D (re-pointed to 0206, 2026-09-30). Confirmed: FAIL ACL matrix - functions
//      — ACL reception/patient_sources_summary: expected error 42501, but the
//      call succeeded (also fails the two 0199 service_role checks).
//   M–P (0206, 2026-09-30), each confirmed with the FAIL line quoted:
//   M. patient_sources_report: delete the 'overlaps' entry. Confirmed
//      2026-09-30: FAIL 0206: report sections equal the single RPCs (with and
//      without a previous period) — 2026-06-01..2026-06-30 day/new prev=set:
//      sections are current,new_by_day,previous,referrers,revenue,series,summary
//   N. patient_sources_report 'current': 'period', p_mode -> 'period', 'new'.
//      Confirmed 2026-09-30: FAIL 0206: report sections equal the single RPCs
//      … — 2026-06-01..2026-06-30 week/served prev=null current: report=[…
//      "confirmed":4,"unconfirmed":0 …] rpc=[… "confirmed":4,"unconfirmed":1 …]
//   O. patient_sources_report gate: drop the coalesce -> the migration's own
//      post-condition aborts ("0206: public.patient_sources_report(...) does
//      not carry the coalesced service_role gate"). Then also drop the report
//      from that post-condition's gate array. Confirmed 2026-09-30: FAIL 0206:
//      report gate matrix — no JWT claims at all: expected error 42501, but
//      the call succeeded; and FAIL 0206: helpers and list builders are
//      closed; row types match their producers — patient_sources_report
//      ACL/definer/gate wrong: {"a":false,"u":true,"s":true,"sd":true,"gate":false}
//   P. _ps_sec_series 'new' branch: `and not i.is_returning` -> `and true`.
//      Confirmed 2026-09-30: FAIL 0206: every wrapper returns exactly the
//      pre-0206 rows — wrappers differ from the pre-0206 bodies: (the proof
//      prints only the first line; the per-call diffs follow it in the message)
//   0206 re-apply needs the objects dropped first:
//     psql $DB -c "drop function if exists public.patient_sources_report(date,date,text,text,date,date);
//                  drop type if exists public._ps_identity, public._ps_encounter, public._ps_revenue_line cascade;"
//
//   for each letter: edit $MIG, then
//     $PSQL $DB -v ON_ERROR_STOP=1 -f $MIG
//     npm run patient-sources:db-proof
//   then revert the edit and re-apply before the next letter, and once more
//   at the end to confirm all-PASS.
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import fs from "node:fs";
import path from "node:path";
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

type DbRole = "postgres" | "anon" | "authenticated" | "service_role";
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

  // 0196/0197: merge markers are written through the private merge writer,
  // both columns together (0197 refuses anything else). Session-level SET ROLE
  // (not SET LOCAL, which is a no-op outside a transaction block), undone
  // right after the one statement.
  async function markMerged(srcId: string, keepId: string): Promise<void> {
    await q(`set role patient_merge_writer`);
    try {
      await q(`update public.patients set merged_into_id = $1, merged_at = now() where id = $2`, [keepId, srcId]);
    } finally {
      await q(`reset role`);
    }
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
    opts: {
      patientId?: string | null; source?: string | null; registeredOn?: string | null;
      referredBy?: string | null; sheetRow?: number;
    } = {},
  ): Promise<void> {
    await q(
      `insert into public.sheet_customer_rows
         (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, registered_on, referral_source_id,
          referred_by_raw, patient_id, link_state, row_hash, run_id)
       values ($8, md5(random()::text), $1, $1, $1, md5(random()::text), $2, $3, $4, $5, $6, md5(random()::text), $7)`,
      [looseKey, opts.registeredOn ?? null, opts.source ?? null, opts.referredBy ?? null, opts.patientId ?? null,
       opts.patientId ? "linked" : "unlinked", fx.runId, opts.sheetRow ?? 1],
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
  // ---- 0206: a seeded world where every section is non-empty ----------
  // Dates straddle the three comparison periods below. Built inside a
  // scoped() check, so it never outlives that check.
  const loose = (last: string, first: string) => looseKeyOf({ last, first, middle: null });
  const P_EARLY = { from: "2023-12-01", to: "2024-01-31" };
  const P_JUNE = { from: "2026-06-01", to: "2026-06-30" };
  const P_LONG = { from: "2025-08-27", to: "2026-09-30" }; // exactly 400 days
  const PERIODS = [P_EARLY, P_JUNE, P_LONG];

  interface World { del: string; dup: string; surv: string; regOnly: string; old: string; imp: string; }
  async function seedWorld(): Promise<World> {
    const sources = ["walk_in", "online_facebook", "online_google", null] as const;
    const days = ["2023-12-05", "2024-01-20", "2025-09-10", "2026-02-14", "2026-06-03", "2026-06-17", "2026-06-28", "2026-09-29"];
    // App-native patients, one per (source, day), with a priced visit that day.
    let n = 0;
    const firstDayIds: string[] = [];
    for (const source of sources) {
      for (const d of days) {
        n += 1;
        const id = await patient(`World${n}`, `App${n}`, { source: source ?? undefined, createdAt: `${d}T09:00:00+08:00` });
        await visit(id, d, 300 + n);
        if (d === days[0]) firstDayIds.push(id);
        if (n % 3 === 0) await visit(id, "2026-06-20", 150); // a repeat visit inside June
        if (n % 4 === 0) await q(`update public.patients set referred_by_doctor = $1 where id = $2`, [`Dr. World ${n % 3}`, id]);
      }
    }
    // An early referrer, so referrers is non-empty for P_EARLY too.
    await q(`update public.patients set referred_by_doctor = 'Dr. Early' where id = $1`, [firstDayIds[0]]);
    // Activity inside both previous windows used by the report-sections check.
    const prevA = await patient("WorldPrevA", "Pia", { source: "walk_in", createdAt: "2026-05-15T09:00:00+08:00" });
    await visit(prevA, "2026-05-15", 260);
    await sheetLine("2026-05-20", loose("WorldPrevSheetA", "Pam"), null, 90);
    const prevB = await patient("WorldPrevB", "Pio", { source: "online_facebook", createdAt: "2025-03-01T09:00:00+08:00" });
    await visit(prevB, "2025-03-01", 270);
    await sheetLine("2025-03-05", loose("WorldPrevSheetB", "Pat"), null, 95);
    // Imported patient with a sheet registration + returning flag, linked sheet lines, and a same-day app visit (overlap).
    const imp = await patient("WorldImported", "Ivy", { source: "online_google", imported: true });
    await facts(imp, "2026-06-05", "repeat");
    await customerRow(loose("WorldImported", "Ivy"), { patientId: imp, source: "online_google", registeredOn: "2026-06-05", referredBy: "Dr. Sheetworld" });
    await visit(imp, "2026-06-10", 500);
    await sheetLine("2026-06-10", loose("WorldImported", "Ivy"), imp, 700);
    await sheetLine("2026-06-12", loose("WorldImported", "Ivy"), imp, 200);
    // Merged pair: the duplicate's visit counts for the survivor.
    const surv = await patient("WorldMerge", "Sam", { source: "walk_in", createdAt: "2026-06-02T10:00:00+08:00" });
    const dup = await patient("WorldMerge", "Samuel", { source: "online_facebook", createdAt: "2026-06-04T10:00:00+08:00" });
    await visit(dup, "2026-06-06", 250);
    await markMerged(dup, surv);
    // Deleted patient: must drop out everywhere.
    const del = await patient("WorldDeleted", "Dee", { source: "walk_in", createdAt: "2026-06-08T10:00:00+08:00" });
    await visit(del, "2026-06-08", 999);
    await softDelete(del);
    // Unlinked sheet names (unconfirmed), one with a single Customers row + referrer, one lines-only.
    await customerRow(loose("WorldSheet", "Una"), { source: "online_facebook", registeredOn: "2026-06-09", referredBy: "Dr. World 1" });
    await sheetLine("2026-06-15", loose("WorldSheet", "Una"), null, 400);
    await sheetLine("2025-10-01", loose("WorldSheet", "Lina"), null, 120);
    await sheetLine("2026-06-15", loose("WorldSheet", "Lina"), null, 80);
    // Registration-only (no visit) and undated (no date at all) patients.
    const regOnly = await patient("WorldRegOnly", "Rae", { imported: true });
    await facts(regOnly, "2026-06-21", "new");
    await patient("WorldUndated", "Uri", { imported: true });
    // Pre-window visitor with a later registration: never New.
    const old = await patient("WorldOld", "Ola", { source: "walk_in", createdAt: "2026-06-11T10:00:00+08:00" });
    await visit(old, "2023-06-01", 100);
    return { del, dup, surv, regOnly, old, imp };
  }

  /** Which labels the seed guarantees non-empty for a period (overlaps only exist from June on). */
  const mustBeNonEmpty = (label: string, p: { from: string; to: string }) => !(label.startsWith("overlaps") && p === P_EARLY);

  // Both sides go through node-pg's jsonb parsing (so numeric 1500.00 and 1500
  // both become 1500) and are sorted AFTER that, in JS — sorting on jsonb text
  // in SQL would order "1500.00" and "1500" differently.
  const canon = (rows: unknown[]) => JSON.stringify(rows.map((x) => JSON.stringify(x)).sort());
  /** Canonical, order-insensitive JSON of a set-returning call. */
  async function rowsJson(sql: string, params: unknown[]): Promise<string> {
    const r = await q<{ j: unknown }>(`select to_jsonb(t) as j from (${sql}) t`, params);
    return canon(r.rows.map((x) => x.j));
  }
  /** Canonical JSON of a report section (already parsed jsonb). */
  async function sortedJson(arr: unknown): Promise<string> {
    return canon(Array.isArray(arr) ? arr : []);
  }
  /** Every (function, args) the page and CSV use, per period. `schema` is 'public' or 'ps_old'. */
  function gridCalls(schema: "public" | "ps_old", p: { from: string; to: string }) {
    const calls: { label: string; sql: string; params: unknown[] }[] = [
      { label: "summary", sql: `select * from ${schema}.patient_sources_summary($1, $2)`, params: [p.from, p.to] },
      { label: "revenue", sql: `select * from ${schema}.patient_sources_revenue($1, $2)`, params: [p.from, p.to] },
      { label: "overlaps", sql: `select * from ${schema}.patient_sources_overlaps($1, $2)`, params: [p.from, p.to] },
      { label: "referrers", sql: `select * from ${schema}.patient_sources_referrers($1, $2, 20)`, params: [p.from, p.to] },
      { label: "referrers limit 1", sql: `select * from ${schema}.patient_sources_referrers($1, $2, 1)`, params: [p.from, p.to] },
    ];
    for (const grain of ["day", "week", "month", "period"]) {
      for (const mode of ["new", "served"]) {
        calls.push({ label: `series ${grain}/${mode}`, sql: `select * from ${schema}.patient_sources_series($1, $2, $3, $4)`, params: [p.from, p.to, grain, mode] });
      }
    }
    return calls;
  }

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
        { name: "patient_sources_report", sql: `select public.patient_sources_report('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text,null::date,null::date)` },
        { name: "patient_sources_people", sql: `select public.patient_sources_people('2026-06-01'::date,'2026-06-30'::date,'new'::text,null::text,50::int,0::int)` },
        { name: "ad_spend_import", sql: `select public.ad_spend_import(gen_random_uuid(), '[{"spend_date":"2026-06-01","platform":"meta","campaign_key":"c","ad_key":"a","campaign_label":"C","spend_php":1}]'::jsonb)` },
        { name: "ad_spend_delete", sql: `select public.ad_spend_delete('meta'::text,'2026-06-01'::date,'2026-06-01'::date)` },
        { name: "ad_spend_daily_totals", sql: `select public.ad_spend_daily_totals('2026-06-01'::date,'2026-06-30'::date)` },
        { name: "ad_spend_coverage", sql: `select public.ad_spend_coverage()` },
        { name: "ad_spend_rows", sql: `select * from public.ad_spend_rows('2026-06-01'::date,'2026-06-30'::date)` },
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
      await markMerged(aId, bId);
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
      await markMerged(mId, sId);

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
      await markMerged(a1Id, i1Id);
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
      await markMerged(i2Id, i3Id);
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
      const oldEnc = await q(`select 1 from public._patient_sources_encounters() e where e.survivor_id = $1`, [p5]);
      assert(oldEnc.rows.length === 0, "an encounter before 2023-12-01 must be ignored entirely");

      // (P1) Revenue is the CLINIC's share: a doctor consult line carries the
      // whole doctor fee in final_price_php and the clinic's cut in
      // clinic_fee_php; a line with no clinic fee (lab) counts its final price.
      const p6 = await patient("Zzproofw6", "ConsultPf", {});
      const v6 = await visit(p6, "2026-06-18", 0);
      await q(
        `insert into public.test_requests (visit_id, service_id, requested_by, final_price_php, clinic_fee_php, doctor_pf_php)
         values ($1, $2, $3, 600, 100, 500), ($1, $2, $3, 250, null, null)`,
        [v6, fx.serviceId, fx.adminId],
      );
      const clinicShare = await q<{ php: string }>(
        `select coalesce(sum(l.php),0)::text as php from public._ps_revenue_lines($1,$2) l where l.survivor_id = $3`,
        [JUNE.from, JUNE.to, p6],
      );
      assert(Number(clinicShare.rows[0].php) === 350,
        `P1: expected clinic share 350 (consult 100 of 600 + lab 250), got ${clinicShare.rows[0].php}`);
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
      await markMerged(aId, bId);
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
      // Sheet referrer found via a MERGED member row: X (the survivor) has no
      // app referred_by_doctor; Y merges into X and carries two sheet rows —
      // only the LATEST by sheet_row must win.
      const xId = await patient("Zzproofrefx", "XRay");
      const yId = await patient("Zzproofrefy", "YRay");
      await markMerged(yId, xId);
      await visit(xId, "2026-06-16");
      await customerRow("zzproofrefy|earlier", { patientId: yId, referredBy: "Dr. Earlyref", sheetRow: 1 });
      await customerRow("zzproofrefy|later", { patientId: yId, referredBy: "Dr. Latestref", sheetRow: 5 });

      // App referred_by_doctor beats a sheet referrer on the same survivor.
      const zId = await patient("Zzproofrefz", "ZRay");
      await q(`update public.patients set referred_by_doctor = 'Dr. Appwinsref' where id = $1`, [zId]);
      await visit(zId, "2026-06-17");
      await customerRow("zzproofrefz|sheet", { patientId: zId, referredBy: "Dr. Sheetloseref", sheetRow: 1 });

      const rows = await referrersRows();
      const row = rows.find((r) => r.doctor_label === "Dr. Juan Santos");
      assert(!!row, `expected a referrer row labelled "Dr. Juan Santos", got ${JSON.stringify(rows)}`);
      assert(row!.new_confirmed === 3, `expected new_confirmed 3 for Dr. Juan Santos, got ${row!.new_confirmed}`);

      const rowLatest = rows.find((r) => r.doctor_label === "Dr. Latestref");
      assert(!!rowLatest && rowLatest.new_confirmed === 1, `expected the LATEST sheet row (via the merged member) to win, got ${JSON.stringify(rows)}`);
      const rowEarly = rows.find((r) => r.doctor_label === "Dr. Earlyref");
      assert(!rowEarly, `the earlier sheet row must not surface as its own referrer, got ${JSON.stringify(rows)}`);

      const rowAppWins = rows.find((r) => r.doctor_label === "Dr. Appwinsref");
      assert(!!rowAppWins && rowAppWins.new_confirmed === 1, `expected the app referred_by_doctor to win over a sheet referrer, got ${JSON.stringify(rows)}`);
      const rowSheetLoses = rows.find((r) => r.doctor_label === "Dr. Sheetloseref");
      assert(!rowSheetLoses, `a sheet referrer must not surface when the app field is set, got ${JSON.stringify(rows)}`);
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
      // (P2) Visit history starts 2023-12-01; an earlier start is refused (not shown wrong).
      await expectPgError("summary before 2023-12-01", "22023", () =>
        q(`select public.patient_sources_summary('2023-11-30'::date,'2023-12-31'::date)`));
      await expectPgError("series before 2023-12-01", "22023", () =>
        q(`select public.patient_sources_series('2022-06-01'::date,'2022-06-30'::date,'day','new')`));
      await expectOk("summary from exactly 2023-12-01", () =>
        q(`select public.patient_sources_summary('2023-12-01'::date,'2023-12-31'::date)`));
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

      // -- Intra-upload dedup: duplicate (date,platform,campaign,ad) rows in
      // ONE upload are summed before saving. --
      const uploadId1 = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const r1 = await expectOk("first import (dup-sum)", () =>
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
      const a1v1 = await q<{ php: string }>(`select spend_php::text as php from public.ad_spend_daily where campaign_key='c1' and ad_key='a1'`);
      assert(Number(a1v1.rows[0].php) === 150, `a1 after dup-sum: expected 150, got ${a1v1.rows[0].php}`);

      // -- B (Codex #1, DB half): a campaign uploaded first as a total, then
      // broken into per-ad rows, then re-keyed by ad ID, must always save the
      // SAME total for (day, campaign) — an upload REPLACES everything saved
      // for each (spend_date, platform, campaign_key) it contains, so a stale
      // ad_key from an earlier, differently-shaped upload never survives
      // alongside the new one and gets counted twice. A sibling campaign on
      // the same day must be untouched by any of this. --
      const cxTotal = async () => {
        const r = await q<{ php: string | null }>(
          `select sum(spend_php)::text as php from public.ad_spend_daily where campaign_key='cx' and spend_date='2026-06-05'`);
        return Number(r.rows[0].php ?? 0);
      };
      const cxRowCount = async () => {
        const r = await q<{ n: string }>(
          `select count(*)::text as n from public.ad_spend_daily where campaign_key='cx' and spend_date='2026-06-05'`);
        return Number(r.rows[0].n);
      };
      const uploadCy = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      await expectOk("sibling campaign cy seed", () =>
        q(`select public.ad_spend_import($1::uuid, $2::jsonb)`, [
          uploadCy,
          JSON.stringify([{ spend_date: "2026-06-05", platform: "meta", campaign_key: "cy", ad_key: "(campaign)", campaign_label: "CY", spend_php: 77 }]),
        ]));

      const uploadA = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rA = await expectOk("cx campaign-total upload", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadA,
          JSON.stringify([{ spend_date: "2026-06-05", platform: "meta", campaign_key: "cx", ad_key: "(campaign)", campaign_label: "CX", spend_php: 100 }]),
        ]));
      assert(rA.rows[0].ad_spend_import.replaced === 0, `cx first upload: expected replaced 0, got ${JSON.stringify(rA.rows[0].ad_spend_import)}`);
      assert((await cxTotal()) === 100, `cx after campaign-total upload: expected total 100, got ${await cxTotal()}`);
      assert((await cxRowCount()) === 1, `cx after campaign-total upload: expected 1 row, got ${await cxRowCount()}`);

      const uploadB = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rB = await expectOk("cx per-ad-name upload", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadB,
          JSON.stringify([
            { spend_date: "2026-06-05", platform: "meta", campaign_key: "cx", ad_key: "video a", campaign_label: "CX", spend_php: 60 },
            { spend_date: "2026-06-05", platform: "meta", campaign_key: "cx", ad_key: "video b", campaign_label: "CX", spend_php: 40 },
          ]),
        ]));
      assert(rB.rows[0].ad_spend_import.replaced === 1, `cx per-ad upload: expected replaced 1 (the old campaign-total row), got ${JSON.stringify(rB.rows[0].ad_spend_import)}`);
      assert((await cxTotal()) === 100, `cx after per-ad upload: expected total STILL 100, not 200 — got ${await cxTotal()}`);
      assert((await cxRowCount()) === 2, `cx after per-ad upload: expected 2 rows, got ${await cxRowCount()}`);

      const uploadC = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rC = await expectOk("cx per-ad-ID upload", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadC,
          JSON.stringify([
            { spend_date: "2026-06-05", platform: "meta", campaign_key: "cx", ad_key: "id:1", campaign_label: "CX", spend_php: 60 },
            { spend_date: "2026-06-05", platform: "meta", campaign_key: "cx", ad_key: "id:2", campaign_label: "CX", spend_php: 40 },
          ]),
        ]));
      assert(rC.rows[0].ad_spend_import.replaced === 2, `cx per-ad-ID upload: expected replaced 2 (both prior per-ad rows), got ${JSON.stringify(rC.rows[0].ad_spend_import)}`);
      assert((await cxTotal()) === 100, `cx after per-ad-ID upload: expected total STILL 100, not 200/300 — got ${await cxTotal()}`);
      assert((await cxRowCount()) === 2, `cx after per-ad-ID upload: expected 2 rows, got ${await cxRowCount()}`);

      const cyAfter = await q<{ php: string }>(`select spend_php::text as php from public.ad_spend_daily where campaign_key='cy' and spend_date='2026-06-05'`);
      assert(Number(cyAfter.rows[0].php) === 77, `sibling campaign cy: expected untouched at 77, got ${cyAfter.rows[0].php}`);

      // -- Codex recheck #1: a SAME-KIND partial upload (still per-ad-by-name)
      // keeps the sibling ad it doesn't mention (spec §2.1 lines 108–111) —
      // only a representation CHANGE replaces the whole group. --
      const czRow = async (adKey: string): Promise<number | null> => {
        const r = await q<{ php: string }>(
          `select spend_php::text as php from public.ad_spend_daily where campaign_key='cz' and ad_key=$1`, [adKey]);
        return r.rows[0] ? Number(r.rows[0].php) : null;
      };
      const uploadG = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rG = await expectOk("cz first upload (A=60, B=40)", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadG,
          JSON.stringify([
            { spend_date: "2026-06-06", platform: "meta", campaign_key: "cz", ad_key: "a", campaign_label: "CZ", spend_php: 60 },
            { spend_date: "2026-06-06", platform: "meta", campaign_key: "cz", ad_key: "b", campaign_label: "CZ", spend_php: 40 },
          ]),
        ]));
      assert(rG.rows[0].ad_spend_import.replaced === 0, `cz first upload: expected replaced 0, got ${JSON.stringify(rG.rows[0].ad_spend_import)}`);

      const uploadH = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rH = await expectOk("cz partial re-upload (A only, same kind)", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadH,
          JSON.stringify([{ spend_date: "2026-06-06", platform: "meta", campaign_key: "cz", ad_key: "a", campaign_label: "CZ", spend_php: 70 }]),
        ]));
      assert(rH.rows[0].ad_spend_import.replaced === 1, `cz partial re-upload: expected replaced 1 (A's own prior row), got ${JSON.stringify(rH.rows[0].ad_spend_import)}`);
      assert((await czRow("a")) === 70, `cz/a after the partial re-upload: expected 70, got ${await czRow("a")}`);
      assert((await czRow("b")) === 40, `cz/b — a SIBLING ad the partial upload didn't mention — must be PRESERVED at 40, got ${await czRow("b")}`);

      // -- Codex recheck #1: a representation CHANGE (kind differs from what
      // is saved) is refused OUTRIGHT when the file also had rejected rows —
      // an incomplete file must never be trusted to replace a full
      // breakdown. Nothing changes. --
      const beforeCzCount = await q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily where campaign_key='cz'`);
      const uploadI = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      await expectPgError("kind change refused when the file had rejected rows", "22023", () =>
        q(`select public.ad_spend_import($1::uuid, $2::jsonb, $3::int)`, [
          uploadI,
          JSON.stringify([{ spend_date: "2026-06-06", platform: "meta", campaign_key: "cz", ad_key: "(campaign)", campaign_label: "CZ", spend_php: 999 }]),
          3,
        ]));
      const afterCzCount = await q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily where campaign_key='cz'`);
      assert(afterCzCount.rows[0].n === beforeCzCount.rows[0].n, `a refused breakdown-change upload must leave the group's row count unchanged, before=${beforeCzCount.rows[0].n} after=${afterCzCount.rows[0].n}`);
      assert((await czRow("a")) === 70 && (await czRow("b")) === 40, `cz group must be unchanged after the refused upload (a=${await czRow("a")}, b=${await czRow("b")})`);

      // -- Explicit zero is kept as a real value, not treated as missing
      // (P14); a same-key re-upload replaces the one prior row. --
      const uploadD = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rD = await expectOk("c2/a1 first upload", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadD,
          JSON.stringify([{ spend_date: "2026-06-01", platform: "meta", campaign_key: "c2", ad_key: "a1", campaign_label: "C2", spend_php: 5 }]),
        ]));
      assert(rD.rows[0].ad_spend_import.replaced === 0, `c2/a1 first upload: expected replaced 0, got ${JSON.stringify(rD.rows[0].ad_spend_import)}`);
      const uploadE = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      const rE = await expectOk("zero correction", () =>
        q<{ ad_spend_import: Json }>(`select public.ad_spend_import($1::uuid, $2::jsonb) as ad_spend_import`, [
          uploadE,
          JSON.stringify([{ spend_date: "2026-06-01", platform: "meta", campaign_key: "c2", ad_key: "a1", campaign_label: "C2", spend_php: 0, impressions: 0, clicks: 0 }]),
        ]));
      assert(rE.rows[0].ad_spend_import.replaced === 1, `zero correction: expected replaced 1 (the prior c2/a1 row), got ${JSON.stringify(rE.rows[0].ad_spend_import)}`);
      const c2a1 = await q<{ php: string }>(`select spend_php::text as php from public.ad_spend_daily where campaign_key='c2' and ad_key='a1'`);
      assert(Number(c2a1.rows[0].php) === 0, `c2/a1 after zero correction: expected 0, got ${c2a1.rows[0].php}`);

      // -- All-or-nothing: a bad row anywhere in the batch changes nothing. --
      const beforeCount = await q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily`);
      const uploadF = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      await expectPgError("negative spend all-or-nothing", "23514", () =>
        q(`select public.ad_spend_import($1::uuid, $2::jsonb)`, [
          uploadF,
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
      assert(delN.rows[0].ad_spend_delete === 3, `expected ad_spend_delete to remove 3 rows (c1/a1, c1/a2, c2/a1 — all on 2026-06-01), got ${delN.rows[0].ad_spend_delete}`);
      const delAudit = await q<{ n: string }>(`select count(*)::text as n from public.audit_log where action = 'ad_spend.deleted'`);
      assert(Number(delAudit.rows[0].n) >= 1, "expected an ad_spend.deleted audit row");

      await expectPgError("delete unknown platform", "22023", () => q(`select public.ad_spend_delete('tiktok','2026-06-01','2026-06-01')`));
    }));

    // 21b. Ad spend import: concurrent writes serialize (Codex recheck #3) ---
    // ad_spend_import takes pg_advisory_xact_lock(hashtext('ad_spend_import'))
    // right after its admin check, so two concurrent uploads (or an upload
    // racing a removal) can never both observe an empty/stale group and both
    // insert different representations for it. Proven with a SECOND, real
    // connection: this proof's own connection never commits mid-check, so
    // once its ad_spend_import call returns, the xact-scoped lock is still
    // held for the rest of the (open) transaction — a second session must be
    // refused the same lock.
    await check("Ad spend import: concurrent writes serialize", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });

      const uploadJ = (await q<{ id: string }>(`select gen_random_uuid() as id`)).rows[0].id;
      await expectOk("import (connection A)", () =>
        q(`select public.ad_spend_import($1::uuid, $2::jsonb)`, [
          uploadJ,
          JSON.stringify([{ spend_date: "2026-06-07", platform: "meta", campaign_key: "cc", ad_key: "(campaign)", campaign_label: "CC", spend_php: 10 }]),
        ]));

      const db2 = new Client({ connectionString: DB_URL });
      await db2.connect();
      try {
        const r = await db2.query<{ got: boolean }>(
          `select pg_try_advisory_xact_lock(hashtext('ad_spend_import')) as got`);
        assert(
          r.rows[0].got === false,
          `expected connection B to be REFUSED the ad_spend_import lock while connection A's transaction is still open, got ${JSON.stringify(r.rows[0])}`,
        );
      } finally {
        await db2.end();
      }
    }));

    // 22. Whole history, not the period --------------------------------------
    // (P3) A merged-away duplicate spelled differently from its survivor, with
    // UNLINKED sheet lines under the duplicate's name: one New person, not two.
    await check("Merged duplicate's own name key is the survivor's (P3)", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();
      const bId = await patient("Zzproofp3b", "Survivor", { createdAt: "2026-06-05T02:00:00Z" });
      const aId = await patient("Zzproofp3a", "Duplicate", { createdAt: "2026-06-05T02:00:00Z" });
      await markMerged(aId, bId);
      await sheetLine("2026-06-12", "zzproofp3a|duplicate", null, 0);
      const after = await summary();
      const d = delta(before, after);
      assert(d.new_confirmed === 0 && d.new_unconfirmed === 1,
        `P3: expected exactly ONE new person (the name identity; survivor suppressed), got confirmed ${d.new_confirmed} + unconfirmed ${d.new_unconfirmed}`);
      const ident = await identityRow(`patient:${bId}`);
      assert(ident?.basis === "suppressed", `P3: expected the survivor to be suppressed, got ${JSON.stringify(ident)}`);
    }));

    // (M2) patient_sources_referrers reads referrer_raw from the identity core.
    // Its output must equal the 0189 function (which re-derived the referrer
    // itself) on data covering every referrer path.
    await check("Referrers equal the 0189 rule (M2)", () => scoped(async () => {
      await setRole("postgres", null);
      const ok = await patient("Zzproofm2ok", "App", { createdAt: "2026-06-06T02:00:00Z" });
      await q(`update public.patients set referred_by_doctor = 'Dr. M2 App' where id = $1`, [ok]);
      await visit(ok, "2026-06-07");
      const x = await patient("Zzproofm2x", "Xa", {});
      const y = await patient("Zzproofm2y", "Ya", {});
      await markMerged(y, x);
      await visit(x, "2026-06-08");
      await customerRow("zzproofm2y|old", { patientId: y, referredBy: "Dr. M2 Early", sheetRow: 1 });
      await customerRow("zzproofm2y|new", { patientId: y, referredBy: "Dr. M2 Late", sheetRow: 9 });
      const blank = await patient("Zzproofm2b", "Blank", {});
      await visit(blank, "2026-06-09");
      await customerRow("zzproofm2b|c", { patientId: blank, referredBy: "   ", sheetRow: 1 });
      // unconfirmed names: exactly one Customers row / two rows / one LINKED row
      await sheetLine("2026-06-10", "zzproofm2one|n", null, 0);
      await customerRow("zzproofm2one|n", { referredBy: "Dr. M2 One" });
      await sheetLine("2026-06-10", "zzproofm2two|n", null, 0);
      await customerRow("zzproofm2two|n", { referredBy: "Dr. M2 Aaa", sheetRow: 1 });
      await customerRow("zzproofm2two|n", { referredBy: "Dr. M2 Bbb", sheetRow: 2 });
      const lk = await patient("Zzproofm2lk", "Linked", {});
      await sheetLine("2026-06-11", "zzproofm2link|n", null, 0);
      await customerRow("zzproofm2link|n", { patientId: lk, referredBy: "Dr. M2 Linked" });

      const oldSql = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0189_patient_sources.sql"), "utf8");
      const start = oldSql.indexOf("create or replace function public.patient_sources_referrers(");
      const end = oldSql.indexOf("\n$$;\n", start) + 5;
      assert(start > 0 && end > start, "could not extract the 0189 referrers function");
      await q(oldSql.slice(start, end).replace("public.patient_sources_referrers(", "public._ps_referrers_0189("));
      await q(`grant execute on function public._ps_referrers_0189(date, date, int) to authenticated`);

      const norm = (rows: { doctor_label: string; new_confirmed: number; new_unconfirmed: number }[]) =>
        rows.map((r) => `${r.doctor_label}|${r.new_confirmed}|${r.new_unconfirmed}`).sort();
      let compared = 0;
      for (const [from, to] of [[JUNE.from, JUNE.to], ["2026-01-01", "2026-06-30"], ["2025-07-01", "2026-06-30"]]) {
        await asAdmin();
        const oldR = await q<{ doctor_label: string; new_confirmed: number; new_unconfirmed: number }>(
          `select * from public._ps_referrers_0189($1, $2, 100)`, [from, to]);
        await setRole("postgres", null);
        const newR = await referrersRows(from, to, 100);
        assert(JSON.stringify(norm(oldR.rows)) === JSON.stringify(norm(newR)),
          `M2: referrers differ from the 0189 rule for ${from}..${to}: old=${JSON.stringify(norm(oldR.rows))} new=${JSON.stringify(norm(newR))}`);
        compared += newR.length;
      }
      assert(compared >= 6, `M2: the comparison must cover real rows, got ${compared}`);
      const june = norm(await referrersRows(JUNE.from, JUNE.to, 100));
      for (const want of ["Dr. M2 App|1|0", "Dr. M2 Late|1|0", "Dr. M2 One|0|1", "Dr. M2 Linked|0|1"]) {
        assert(june.includes(want), `M2: expected ${want} in ${JSON.stringify(june)}`);
      }
      assert(!june.some((r) => r.startsWith("Dr. M2 Aaa") || r.startsWith("Dr. M2 Bbb") || r.startsWith("Dr. M2 Early")), "M2: ambiguous / superseded referrers must not surface");
    }));

    // (M1) Both stream-(a) readers take the mirror window from ONE helper that
    // reads sheet_sync_settings (no second hard-coded 2026-05-26).
    await check("Mirror window is single-sourced (M1)", () => scoped(async () => {
      await setRole("postgres", null);
      await q(`update public.sheet_sync_settings set mirror_window_start = date '2026-06-20' where id`);
      const p = await patient("Zzproofm1", "Window", { imported: true });
      await visit(p, "2026-06-10", 400, { imported: true }); // imported, BEFORE the moved window -> counts
      const enc = await q(`select 1 from public._patient_sources_encounters() e where e.survivor_id = $1`, [p]);
      assert(enc.rows.length === 1, `M1: encounters must use the settings window (1 row), got ${enc.rows.length}`);
      const rev = await q<{ php: string }>(
        `select coalesce(sum(l.php),0)::text as php from public._ps_revenue_lines($1,$2) l where l.survivor_id = $3`,
        [JUNE.from, JUNE.to, p]);
      assert(Number(rev.rows[0].php) === 400, `M1: revenue lines must use the settings window (400), got ${rev.rows[0].php}`);
      const w = await q<{ w: string }>(`select public._ps_mirror_window_start()::text as w`);
      assert(w.rows[0].w === "2026-06-20", `M1: helper must return the settings value, got ${w.rows[0].w}`);
    }));

    // (P5) Direct RPC: a group mixing a campaign total with per-ad rows is refused, nothing written.
    await check("Ad spend: a mixed-breakdown group is refused (P5)", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const rows = [
        { spend_date: "2026-06-20", platform: "meta", campaign_key: "p5mix", ad_key: "(campaign)", campaign_label: "P5", spend_php: 1000 },
        { spend_date: "2026-06-20", platform: "meta", campaign_key: "p5mix", ad_key: "adA", campaign_label: "P5", spend_php: 600 },
        { spend_date: "2026-06-21", platform: "meta", campaign_key: "p5ok", ad_key: "adZ", campaign_label: "P5", spend_php: 5 },
      ];
      await expectPgError("mixed total + per-ad", "22023", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify(rows)]));
      await setRole("postgres", null);
      const left = await q(`select 1 from public.ad_spend_daily where campaign_key in ('p5mix','p5ok')`);
      assert(left.rows.length === 0, `P5: a refused import must write nothing, found ${left.rows.length} rows`);
    }));

    // (0203) The import writes leads / platform bookings / ad label with the existing semantics.
    await check("Ad spend (0203): import writes leads, bookings and ad label; blank stays NULL, 0 is kept; duplicates sum", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const D = "2026-06-10";
      const row = (ad: string, extra: Json) => ({ spend_date: D, platform: "meta", campaign_key: "l0203", ad_key: ad, campaign_label: "L0203", spend_php: 10, ...extra });
      await expectOk("import with leads/bookings", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([
          row("ada", { ad_label: "Ad A", leads: 5, platform_bookings: 2, impressions: 100, clicks: 4 }),
          row("ada", { ad_label: "Ad A", leads: 3, platform_bookings: 0, impressions: 50, clicks: 1 }),
          row("adb", { ad_label: "Ad B", leads: null, platform_bookings: 0 }),
          row("adc", {}),
        ])]));
      await setRole("postgres", null);
      const got = await q<{ ad_key: string; ad_label: string | null; leads: number | null; platform_bookings: number | null; spend_php: string; impressions: number | null }>(
        `select ad_key, ad_label, leads, platform_bookings, spend_php::text, impressions from public.ad_spend_daily where campaign_key = 'l0203' order by ad_key`);
      const by = Object.fromEntries(got.rows.map((r) => [r.ad_key, r]));
      assert(by.ada.leads === 8 && by.ada.platform_bookings === 2 && by.ada.ad_label === "Ad A" && Number(by.ada.spend_php) === 20 && by.ada.impressions === 150,
        `ada: expected leads 8 (5+3), bookings 2 (2+0), label 'Ad A', spend 20, impr 150; got ${JSON.stringify(by.ada)}`);
      assert(by.adb.leads === null, `adb: a blank leads must stay NULL (unknown), got ${by.adb.leads}`);
      assert(by.adb.platform_bookings === 0, `adb: an explicit 0 bookings must be kept as 0, got ${by.adb.platform_bookings}`);
      assert(by.adc.leads === null && by.adc.platform_bookings === null && by.adc.ad_label === null, `adc: absent fields must be NULL, got ${JSON.stringify(by.adc)}`);
    }));

    await check("Ad spend (0203): a same-kind partial upload updates only the ads it mentions and keeps siblings' leads/bookings/label", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const D = "2026-06-11";
      const row = (ad: string, extra: Json) => ({ spend_date: D, platform: "google", campaign_key: "p0203", ad_key: ad, campaign_label: "P0203", spend_php: 10, ...extra });
      await expectOk("seed two ads", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([
          row("ada", { ad_label: "Ad A", leads: 5, platform_bookings: 2 }),
          row("adb", { ad_label: "Ad B", leads: 7, platform_bookings: 3 }),
        ])]));
      const r = await expectOk("partial re-upload of ad A only", () =>
        q<{ r: Json }>(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb) as r`, [JSON.stringify([
          row("ada", { ad_label: "Ad A v2", leads: 9, platform_bookings: null, spend_php: 25 }),
        ])]));
      assert(r.rows[0].r.replaced === 1 && r.rows[0].r.inserted === 0, `expected {inserted:0,replaced:1}, got ${JSON.stringify(r.rows[0].r)}`);
      await setRole("postgres", null);
      const got = await q<{ ad_key: string; ad_label: string | null; leads: number | null; platform_bookings: number | null; spend_php: string }>(
        `select ad_key, ad_label, leads, platform_bookings, spend_php::text from public.ad_spend_daily where campaign_key = 'p0203' order by ad_key`);
      assert(got.rows.length === 2, `both ads must still exist, got ${got.rows.length}`);
      const [a, b] = got.rows;
      assert(a.leads === 9 && a.platform_bookings === null && a.ad_label === "Ad A v2" && Number(a.spend_php) === 25,
        `ad A must take the file's word (leads 9, bookings NULL, label 'Ad A v2', spend 25), got ${JSON.stringify(a)}`);
      assert(b.leads === 7 && b.platform_bookings === 3 && b.ad_label === "Ad B" && Number(b.spend_php) === 10,
        `sibling ad B must be untouched (leads 7, bookings 3, label 'Ad B', spend 10), got ${JSON.stringify(b)}`);
    }));

    // (0203) Column presence rule: a column ABSENT from the file (key missing from every row)
    // keeps the saved value; PRESENT-but-blank (key with null) sets NULL; 0 stays 0.
    const FIELDS = ["ad_label", "leads", "platform_bookings", "impressions", "clicks"] as const;
    type SavedAd = { ad_key: string; ad_label: string | null; leads: number | null; platform_bookings: number | null; impressions: number | null; clicks: number | null; spend_php: string };
    const readAds = async (campaign: string) => {
      await setRole("postgres", null);
      const got = await q<SavedAd>(
        `select ad_key, ad_label, leads, platform_bookings, impressions, clicks, spend_php::text from public.ad_spend_daily where campaign_key = $1 order by ad_key`, [campaign]);
      return Object.fromEntries(got.rows.map((r) => [r.ad_key, r])) as Record<string, SavedAd>;
    };
    const SEED = { ad_label: "Ad A", leads: 5, platform_bookings: 2, impressions: 100, clicks: 4 };

    await check("Ad spend (0203): a file WITHOUT leads/bookings/label/impressions/clicks columns keeps the saved values", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const row = (ad: string, extra: Json) => ({ spend_date: "2026-06-13", platform: "meta", campaign_key: "a0203", ad_key: ad, campaign_label: "A0203", spend_php: 10, ...extra });
      await expectOk("seed", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("ada", SEED), row("adb", { ...SEED, ad_label: "Ad B", leads: 7 })])]));
      // Re-upload of ad A carrying only spend (no optional key at all) - plus a brand-new ad C.
      const r = await expectOk("re-upload without the optional columns", () =>
        q<{ r: Json }>(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb) as r`, [JSON.stringify([row("ada", { spend_php: 25 }), row("adc", { spend_php: 3 })])]));
      assert(r.rows[0].r.replaced === 1 && r.rows[0].r.inserted === 1, `expected {inserted:1,replaced:1}, got ${JSON.stringify(r.rows[0].r)}`);
      const by = await readAds("a0203");
      assert(Number(by.ada.spend_php) === 25, `ad A spend must take the file's 25, got ${by.ada.spend_php}`);
      for (const k of FIELDS) assert(by.ada[k] === (SEED as Json)[k], `ad A ${k} must be KEPT (${(SEED as Json)[k]}), got ${by.ada[k]}`);
      assert(by.adb.leads === 7 && by.adb.ad_label === "Ad B", `sibling ad B untouched, got ${JSON.stringify(by.adb)}`);
      // A new row from such a file has nothing to keep: NULLs.
      assert(FIELDS.every((k) => by.adc[k] === null), `new ad C carries only what the file said (NULLs), got ${JSON.stringify(by.adc)}`);
      // Keys are per FIELD: a file with ONLY a leads column updates leads and keeps the other four.
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      await expectOk("re-upload with only leads", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("ada", { leads: 11 })])]));
      const by2 = await readAds("a0203");
      assert(by2.ada.leads === 11 && by2.ada.platform_bookings === 2 && by2.ada.ad_label === "Ad A" && by2.ada.impressions === 100 && by2.ada.clicks === 4,
        `only leads changes, got ${JSON.stringify(by2.ada)}`);
    }));

    await check("Ad spend (0203): a column present but blank sets NULL, and 0 stays 0", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const row = (ad: string, extra: Json) => ({ spend_date: "2026-06-14", platform: "google", campaign_key: "b0203", ad_key: ad, campaign_label: "B0203", spend_php: 10, ...extra });
      await expectOk("seed", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("ada", SEED), row("adb", { ...SEED, ad_label: "Ad B" })])]));
      // Ad A: every column present, every cell blank -> all NULL. Ad B: leads/bookings present as 0, the rest absent from the file.
      await expectOk("blank cells", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("ada", { ad_label: null, leads: null, platform_bookings: null, impressions: null, clicks: null })])]));
      const by = await readAds("b0203");
      assert(FIELDS.every((k) => by.ada[k] === null), `present-but-blank must set NULL, got ${JSON.stringify(by.ada)}`);
      assert(by.adb.leads === 5, `ad B was not in the file: untouched, got ${JSON.stringify(by.adb)}`);
      await asAdmin();
      await expectOk("zeros", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("adb", { leads: 0, platform_bookings: 0, impressions: 0 })])]));
      const by2 = await readAds("b0203");
      assert(by2.adb.leads === 0 && by2.adb.platform_bookings === 0 && by2.adb.impressions === 0, `0 must stay 0 (not NULL), got ${JSON.stringify(by2.adb)}`);
      assert(by2.adb.ad_label === "Ad B" && by2.adb.clicks === 4, `absent label/clicks kept next to the zeros, got ${JSON.stringify(by2.adb)}`);
      // The zeros survive a later file that has no such columns.
      await asAdmin();
      await expectOk("later file without them", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("adb", { spend_php: 30 })])]));
      const by3 = await readAds("b0203");
      assert(by3.adb.leads === 0 && by3.adb.platform_bookings === 0 && Number(by3.adb.spend_php) === 30, `0 kept across a later columnless file, got ${JSON.stringify(by3.adb)}`);
    }));

    await check("Ad spend (0203): the app deployed BEFORE 0203 (always sends impressions/clicks, never leads/bookings/label) behaves no worse", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const row = (extra: Json) => ({ spend_date: "2026-06-17", platform: "meta", campaign_key: "o0203", ad_key: "ada", campaign_label: "O0203", spend_php: 10, ...extra });
      await expectOk("seed", () => q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row(SEED)])]));
      // Old row shape: impressions/clicks keys present (null = its file had no such column), nothing else.
      await expectOk("old-app upload", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb, 0)`, [JSON.stringify([row({ spend_php: 25, impressions: null, clicks: null })])]));
      const by = await readAds("o0203");
      assert(Number(by.ada.spend_php) === 25, `spend follows the old upload, got ${by.ada.spend_php}`);
      assert(by.ada.impressions === null && by.ada.clicks === null, `impressions/clicks behave as before (overwritten by the present keys), got ${JSON.stringify(by.ada)}`);
      assert(by.ada.leads === 5 && by.ada.platform_bookings === 2 && by.ada.ad_label === "Ad A", `leads/bookings/label (which the old app cannot send) are kept, got ${JSON.stringify(by.ada)}`);
    }));

    // Controls for the two checks above: the 0203 import body is loaded under a temp name with the
    // rule broken, inside this rolled-back savepoint (like the 0199 controls). Each MUST lose data.
    const loadImport0203 = async (temp: string, rewrite: (field: string) => string) => {
      const src = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0203_ad_spend_leads_bookings.sql"), "utf8");
      const start = src.indexOf("create or replace function public.ad_spend_import(");
      const end = src.indexOf("\n$$;\n", start) + 5;
      assert(start > 0 && end > start, "could not extract the 0203 ad_spend_import");
      let body = src.slice(start, end).replace("public.ad_spend_import(", `public.${temp}(`);
      const flags: Record<string, string> = { impressions: "v_has_impressions", clicks: "v_has_clicks", ad_label: "v_has_ad_label", leads: "v_has_leads", platform_bookings: "v_has_bookings" };
      for (const [field, flag] of Object.entries(flags)) {
        const live = `case when ${flag} then excluded.${field} else a.${field} end`;
        assert(body.includes(live), `the live 0203 body must carry the keep-if-absent case for ${field}`);
        body = body.replace(live, rewrite(field));
      }
      await q(body);
      await q(`grant execute on function public.${temp}(uuid, jsonb, int) to authenticated`);
    };

    await check("0203 control: the old overwrite upsert LOSES leads/bookings/label/impressions/clicks on a columnless file", () => scoped(async () => {
      await setRole("postgres", null);
      await loadImport0203("_ad_spend_import_overwrite", (field) => `excluded.${field}`);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const row = (extra: Json) => ({ spend_date: "2026-06-15", platform: "meta", campaign_key: "c0203", ad_key: "ada", campaign_label: "C0203", spend_php: 10, ...extra });
      await expectOk("control seed (live body)", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row(SEED)])]));
      await expectOk("control re-upload (overwrite body)", () =>
        q(`select public._ad_spend_import_overwrite(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row({ spend_php: 25 })])]));
      const by = await readAds("c0203");
      assert(FIELDS.every((k) => by.ada[k] === null), `control: the overwrite body must have lost all five saved values, got ${JSON.stringify(by.ada)}`);
      // ...whereas the live body keeps them (same input).
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      await expectOk("control: reseed", () => q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row(SEED)])]));
      await expectOk("control: live re-upload", () => q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row({ spend_php: 25 })])]));
      const live = await readAds("c0203");
      assert(FIELDS.every((k) => live.ada[k] === (SEED as Json)[k]), `control: the live body keeps them, got ${JSON.stringify(live.ada)}`);
    }));

    await check("0203 control: a keep-always body (coalesce) would NOT clear a present-but-blank column", () => scoped(async () => {
      await setRole("postgres", null);
      await loadImport0203("_ad_spend_import_keepalways", (field) => `coalesce(excluded.${field}, a.${field})`);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const row = (extra: Json) => ({ spend_date: "2026-06-16", platform: "meta", campaign_key: "d0203", ad_key: "ada", campaign_label: "D0203", spend_php: 10, ...extra });
      await expectOk("control seed", () => q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row(SEED)])]));
      await expectOk("control blank re-upload (keep-always body)", () =>
        q(`select public._ad_spend_import_keepalways(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row({ ad_label: null, leads: null, platform_bookings: null, impressions: null, clicks: null })])]));
      const by = await readAds("d0203");
      assert(FIELDS.every((k) => by.ada[k] === (SEED as Json)[k]), `control: the keep-always body must have failed to clear the blanks, got ${JSON.stringify(by.ada)}`);
    }));

    await check("Ad spend (0203): a kind change without rejected rows replaces the group, with the new fields; with rejected rows it is refused", () => scoped(async () => {
      await setRole("postgres", null);
      await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
      const D = "2026-06-12";
      const row = (ad: string, extra: Json) => ({ spend_date: D, platform: "meta", campaign_key: "k0203", ad_key: ad, campaign_label: "K0203", spend_php: 10, ...extra });
      await expectOk("seed per-ad", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb)`, [JSON.stringify([row("ada", { ad_label: "Ad A", leads: 5 }), row("adb", { ad_label: "Ad B", leads: 7 })])]));
      await expectPgError("kind change with rejected rows", "22023", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb, 1)`, [JSON.stringify([row("(campaign)", { leads: 12, platform_bookings: 4 })])]));
      const kept = await q<{ n: string }>(`select count(*)::text as n from public.ad_spend_daily where campaign_key = 'k0203' and ad_key <> '(campaign)'`);
      assert(kept.rows[0].n === "2", `a refused import must leave both per-ad rows, got ${kept.rows[0].n}`);
      await expectOk("kind change, nothing rejected", () =>
        q(`select public.ad_spend_import(gen_random_uuid(), $1::jsonb, 0)`, [JSON.stringify([row("(campaign)", { leads: 12, platform_bookings: 4 })])]));
      const got = await q<{ ad_key: string; leads: number | null; platform_bookings: number | null; ad_label: string | null }>(
        `select ad_key, leads, platform_bookings, ad_label from public.ad_spend_daily where campaign_key = 'k0203'`);
      assert(got.rows.length === 1 && got.rows[0].ad_key === "(campaign)" && got.rows[0].leads === 12 && got.rows[0].platform_bookings === 4 && got.rows[0].ad_label === null,
        `the group must be replaced by the campaign total with its own numbers, got ${JSON.stringify(got.rows)}`);
    }));

    await check("Ad spend (0203): ad_spend_rows returns every field, in a TOTAL order that pages without gaps or repeats", () => scoped(async () => {
      await setRole("postgres", null);
      // Inserted in REVERSE of the wanted order and with ties on date/platform/campaign, so heap order != sorted order.
      const fixtures: [string, string, string, string][] = [
        ["2026-06-14", "meta", "r0203-b", "ad2"], ["2026-06-14", "meta", "r0203-b", "ad1"],
        ["2026-06-14", "meta", "r0203-a", "ad2"], ["2026-06-14", "meta", "r0203-a", "ad1"],
        ["2026-06-14", "google", "r0203-z", "ad1"], ["2026-06-13", "meta", "r0203-b", "ad1"],
      ];
      for (const [d, p, c, ad] of fixtures) {
        await q(
          `insert into public.ad_spend_daily (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php, ad_label, leads, platform_bookings, upload_id)
           values ($1, $2, $3, $4, $5, 5, $6, 1, 0, gen_random_uuid())`, [d, p, c, ad, c.toUpperCase(), `Label ${ad}`]);
      }
      await asAdmin();
      const cols = "spend_date::text as d, platform, campaign_key, ad_key";
      const full = await q<{ d: string; platform: string; campaign_key: string; ad_key: string }>(
        `select ${cols} from public.ad_spend_rows('2026-06-13'::date,'2026-06-14'::date) where campaign_key like 'r0203-%'`);
      const expected = await q<{ d: string; platform: string; campaign_key: string; ad_key: string }>(
        `select ${cols} from public.ad_spend_daily where campaign_key like 'r0203-%' order by spend_date, platform, campaign_key, ad_key`);
      const k = (r: { d: string; platform: string; campaign_key: string; ad_key: string }) => [r.d, r.platform, r.campaign_key, r.ad_key].join("|");
      assert(full.rows.length === 6, `expected 6 fixture rows, got ${full.rows.length}`);
      assert(full.rows.map(k).join(",") === expected.rows.map(k).join(","), `order must be (date, platform, campaign_key, ad_key); got ${full.rows.map(k).join(", ")}`);
      // PostgREST pages with limit/offset over the function's result: two-row pages must tile the whole set.
      const paged: string[] = [];
      for (let off = 0; off < 6; off += 2) {
        const page = await q<{ d: string; platform: string; campaign_key: string; ad_key: string }>(
          `select ${cols} from public.ad_spend_rows('2026-06-13'::date,'2026-06-14'::date) where campaign_key like 'r0203-%' limit 2 offset $1`, [off]);
        paged.push(...page.rows.map(k));
      }
      assert(paged.join(",") === full.rows.map(k).join(","), `paging must not drop or repeat rows; paged ${paged.join(", ")}`);
      const one = await q<{ ad_label: string | null; leads: number | null; platform_bookings: number | null; spend_php: string; campaign_label: string }>(
        `select ad_label, leads, platform_bookings, spend_php::text, campaign_label from public.ad_spend_rows('2026-06-14'::date,'2026-06-14'::date) where campaign_key = 'r0203-z'`);
      assert(one.rows[0].ad_label === "Label ad1" && one.rows[0].leads === 1 && one.rows[0].platform_bookings === 0 && Number(one.rows[0].spend_php) === 5 && one.rows[0].campaign_label === "R0203-Z",
        `ad_spend_rows must return the stored fields, got ${JSON.stringify(one.rows[0])}`);
    }));

    await check("Ad spend (0203): ad_spend_rows period rules (400-day cap, start <= end, no Patient Sources 2023-12 floor) and admin-only reads", () => scoped(async () => {
      await asAdmin();
      await expectPgError("start after end", "22023", () => q(`select * from public.ad_spend_rows('2026-06-30'::date,'2026-06-01'::date)`));
      await expectPgError("null start", "22023", () => q(`select * from public.ad_spend_rows(null::date,'2026-06-01'::date)`));
      await expectPgError("401 days", "22023", () => q(`select * from public.ad_spend_rows('2025-01-01'::date,'2026-02-06'::date)`));
      await expectOk("exactly 400 days", () => q(`select * from public.ad_spend_rows('2025-01-01'::date,'2026-02-05'::date)`));
      await expectOk("before 2023-12-01 is fine for ad data", () => q(`select * from public.ad_spend_rows('2023-01-01'::date,'2023-06-01'::date)`));
      // Reception sees no rows through the table either (RLS) and is refused by the function.
      await setRole("authenticated", { sub: fx.receptionId, role: "authenticated" });
      await expectPgError("reception", "42501", () => q(`select * from public.ad_spend_rows('2026-06-01'::date,'2026-06-30'::date)`));
      await setRole("anon", null);
      await expectPgError("anon", "42501", () => q(`select * from public.ad_spend_rows('2026-06-01'::date,'2026-06-30'::date)`));
    }));

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

    // 24. P5: an old visitor with a later registration date is not New ------
    // Owner decision 2026-09-28: a confirmed customer with ANY live visit
    // before 2023-12-01 is an OLD customer — counted nowhere (basis
    // 'before_window', first_date null) — even when they also have a later
    // registration date (sheet registered_on or app created_at). The
    // `confirmed` CTE's CASE order is now encounter -> suppressed ->
    // before_window -> registration -> undated, so before_window outranks a
    // registration date. An encounter since December 2023 still wins over
    // everything (unchanged); name identities are unaffected.
    await check("P5: an old visitor with a later registration date is not New — owner decision 2026-09-28", () => scoped(async () => {
      await setRole("postgres", null);
      const before = await summary();

      const xId = await patient("Zzproofp5", "OldVisitReg");
      await visit(xId, "2022-01-15"); // before 2023-12-01: an old visit
      await facts(xId, "2026-06-15", "new"); // a later registration date must NOT override it

      const idX = await identityRow(`patient:${xId}`);
      assert(idX?.basis === "before_window", `expected basis 'before_window' (not 'registration'), got ${JSON.stringify(idX)}`);
      assert(idX?.first_date === null, `expected first_date null (counted nowhere), got ${idX?.first_date}`);

      const after = await summary();
      const d = delta(before, after);
      assert(allZero(d), `expected an all-zero delta (never New, never undated — an old customer), got ${JSON.stringify(d)}`);
    }));

    // 25. 0199: the service key reads summary + series ----------------------
    // The CLI first-night check and the Phase 5 weekly cron call these with the
    // service key and no signed-in user (has_role() is false). The gate is
    // `has_role(admin) or auth.role() = 'service_role'`; the numbers must be
    // the SAME ones an admin sees, and everyone else must still be refused.
    await check("0199: service_role reads summary + series with the admin's numbers", () => scoped(async () => {
      await setRole("postgres", null);
      // Real rows so equal numbers are not equal zeros.
      const a = await patient("Zzproof0199a", "App", { createdAt: "2026-06-05T02:00:00Z" });
      await visit(a, "2026-06-06", 300);
      const b = await patient("Zzproof0199b", "Second", { createdAt: "2026-06-12T02:00:00Z" });
      await visit(b, "2026-06-13");
      await sheetLine("2026-06-14", "zzproof0199sheet|n", null, 0);

      const SUMMARY = `select ${COUNT_FIELDS.join(", ")}, sheet_last_dates::text as sheet_last_dates, sync_paused, sheet_rows_present, last_run_status from public.patient_sources_summary($1, $2)`;
      const SERIES: [string, string][] = [["day", "new"], ["week", "served"], ["month", "new"], ["period", "served"]];
      const SERIES_SQL = "select bucket_start::text as bucket_start, channel, confirmed, unconfirmed from public.patient_sources_series($1, $2, $3, $4)";

      const readAll = async () => {
        const s = await q(SUMMARY, [JUNE.from, JUNE.to]);
        const series: unknown[] = [];
        for (const [grain, mode] of SERIES) {
          series.push((await q(SERIES_SQL, [JUNE.from, JUNE.to, grain, mode])).rows);
        }
        return { summary: s.rows, series };
      };

      await asAdmin();
      const adminRead = await readAll();
      await setRole("postgres", null);
      const sm = adminRead.summary[0] as Record<string, number | string>;
      const total = Number(sm.new_confirmed) + Number(sm.new_unconfirmed) + Number(sm.served_confirmed) + Number(sm.served_unconfirmed);
      assert(total >= 3, `0199: the admin read must carry real numbers, got ${JSON.stringify(adminRead.summary)}`);
      assert(adminRead.series.every((rows) => (rows as unknown[]).length > 0), "0199: every admin series read must return rows");

      // service_role exactly as PostgREST sets it up: role claim only, no sub.
      await setRole("service_role", { role: "service_role" });
      const svcRead = await expectOk("0199 service_role read", readAll);
      await setRole("postgres", null);
      assert(JSON.stringify(svcRead) === JSON.stringify(adminRead),
        `0199: service_role numbers differ from the admin's: svc=${JSON.stringify(svcRead)} admin=${JSON.stringify(adminRead)}`);

      // Everyone else is still refused.
      const SVC_FUNCS = [
        `select public.patient_sources_summary('2026-06-01'::date,'2026-06-30'::date)`,
        `select public.patient_sources_series('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text)`,
      ];
      for (const sql of SVC_FUNCS) {
        await setRole("authenticated", { sub: fx.receptionId, role: "authenticated" });
        await expectPgError("0199 authenticated non-admin refused", "42501", () => q(sql));
        await setRole("authenticated", { sub: fx.inactiveAdminId, role: "authenticated" });
        await expectPgError("0199 inactive admin refused", "42501", () => q(sql));
        await setRole("anon", null);
        await expectPgError("0199 anon refused", "42501", () => q(sql));
        await setRole("anon", { role: "anon", patient_id: fx.patientPId });
        await expectPgError("0199 portal patient refused", "42501", () => q(sql));
        // An authenticated session cannot claim the service role through other claims.
        await setRole("authenticated", { sub: fx.receptionId, role: "authenticated", app_metadata: { role: "service_role" } });
        await expectPgError("0199 authenticated with a service_role app_metadata refused", "42501", () => q(sql));
        // Admin viewing as reception is still refused (0182).
        await setRole("postgres", null);
        await q(`update public.staff_profiles set view_as_role = 'reception', view_as_until = now() + interval '1 hour' where id = $1`, [fx.adminId]);
        try {
          await setRole("authenticated", { sub: fx.adminId, role: "authenticated" });
          await expectPgError("0199 admin viewing as reception refused", "42501", () => q(sql));
        } finally {
          await setRole("postgres", null);
          await q(`update public.staff_profiles set view_as_role = null, view_as_until = null where id = $1`, [fx.adminId]);
        }
      }

      // No role claim and no sub at all (empty, '{}' or a claim without "role"): auth.role() is
      // NULL. The gate must be coalesced so NULL means "refuse", not "skip the raise".
      for (const sql of SVC_FUNCS) {
        for (const claims of [null, {}, { iss: "supabase" }] as Claims[]) {
          await setRole("authenticated", claims);
          await expectPgError(`0199 authenticated with no role claim (${JSON.stringify(claims)}) refused`, "42501", () => q(sql));
        }
      }
      await setRole("postgres", null);

      // Grants and bodies, as the migration's own post-condition states them.
      for (const fn of ["public.patient_sources_summary(date,date)", "public.patient_sources_series(date,date,text,text)"]) {
        const g = await q<{ anon: boolean; auth: boolean; svc: boolean; gate: boolean }>(
          `select has_function_privilege('anon', $1, 'execute') as anon,
                  has_function_privilege('authenticated', $1, 'execute') as auth,
                  has_function_privilege('service_role', $1, 'execute') as svc,
                  pg_get_functiondef($1::regprocedure) like '%coalesce((select auth.role()), '''') = ''service_role''%' as gate`, [fn]);
        assert(!g.rows[0].anon && g.rows[0].auth && g.rows[0].svc && g.rows[0].gate, `0199: bad ACL/body for ${fn}: ${JSON.stringify(g.rows[0])}`);
      }
    }));

    // Control (0199): prove the service_role case above can fail. The 0189
    // bodies (gate = has_role only) are loaded under temp names inside this
    // rolled-back savepoint, exactly like the M2 check does; with that gate
    // the service key is refused (42501), while the live 0199 function answers.
    await check("0199 control: with the 0189 gate the service_role case FAILS", () => scoped(async () => {
      await setRole("postgres", null);
      const oldSql = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0189_patient_sources.sql"), "utf8");
      const load = (name: string, temp: string, argsSig: string) => {
        const start = oldSql.indexOf(`create or replace function public.${name}(`);
        const end = oldSql.indexOf("\n$$;\n", start) + 5;
        assert(start > 0 && end > start, `could not extract the 0189 ${name}`);
        const body = oldSql.slice(start, end).replace(`public.${name}(`, `public.${temp}(`);
        assert(!body.includes("service_role"), "the 0189 body must not carry the service_role branch");
        return { body, grant: `grant execute on function public.${temp}(${argsSig}) to service_role, authenticated` };
      };
      const s = load("patient_sources_summary", "_ps_summary_0189", "date, date");
      const r = load("patient_sources_series", "_ps_series_0189", "date, date, text, text");
      for (const x of [s, r]) { await q(x.body); await q(x.grant); }

      await setRole("service_role", { role: "service_role" });
      await expectPgError("control: 0189 summary refuses the service key", "42501", () =>
        q(`select public._ps_summary_0189('2026-06-01'::date,'2026-06-30'::date)`));
      await expectPgError("control: 0189 series refuses the service key", "42501", () =>
        q(`select public._ps_series_0189('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text)`));
      // ...and the live functions answer the same call.
      await expectOk("control: live summary answers the service key", () =>
        q(`select public.patient_sources_summary('2026-06-01'::date,'2026-06-30'::date)`));
      await expectOk("control: live series answers the service key", () =>
        q(`select public.patient_sources_series('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text)`));
      // The 0189 copy still answers an admin, so the refusal above is the gate and not a broken copy.
      await asAdmin();
      await expectOk("control: 0189 summary still answers an admin", () =>
        q(`select public._ps_summary_0189('2026-06-01'::date,'2026-06-30'::date)`));
    }));

    // Control (0199 coalesce): prove the no-claims refusal above can fail. The live
    // 0199 bodies are loaded under temp names with the coalesce removed (the
    // gate as first drafted); a session with no role claim then sails through.
    await check("0199 control: without the coalesce a no-claims session gets through", () => scoped(async () => {
      await setRole("postgres", null);
      const src = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0199_patient_sources_service_read.sql"), "utf8");
      const GATE = "coalesce((select auth.role()), '') = 'service_role'";
      const load = (name: string, temp: string, argsSig: string) => {
        const start = src.indexOf(`create or replace function public.${name}(`);
        const end = src.indexOf("\n$$;\n", start) + 5;
        assert(start > 0 && end > start, `could not extract the 0199 ${name}`);
        const live = src.slice(start, end).replace(`public.${name}(`, `public.${temp}(`);
        assert(live.includes(GATE), "the live 0199 body must carry the coalesced gate");
        const body = live.replace(GATE, "(select auth.role()) = 'service_role'");
        assert(body !== live && !body.includes("coalesce((select auth.role())"), "the uncoalesced copy must differ from the live body");
        return { body, grant: `grant execute on function public.${temp}(${argsSig}) to service_role, authenticated` };
      };
      const s = load("patient_sources_summary", "_ps_summary_nocoalesce", "date, date");
      const r = load("patient_sources_series", "_ps_series_nocoalesce", "date, date, text, text");
      for (const x of [s, r]) { await q(x.body); await q(x.grant); }

      // Session with no role claim and no sub: the uncoalesced gate lets it through...
      await setRole("authenticated", null);
      await expectOk("control: uncoalesced summary lets a no-claims session through", () =>
        q(`select public._ps_summary_nocoalesce('2026-06-01'::date,'2026-06-30'::date)`));
      await expectOk("control: uncoalesced series lets a no-claims session through", () =>
        q(`select public._ps_series_nocoalesce('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text)`));
      // ...and the live functions refuse the very same session.
      await expectPgError("control: live summary refuses the no-claims session", "42501", () =>
        q(`select public.patient_sources_summary('2026-06-01'::date,'2026-06-30'::date)`));
      await expectPgError("control: live series refuses the no-claims session", "42501", () =>
        q(`select public.patient_sources_series('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text)`));
    }));
    // ---- 0206: one call per page view ---------------------------------
    await check("0206: seeded world makes every section non-empty", () => scoped(async () => {
      const w = await seedWorld();
      await asAdmin();
      for (const p of PERIODS) {
        for (const c of gridCalls("public", p)) {
          if (!mustBeNonEmpty(c.label, p)) continue;
          const n = Number((await q<{ n: string }>(`select count(*)::text as n from (${c.sql}) t`, c.params)).rows[0].n);
          assert(n > 0, `${c.label} ${p.from}..${p.to} is empty — the equivalence below would be vacuous`);
        }
      }
      // Pinned: each seeded case really landed (summary always returns a row, so count(*) proves nothing).
      const sm = await summary(P_JUNE.from, P_JUNE.to);
      assert(sm.new_unconfirmed > 0, `new_unconfirmed must be > 0: ${JSON.stringify(sm)}`);
      assert(sm.returning_first_recorded > 0, `returning_first_recorded must be > 0: ${JSON.stringify(sm)}`);
      assert(sm.undated_registrations > 0, `undated_registrations must be > 0: ${JSON.stringify(sm)}`);
      assert(sm.source_total > sm.source_recorded, `source_total must exceed source_recorded: ${JSON.stringify(sm)}`);
      await setRole("postgres", null);
      const ids = (await q<{ identity: string }>(`select identity from public._patient_sources_identities()`)).rows.map((r) => r.identity);
      assert(!ids.includes(`patient:${w.del}`), "the deleted patient must not be an identity");
      assert(!ids.includes(`patient:${w.dup}`), "the merged duplicate must not be an identity");
      assert(ids.includes(`patient:${w.surv}`), "the merge survivor must be an identity");
      const oldRow = await identityRow(`patient:${w.old}`);
      assert(oldRow?.basis === "before_window", `pre-window visitor basis: ${JSON.stringify(oldRow)}`);
      const regRow = await identityRow(`patient:${w.regOnly}`);
      assert(regRow?.basis === "registration", `registration-only basis: ${JSON.stringify(regRow)}`);
    }));

    await check("0206: every wrapper returns exactly the pre-0206 rows", () => scoped(async () => {
      await q(fs.readFileSync(path.join(__dirname, "fixtures/patient-sources-pre-0206.sql"), "utf8"));
      await seedWorld();
      await asAdmin();
      const diffs: string[] = [];
      for (const p of PERIODS) {
        const now = gridCalls("public", p);
        const old = gridCalls("ps_old", p);
        for (let i = 0; i < now.length; i++) {
          const a = await rowsJson(now[i].sql, now[i].params);
          const b = await rowsJson(old[i].sql, old[i].params);
          if (mustBeNonEmpty(now[i].label, p)) assert(JSON.parse(b).length > 0, `${now[i].label} ${p.from}..${p.to} is empty on both sides — vacuous`);
          if (a !== b) diffs.push(`${now[i].label} ${p.from}..${p.to}: new=${a.slice(0, 300)} old=${b.slice(0, 300)}`);
        }
      }
      assert(diffs.length === 0, `wrappers differ from the pre-0206 bodies:\n${diffs.join("\n")}`);
    }));

    await check("0206: report sections equal the single RPCs (with and without a previous period)", () => scoped(async () => {
      await seedWorld();
      await asAdmin();
      const cases = [
        { p: P_JUNE, grain: "day", mode: "new", prev: { from: "2026-05-02", to: "2026-05-31" } },
        { p: P_JUNE, grain: "week", mode: "served", prev: null },
        { p: P_LONG, grain: "month", mode: "served", prev: { from: "2024-07-23", to: "2025-08-26" } },
        { p: P_EARLY, grain: "day", mode: "served", prev: null },
      ];
      for (const c of cases) {
        const tag = `${c.p.from}..${c.p.to} ${c.grain}/${c.mode} prev=${c.prev ? "set" : "null"}`;
        const rep = (await q<{ r: Record<string, unknown> }>(
          `select public.patient_sources_report($1, $2, $3, $4, $5, $6) as r`,
          [c.p.from, c.p.to, c.grain, c.mode, c.prev?.from ?? null, c.prev?.to ?? null])).rows[0].r;
        assert(rep && typeof rep === "object", `${tag}: report returned ${JSON.stringify(rep)}`);
        const keys = Object.keys(rep).sort().join(",");
        assert(keys === "current,new_by_day,overlaps,previous,referrers,revenue,series,summary", `${tag}: sections are ${keys}`);
        const same = async (label: string, section: unknown, sql: string, params: unknown[]) => {
          const a = await sortedJson(section);
          const b = await rowsJson(sql, params);
          const needs = label !== "overlaps" || c.p !== P_EARLY;
          if (needs && label !== "summary") assert(JSON.parse(b).length > 0, `${tag} ${label} is empty — vacuous`);
          assert(a === b, `${tag} ${label}: report=${a.slice(0, 300)} rpc=${b.slice(0, 300)}`);
        };
        await same("summary", [rep.summary], `select * from public.patient_sources_summary($1,$2)`, [c.p.from, c.p.to]);
        await same("series", rep.series, `select * from public.patient_sources_series($1,$2,$3,$4)`, [c.p.from, c.p.to, c.grain, c.mode]);
        await same("current", rep.current, `select * from public.patient_sources_series($1,$2,'period',$3)`, [c.p.from, c.p.to, c.mode]);
        await same("new_by_day", rep.new_by_day, `select * from public.patient_sources_series($1,$2,'day','new')`, [c.p.from, c.p.to]);
        await same("revenue", rep.revenue, `select * from public.patient_sources_revenue($1,$2)`, [c.p.from, c.p.to]);
        await same("overlaps", rep.overlaps, `select * from public.patient_sources_overlaps($1,$2)`, [c.p.from, c.p.to]);
        await same("referrers", rep.referrers, `select * from public.patient_sources_referrers($1,$2,20)`, [c.p.from, c.p.to]);
        if (c.prev) {
          assert(Array.isArray(rep.previous) && (rep.previous as unknown[]).length > 0, `${tag}: previous is empty — vacuous`);
          await same("previous", rep.previous, `select * from public.patient_sources_series($1,$2,'period',$3)`, [c.prev.from, c.prev.to, c.mode]);
        } else {
          assert(rep.previous === null, `${tag}: previous must be null without a previous period, got ${JSON.stringify(rep.previous)}`);
        }
        // Order is part of the contract (the page renders arrays as given).
        const series = rep.series as { bucket_start: string; channel: string }[];
        const sorted = [...series].sort((x, y) => (x.bucket_start + x.channel < y.bucket_start + y.channel ? -1 : 1));
        assert(JSON.stringify(series) === JSON.stringify(sorted), `${tag}: series is not ordered by bucket_start, channel`);
        const revs = (rep.revenue as { channel: string }[]).map((r) => r.channel);
        assert(JSON.stringify(revs) === JSON.stringify([...revs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))), `${tag}: revenue not ordered by channel: ${JSON.stringify(revs)}`);
        const ovs = (rep.overlaps as { service_date: string; drm_id: string }[]).map((r) => r.service_date + "|" + r.drm_id);
        assert(JSON.stringify(ovs) === JSON.stringify([...ovs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))), `${tag}: overlaps not ordered by (service_date, drm_id): ${JSON.stringify(ovs)}`);
        const refs = (rep.referrers as { doctor_label: string }[]).map((r) => r.doctor_label);
        const rpcRefs = (await q<{ doctor_label: string }>(`select doctor_label from public.patient_sources_referrers($1,$2,20)`, [c.p.from, c.p.to])).rows.map((r) => r.doctor_label);
        assert(JSON.stringify(refs) === JSON.stringify(rpcRefs), `${tag}: referrers order ${JSON.stringify(refs)} vs ${JSON.stringify(rpcRefs)}`);
      }
    }));

    await check("0206: report gate matrix", () => scoped(async () => {
      const sql = `select public.patient_sources_report('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text,null::date,null::date)`;
      await setRole("anon", null);
      await expectPgError("anon", "42501", () => q(sql));
      await setRole("authenticated", { sub: fx.receptionId, role: "authenticated" });
      await expectPgError("reception", "42501", () => q(sql));
      await setRole("authenticated", { sub: fx.inactiveAdminId, role: "authenticated" });
      await expectPgError("inactive admin", "42501", () => q(sql));
      await setRole("authenticated", null);
      await expectPgError("no JWT claims at all", "42501", () => q(sql));
      await setRole("authenticated", { sub: fx.receptionId, role: "authenticated", app_metadata: { role: "service_role" } });
      await expectPgError("authenticated with a service_role app_metadata", "42501", () => q(sql));
      await setRole("postgres", null);
      await q(`update public.staff_profiles set view_as_role = 'reception', view_as_until = now() + interval '1 hour' where id = $1`, [fx.adminId]);
      try {
        await asAdmin();
        await expectPgError("admin viewing as reception", "42501", () => q(sql));
      } finally {
        await setRole("postgres", null);
        await q(`update public.staff_profiles set view_as_role = null, view_as_until = null where id = $1`, [fx.adminId]);
      }
      await asAdmin();
      await expectOk("admin", () => q(sql));
      await setRole("service_role", { role: "service_role" });
      const svc = await expectOk("service_role", () => q<{ r: unknown }>(sql + " as r"));
      await asAdmin();
      const adm = await q<{ r: unknown }>(sql + " as r");
      assert(JSON.stringify(svc.rows[0].r) === JSON.stringify(adm.rows[0].r), "service_role and admin must read the same report");
    }));

    await check("0206: report refuses bad input with today's codes", () => scoped(async () => {
      await asAdmin();
      const call = (a: unknown[]) => q(`select public.patient_sources_report($1::date,$2::date,$3::text,$4::text,$5::date,$6::date)`, a);
      await expectPgError("bad grain", "22023", () => call(["2026-06-01", "2026-06-30", "year", "new", null, null]));
      await expectPgError("null grain", "22023", () => call(["2026-06-01", "2026-06-30", null, "new", null, null]));
      await expectPgError("bad mode", "22023", () => call(["2026-06-01", "2026-06-30", "day", "converted", null, null]));
      await expectPgError("period over 400 days", "22023", () => call(["2025-01-01", "2026-06-30", "day", "new", null, null]));
      await expectPgError("start before 2023-12-01", "22023", () => call(["2023-11-30", "2023-12-31", "day", "new", null, null]));
      await expectPgError("reversed period", "22023", () => call(["2026-06-30", "2026-06-01", "day", "new", null, null]));
      await expectPgError("half a previous period (from only)", "22023", () => call(["2026-06-01", "2026-06-30", "day", "new", "2026-05-01", null]));
      await expectPgError("half a previous period (to only)", "22023", () => call(["2026-06-01", "2026-06-30", "day", "new", null, "2026-05-31"]));
      await expectPgError("previous period before 2023-12-01", "22023", () => call(["2023-12-01", "2023-12-31", "day", "new", "2023-11-01", "2023-11-30"]));
    }));

    await check("0206: helpers and list builders are closed; row types match their producers", () => scoped(async () => {
      const closed = [
        "public._ps_identity_list()", "public._ps_encounter_list()", "public._ps_revenue_line_list(date,date)",
        "public._ps_sec_summary(public._ps_identity[],public._ps_encounter[],date,date)",
        "public._ps_sec_series(public._ps_identity[],public._ps_encounter[],date,date,text,text)",
        "public._ps_sec_revenue(public._ps_identity[],public._ps_revenue_line[])",
        "public._ps_sec_overlaps(public._ps_revenue_line[])",
        "public._ps_sec_referrers(public._ps_identity[],date,date,integer)",
      ];
      for (const fn of closed) {
        const r = await q<{ a: boolean; u: boolean; s: boolean; sd: boolean }>(
          `select has_function_privilege('anon', $1, 'execute') as a,
                  has_function_privilege('authenticated', $1, 'execute') as u,
                  has_function_privilege('service_role', $1, 'execute') as s,
                  (select p.prosecdef from pg_proc p where p.oid = $1::regprocedure) as sd`, [fn]);
        const x = r.rows[0];
        assert(!x.a && !x.u && !x.s, `${fn} must be closed to anon/authenticated/service_role, got ${JSON.stringify(x)}`);
        assert(!x.sd, `${fn} must not be SECURITY DEFINER`);
      }
      const pairs: [string, string][] = [
        ["public._ps_identity", "public._patient_sources_identities()"],
        ["public._ps_encounter", "public._patient_sources_encounters()"],
        ["public._ps_revenue_line", "public._ps_revenue_lines(date,date)"],
      ];
      for (const [typ, fn] of pairs) {
        const r = await q<{ t: string; f: string }>(
          `select 'TABLE(' || (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
                                 from pg_attribute a where a.attrelid = (select typrelid from pg_type where oid = $1::regtype)
                                   and a.attnum > 0 and not a.attisdropped) || ')' as t,
                  pg_get_function_result($2::regprocedure) as f`, [typ, fn]);
        assert(r.rows[0].t === r.rows[0].f, `${typ} ${r.rows[0].t} does not match ${fn} ${r.rows[0].f}`);
      }
      const rep = await q<{ a: boolean; u: boolean; s: boolean; sd: boolean; gate: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as a,
                has_function_privilege('authenticated', $1, 'execute') as u,
                has_function_privilege('service_role', $1, 'execute') as s,
                (select p.prosecdef from pg_proc p where p.oid = $1::regprocedure) as sd,
                pg_get_functiondef($1::regprocedure) like '%coalesce((select auth.role()), '''') = ''service_role''%' as gate`,
        ["public.patient_sources_report(date,date,text,text,date,date)"]);
      const x = rep.rows[0];
      assert(!x.a && x.u && x.s && x.sd && x.gate, `patient_sources_report ACL/definer/gate wrong: ${JSON.stringify(x)}`);
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
