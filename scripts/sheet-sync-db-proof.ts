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
// Each check below is its own named `check()` block, wrapped in a
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
// LEASE INDEPENDENCE: checks 4 onward each acquire and finish their own
// lease(s) rather than passing a lease token between checks. That costs a few
// extra RPC round trips but means a failure in one check's lease dance can
// never leave a stray "running" row that makes an unrelated later check fail
// for the wrong reason. (sheet_review_resolve refuses with P0062 while a real
// run holds a live lease, so every resolve below happens with no lease open.)
//
// TIMING: the last check stages + commits a synthetic 5,000-row Customers
// snapshot, applies a 500-op create chunk and undoes it, printing each RPC's
// wall time. PASS means every single call stayed under 8,000 ms — PostgREST's
// authenticator statement_timeout is 8 s. It runs inside this script's one big
// transaction, so it is a pessimistic figure for the real (fresh) calls.
//
// CONTROL TEST (prove the proof can fail)
// ---------------------------------------
// A green run means nothing unless the same checks go red when the behaviour
// they name is removed. After an all-PASS run on a fresh `supabase db reset`,
// apply these mutations to the LOCAL stack only, re-run, and expect exactly
// the FAILs listed. `mutate` re-creates ONE function from the migration file
// with one piece of text swapped (run it from the worktree root; it refuses
// when the text is not there, so a later edit cannot turn a mutation into a
// silent no-op). Two mutations of the same function overwrite each other, so
// they run in separate rounds (A–D) with a reset between them.
//
//   PSQL=/opt/homebrew/opt/libpq/bin/psql
//   DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   mutate() { node -e '
//     const [fn, from, to] = process.argv.slice(1);
//     const sql = require("fs").readFileSync("supabase/migrations/0170_sheet_sync_foundation.sql", "utf8");
//     const start = sql.indexOf("create or replace function public." + fn + "(");
//     const body = sql.slice(start, sql.indexOf("end $$;", start) + 7);
//     if (start < 0 || !body.includes(from)) throw new Error("mutation target not found: " + from);
//     process.stdout.write(body.split(from).join(to));' "$@" | $PSQL $DB -v ON_ERROR_STOP=1 -q; }
//
//   ## Round A ##
//   # M1 — open an RPC to logged-in users. Expect: FAIL RPC ACL
//   # (… sheet_sync_apply_customer_ops as authenticated: expected code 42501, got P0063).
//   $PSQL $DB -c "grant execute on function public.sheet_sync_apply_customer_ops(uuid, jsonb) to authenticated"
//   # M2 — drop the preview-lease write fence. Expect: FAIL Dry-run lease
//   # cannot write (… expected error 22023, but the call succeeded).
//   mutate _sheet_sync_fence "if coalesce(p_write, true) and v_dry then" "if false then"
//   # M4 — link / create overwrite a hold. Expect: FAIL Link and create never
//   # overwrite a hold (… link over a hold: expected skipped …).
//   mutate sheet_sync_apply_customer_ops "and public.sheet_patient_links.decision <> 'review'" "and true"
//   # M5 — an undo holds only its own run's links. Expect: FAIL Undo holds
//   # the auto links of a restored patient (… expected restored=1 held=1 …)
//   # and FAIL Timing: 8,000 fills … (… held=16000, got … "held":8000 …).
//   mutate sheet_sync_revert_run "if v_sync_run then" "if false then"
//   # M7 — map answer moves a patient on ANY row with the answer. Expect: FAIL
//   # Map answer moves only patients whose earliest answered row carries it
//   # (… expected 3 patients moved …, got 5).
//   mutate sheet_alias_apply "where c.patient_id is not null and c.source_norm <> ''" "where c.patient_id is not null and c.source_norm = p_raw_normalized"
//   # M11 — no "keep undone": dismiss is refused for undo holds too. Expect:
//   # FAIL Dismiss: refused on an evidence hold … (… dismiss an undo-held item
//   # (keep undone): unexpected error — [22023] …).
//   mutate sheet_review_resolve "and l.hold_reason is distinct from 'undone by an admin') then" ") then"
//   # M12 — acquire sweeps staged rows without sparing a LIVE run. Expect:
//   # FAIL A paused acquire sweeps a dead run's staged rows … (… a live
//   # run's staged rows must survive the sweep, got 0).
//   mutate sheet_sync_acquire "where not exists (select 1 from public.sheet_sync_runs r" "where true or not exists (select 1 from public.sheet_sync_runs r"
//   npm run sheet-sync:db-proof          # expect exactly those eight FAILs
//   /opt/homebrew/bin/supabase db reset  # undo round A
//
//   ## Round B ##
//   # M3 — the fence ignores a stale heartbeat. Expect: FAIL Review resolve
//   # refused while a real run is running (… finish by the stale run after a
//   # resolve …) and FAIL A stale lease cannot write (… stale lease stage …).
//   mutate _sheet_sync_fence "if not public._sheet_sync_lease_live(v_hb) then" "if false then"
//   # M6 — an undo leaves the alias behind. Expect: FAIL Undo of a map-answer
//   # run removes the alias it added … (… expected alias_removed=1 …).
//   mutate sheet_sync_revert_run "where a.run_id = p_target_run for update loop" "where false for update loop"
//   # M9 — undated rows sort FIRST. Expect: FAIL Map answer moves only
//   # patients whose earliest answered row carries it (Zeta5 moves).
//   mutate sheet_alias_apply "c.registered_on asc nulls last" "c.registered_on asc nulls first"
//   # M15 — undo-held rows are raised as OPEN items (the flood). Expect: FAIL
//   # Undo-held items are raised kept undone … (… expected 4 raised kept undone
//   # and none open …) and FAIL Link / Create on a kept-undone item … (at its
//   # setup, which needs rows raised kept undone).
//   mutate sheet_sync_upsert_review "if v_identity and jsonb_array_length(v_keys) > 0" "if false and jsonb_array_length(v_keys) > 0"
//   npm run sheet-sync:db-proof          # expect exactly those six FAILs
//   /opt/homebrew/bin/supabase db reset  # undo round B
//
//   ## Round C ##
//   # M8 — an undo holds the links of patients it did not undo (kept or
//   # blocked). Expect: FAIL Undo holds the auto links of a restored patient;
//   # a kept patient keeps its links (… expected kept=1 deleted=0 held=0 …),
//   # FAIL Paged undo … (… the blocked patient's link left …), and (the
//   # consent-cascade guard's undo_outcome is 'kept' too, the same bucket
//   # this mutation stops excluding) FAIL Undo of a create keeps a patient
//   # that carries a consent record (… the create's link is left alone
//   # (kept, not held) …).
//   mutate sheet_sync_revert_run "and c.undo_outcome in ('kept','blocked')" "and false"
//   # M14 — identity kinds no longer share one review item per key. Expect:
//   # FAIL Identity kinds share one review item per key … (the second report
//   # opens another item, or hits the one-open-item-per-key index) and FAIL
//   # Dismiss: refused on an evidence hold … (a keep-undone item re-opens
//   # under another identity kind).
//   mutate sheet_sync_upsert_review "or (v_identity and i.kind in (" "or (false and i.kind in ("
//   # M16 — "Let the sync decide again" releases EVERY undo hold, not just
//   # that undo's. Expect: FAIL Undo-held items are raised kept undone …
//   # (… release page 1/2 counts, or the other undo's hold is gone).
//   mutate sheet_sync_release_undo "and l.hold_reason = 'undone by an admin' and l.run_id = any (v_undo_runs)" "and l.hold_reason = 'undone by an admin'"
//   # M22 — map answer no longer checks the review item is still open before
//   # writing (map-answer race, Codex P2). Expect: FAIL Map answer refuses a
//   # second call against an already-handled review item (… second admin
//   # races the same item: expected code P0064, but the call succeeded …).
//   mutate sheet_alias_apply "if p_item_id is not null and not exists (" "if false and not exists ("
//   npm run sheet-sync:db-proof          # expect exactly those seven FAILs
//   /opt/homebrew/bin/supabase db reset  # undo round C
//
//   ## Round D ##
//   # M10 — an alias undo restores a version whose own run was undone. Expect:
//   # FAIL Undo of a map-answer run … (… u1c answer (older run undone first):
//   # expected no alias left, got flyers).
//   mutate sheet_sync_revert_run "while v_restore is not null and exists (" "while false and exists ("
//   # M13 — a Keep-undone item ignores new candidates. Expect: FAIL Dismiss:
//   # refused on an evidence hold … (… new candidates must re-open a
//   # keep-undone item …).
//   mutate sheet_sync_upsert_review "or i.resolution->'candidate_ids' = v_ids)" "or true)"
//   (M13 runs here, not in round A: M11 would stop that check before this step.)
//   # M17 — a kept-undone item takes no Link / Create. Expect: FAIL Link /
//   # Create on a kept-undone item … (… link a kept-undone row: unexpected
//   # error — [P0064] …).
//   mutate sheet_review_resolve "or (i.status = 'dismissed' and coalesce(" "or (false and i.status = 'dismissed' and coalesce("
//   (M17 runs here, not in round B: M15 would stop that check at its setup.)
//   # M18 — release hands an ADMIN-method hold back to the sync too. Expect:
//   # FAIL Undo-held items are raised kept undone; Let the sync decide again
//   # releases that undo's holds (paged) (… the admin hold must survive
//   # release …, or release page 1/2 counts differ).
//   mutate sheet_sync_release_undo "and l.method <> 'admin'" ""
//   npm run sheet-sync:db-proof          # expect exactly those four FAILs
//   /opt/homebrew/bin/supabase db reset  # undo round D, then re-run: all PASS
//
//   ## Round E ##
//   # M19 — undo cascade-deletes a patient's consent record instead of
//   # keeping the patient. Expect: FAIL Undo of a create keeps a patient
//   # that carries a consent record (… expected kept=1 deleted=0 …).
//   mutate sheet_sync_revert_run "if exists (select 1 from public.patient_consents c where c.patient_id = v_pid) then" "if false then"
//   # M20 — fill applies to a patient even after it changed since the
//   # planner read it. Expect: FAIL Create skips an existing live patient;
//   # fill and link skip a stale row_version (… stale fill: expected
//   # stale=1 filled=0 …).
//   mutate sheet_sync_apply_customer_ops "if v_op ? 'expected_row_version' and v_old.row_version <> (v_op->>'expected_row_version')::bigint then" "if false then"
//   npm run sheet-sync:db-proof          # expect exactly those two FAILs
//   /opt/homebrew/bin/supabase db reset  # undo round E
//
//   ## Round F ##
//   # M21 — create no longer skips a concurrent registration (front desk
//   # registered the same person after the planner read patients). Expect:
//   # FAIL Create skips an existing live patient; fill and link skip a stale
//   # row_version (… concurrent dup (name+DOB): expected created=0
//   # skipped_existing=1 …).
//   mutate sheet_sync_apply_customer_ops "if v_dupe_id is not null then" "if false then"
//   npm run sheet-sync:db-proof          # expect exactly that one FAIL
//   /opt/homebrew/bin/supabase db reset  # undo round F, then re-run: all PASS
//
//   ## Round G ##
//   # M23 — 0167 (patient soft delete): undo no longer treats a since-
//   # deleted CREATED patient as `gone` — it falls through to the `kept`
//   # branch instead (harmless — still never hard-deletes it — but the wrong
//   # label, and it would stop counting as `gone` on the UI). Expect: FAIL
//   # 0167: undo blocks a restore onto a since-deleted patient, and calls a
//   # since-deleted CREATED patient gone (never kept, never re-deleted) (…
//   # undo of a since-deleted create: expected gone=1 deleted=0 kept=0, got
//   # …"kept":1…"gone":0… ).
//   mutate sheet_sync_revert_run "if v_del_at is not null then" "if false then"
//   npm run sheet-sync:db-proof          # expect exactly that one FAIL
//   /opt/homebrew/bin/supabase db reset  # undo round G, then re-run: all PASS
//
//   ## 0193 rounds (sync review gaps; check 38 — REAL planCustomers output through the RPC) ##
//   # 0193 re-creates sheet_sync_apply_customer_ops, so mutate it from the 0193 file
//   # (same helper, swap the file name), one mutation per round, restoring between rounds
//   # by re-applying the unmutated body (or db reset). Each round expects exactly the
//   # check-38 FAIL named (the sub-assertion is in its detail):
//   #  H  "if not ((v_op->>'expected_row_version')::bigint = v_facts_ver - 1" -> "if not (false and (v_op->>'expected_row_version')::bigint = v_facts_ver - 1"   (a) one chunk
//   #  I  "c.run_id = v_run and" -> "true and"                                                                                     (e) a later run gets no credit
//   #  J  "::bigint = v_facts_ver - 1" -> "::bigint is not null"  (single-line on purpose: the helper THROWS "mutation target not found" if the text is absent)   (f) version one below the fill
//   #  K  "if v_op ? 'expected_row_version' and v_facts_ver is distinct from" -> "if false and v_facts_ver is distinct from"   (c) stale identity (+ the older stale-facts check)
//   #  L  the fill's not-found branch back to "n_skipped := n_skipped + 1; continue;"                                               (g) deleted target (+ check 36)
//   # (S1 and S4 are pinned by customer-plan.test.ts and review-queue.test.tsx.)
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import { planCustomers } from "../src/lib/sheet-sync/customer-plan";
import { buildPatientIndex } from "../src/lib/sheet-sync/patient-index";
import { parseCustomersTab } from "../src/lib/sheet-sync/tabs/customers";
import { CUST_HEADER } from "../src/lib/sheet-sync/__fixtures__/tab-headers";
import type { CustomerOp, PatientRecord } from "../src/lib/sheet-sync/types";

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
          sql: `select public.sheet_mirror_commit('${NIL}'::uuid, 'lab', 0)`,
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
        {
          name: "sheet_sync_clear_absent_review",
          sql: `select public.sheet_sync_clear_absent_review('${NIL}'::uuid, 'lab', '[]'::jsonb)`,
        },
        {
          name: "sheet_sync_release_undo",
          sql: `select public.sheet_sync_release_undo('${NIL}'::uuid, '${NIL}'::uuid)`,
        },
        {
          name: "_sheet_sync_fence",
          sql: `select public._sheet_sync_fence('${NIL}'::uuid, true)`,
        },
        {
          name: "_sheet_sync_lease_live",
          sql: `select public._sheet_sync_lease_live(now())`,
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
        `select public.sheet_mirror_commit($1::uuid, 'lab', 6)`,
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
        q(`select public.sheet_mirror_commit($1::uuid, 'lab', 0)`, [d.token]),
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

      // R is a May-imported patient; N has the same channel but was NOT
      // created by the May import, so re-sort must leave it alone (M4).
      const patient = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate, referral_source, legacy_intake)
         values ('Carlos', 'Villanueva', '1988-08-08', 'other', '{"source":"google_sheet_CUSTOMER_LIST2"}'::jsonb)
         returning id`,
      );
      const rId = patient.rows[0].id;
      const nonMay = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate, referral_source)
         values ('Nena', 'Castillo', '1987-07-07', 'other')
         returning id`,
      );
      const nId = nonMay.rows[0].id;

      const lease1 = await acquire("resort", false);
      const n = await q<{ sheet_resort_apply: number }>(
        `select public.sheet_resort_apply($1::uuid, $2::uuid[], 'other', 'online_google')`,
        [lease1.token, [rId, nId]],
      );
      assert(
        n.rows[0].sheet_resort_apply === 1,
        `resort apply: expected 1 row updated (the May patient only), got ${n.rows[0].sheet_resort_apply}`,
      );
      const nAfter = await q<{ source: string; origin: string; rv: string }>(
        `select referral_source as source, referral_source_origin as origin, row_version::text as rv
           from public.patients where id = $1`,
        [nId],
      );
      assert(
        nAfter.rows[0].source === "other" && nAfter.rows[0].origin === "staff" && nAfter.rows[0].rv === "0",
        `resort apply: the non-May patient must be untouched, got ${JSON.stringify(nAfter.rows[0])}`,
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
        // link-2's saved decision was an admin "create"; link-1 merely joined it.
        admin_link_keys: [linkKeys[1]],
        facts: { registered_on: "2026-09-01", new_repeat: "new", source_ref: "sheet-row-9001" },
      };

      // admin_link_keys must be a subset of link_keys.
      await expectPgError("create with admin_link_keys outside link_keys", "22023", () =>
        q(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb)`, [
          lease.token,
          JSON.stringify([{ ...op, create_key: "create-check-bad", admin_link_keys: ["sheet:not-a-key"] }]),
        ]),
      );

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
      const methods = await q<{ link_key: string; method: string; decision: string; run_id: string | null }>(
        `select link_key, method, decision, run_id::text as run_id from public.sheet_patient_links
          where link_key = any($1::text[]) order by link_key`,
        [linkKeys],
      );
      assert(
        methods.rows[0].method === "auto_exact" && methods.rows[1].method === "admin",
        `create: expected per-key methods [auto_exact, admin], got ${JSON.stringify(methods.rows)}`,
      );
      assert(
        methods.rows.every((m) => m.decision === "link" && m.run_id === lease.runId),
        `create: expected both keys decision 'link' with run_id = this run, got ${JSON.stringify(methods.rows)}`,
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

    // 9b. Create skips a concurrent registration; fill/link skip a stale read
    //     (Codex P1/P2) ------------------------------------------------------
    await check("Create skips an existing live patient; fill and link skip a stale row_version", async () => {
      await setRole("service_role", null);
      const apply = (token: string, ops: unknown[]) =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [token, JSON.stringify(ops)]);
      const create = (key: string, over: Record<string, unknown> = {}) => ({
        op: "create", create_key: key, method: "auto_exact",
        fields: { first_name: "Wilfredo", last_name: "Concurrent", middle_name: null, birthdate: "1988-03-03", ...over },
        link_keys: [key], admin_link_keys: [], legacy_intake: {},
        facts: { registered_on: null, new_repeat: null, source_ref: key },
      });

      // (a) Front desk registered this exact person (same name, same DOB)
      // after the planner read patients: the create must be skipped, not
      // duplicated, and no link written for its key.
      await setRole("postgres", null);
      const dup = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Wilfredo', 'Concurrent', '1988-03-03') returning id`,
      );
      await setRole("service_role", null);
      const r1 = await acquire("manual", false);
      const c1 = await apply(r1.token, [create("dupe:1")]);
      assert(
        c1.rows[0].j.counts.created === 0 && c1.rows[0].j.counts.skipped_existing === 1,
        `concurrent dup (name+DOB): expected created=0 skipped_existing=1, got ${JSON.stringify(c1.rows[0].j.counts)}`,
      );
      assert(Object.keys(c1.rows[0].j.created).length === 0, `concurrent dup: expected no created id, got ${JSON.stringify(c1.rows[0].j.created)}`);
      // review fix B: the skipped create_key comes back so the runner can
      // stage that mirror row unresolved instead of throwing "no created id".
      assert(
        Array.isArray(c1.rows[0].j.skipped_create_keys) && c1.rows[0].j.skipped_create_keys.includes("dupe:1"),
        `concurrent dup: expected skipped_create_keys to include "dupe:1", got ${JSON.stringify(c1.rows[0].j.skipped_create_keys)}`,
      );
      await finish(r1.token);
      const patCount = await q<{ n: string }>(`select count(*)::text as n from public.patients where last_name = 'Concurrent'`);
      assert(patCount.rows[0].n === "1", `concurrent dup: expected exactly 1 patient named Concurrent, got ${patCount.rows[0].n}`);
      const linkRow = await q<{ n: string }>(`select count(*)::text as n from public.sheet_patient_links where link_key = 'dupe:1'`);
      assert(linkRow.rows[0].n === "0", `concurrent dup: expected no link written for the skipped create, got ${linkRow.rows[0].n}`);

      // (b) same name, no DOB on the op, same normalized phone -> also skipped.
      await setRole("postgres", null);
      await q(`update public.patients set phone = '+639171234567' where id = $1`, [dup.rows[0].id]);
      await setRole("service_role", null);
      const r2 = await acquire("manual", false);
      const c2 = await apply(r2.token, [
        create("dupe:2", { birthdate: null, phone: "09171234567" }),
      ]);
      assert(
        c2.rows[0].j.counts.skipped_existing === 1,
        `concurrent dup (name+phone, no DOB): expected skipped_existing=1, got ${JSON.stringify(c2.rows[0].j.counts)}`,
      );
      await finish(r2.token);

      // (c) negative control: a genuinely different person (different DOB,
      // different phone) with the same name must still be created normally.
      const r3 = await acquire("manual", false);
      const c3 = await apply(r3.token, [
        create("dupe:3", { birthdate: "1999-09-09", phone: "09179998888" }),
      ]);
      assert(
        c3.rows[0].j.counts.created === 1 && (c3.rows[0].j.counts.skipped_existing ?? 0) === 0,
        `not a duplicate: expected created=1 skipped_existing=0, got ${JSON.stringify(c3.rows[0].j.counts)}`,
      );
      await finish(r3.token);

      // (c2) an ADMIN create is exempt: never second-guessed by this
      // heuristic, even against the exact same duplicate as (a).
      const r3b = await acquire("manual", false);
      const c3b = await apply(r3b.token, [
        { ...create("dupe:4"), method: "admin", admin_link_keys: ["dupe:4"] },
      ]);
      assert(
        c3b.rows[0].j.counts.created === 1 && (c3b.rows[0].j.counts.skipped_existing ?? 0) === 0,
        `admin create: expected created=1 skipped_existing=0 (an admin decision is never second-guessed), got ${JSON.stringify(c3b.rows[0].j.counts)}`,
      );
      await finish(r3b.token);

      // (d) stale row_version: a fill and a link against a patient the
      // planner read at row_version 0, changed to 1 since (staff edited it) —
      // both must be skipped as stale, not applied against a live target.
      await setRole("postgres", null);
      const sp = await q<{ id: string; rv: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Stale', 'Target', '1975-05-05')
         returning id, row_version::text as rv`,
      );
      assert(sp.rows[0].rv === "0", `fixture: expected row_version 0 on insert, got ${sp.rows[0].rv}`);
      const spId = sp.rows[0].id;
      await q(`update public.patients set address = 'changed by staff after the planner read it' where id = $1`, [spId]);
      const spAfter = await q<{ rv: string; email: string | null }>(`select row_version::text as rv, email from public.patients where id = $1`, [spId]);
      assert(spAfter.rows[0].rv === "1", `fixture: expected row_version 1 after the staff edit, got ${spAfter.rows[0].rv}`);
      await setRole("service_role", null);
      const r4 = await acquire("manual", false);
      const f = await apply(r4.token, [
        { op: "fill", patient_id: spId, fields: { email: "stale@example.test" }, expected_row_version: 0 },
      ]);
      assert(
        f.rows[0].j.counts.stale === 1 && (f.rows[0].j.counts.filled ?? 0) === 0,
        `stale fill: expected stale=1 filled=0, got ${JSON.stringify(f.rows[0].j.counts)}`,
      );
      // review fix D: the rejected patient id comes back so the runner can
      // null its association on the reporting mirror.
      assert(
        Array.isArray(f.rows[0].j.stale_patient_ids) && f.rows[0].j.stale_patient_ids.includes(spId),
        `stale fill: expected stale_patient_ids to include the patient, got ${JSON.stringify(f.rows[0].j.stale_patient_ids)}`,
      );
      await finish(r4.token);
      const untouched = await q<{ email: string | null }>(`select email from public.patients where id = $1`, [spId]);
      assert(untouched.rows[0].email === null, `stale fill: patient must be untouched, got email=${untouched.rows[0].email}`);

      const r5 = await acquire("manual", false);
      const l = await apply(r5.token, [
        { op: "link", link_key: "stale:1", patient_id: spId, method: "auto_exact", expected_row_version: 0 },
      ]);
      assert(
        l.rows[0].j.counts.stale === 1 && (l.rows[0].j.counts.linked ?? 0) === 0,
        `stale link: expected stale=1 linked=0, got ${JSON.stringify(l.rows[0].j.counts)}`,
      );
      await finish(r5.token);
      const noLink = await q<{ n: string }>(`select count(*)::text as n from public.sheet_patient_links where link_key = 'stale:1'`);
      assert(noLink.rows[0].n === "0", `stale link: no link row should have been written, got ${noLink.rows[0].n}`);

      // (d2) review fix D: facts carries the SAME stale-read guard as its
      // sibling link/fill ops (the planner plans all three from one read) —
      // a mismatched expected_row_version must skip it, no facts row written.
      const r5b = await acquire("manual", false);
      const facts1 = await apply(r5b.token, [
        { op: "facts", patient_id: spId, registered_on: "2026-01-01", new_repeat: "new", source_ref: "stale-facts:1", expected_row_version: 0 },
      ]);
      assert(
        facts1.rows[0].j.counts.stale === 1 && (facts1.rows[0].j.counts.facts ?? 0) === 0,
        `stale facts: expected stale=1 facts=0, got ${JSON.stringify(facts1.rows[0].j.counts)}`,
      );
      assert(
        Array.isArray(facts1.rows[0].j.stale_patient_ids) && facts1.rows[0].j.stale_patient_ids.includes(spId),
        `stale facts: expected stale_patient_ids to include the patient, got ${JSON.stringify(facts1.rows[0].j.stale_patient_ids)}`,
      );
      await finish(r5b.token);
      const noFacts1 = await q<{ n: string }>(
        `select count(*)::text as n from public.patient_acquisition_facts where source_ref = 'stale-facts:1'`,
      );
      assert(noFacts1.rows[0].n === "0", `stale facts: no acquisition-facts row should have been written, got ${noFacts1.rows[0].n}`);

      // (e) positive control: the correct expected_row_version applies normally.
      const r6 = await acquire("manual", false);
      const f2 = await apply(r6.token, [
        { op: "fill", patient_id: spId, fields: { email: "fresh@example.test" }, expected_row_version: 1 },
      ]);
      assert(f2.rows[0].j.counts.filled === 1, `matching row_version: expected filled=1, got ${JSON.stringify(f2.rows[0].j.counts)}`);
      await finish(r6.token);
      // (e2) same positive control for facts, read fresh (the fill above
      // just bumped row_version 1 -> 2 via the ownership trigger).
      const rvAfterFill = await q<{ rv: string }>(`select row_version::text as rv from public.patients where id = $1`, [spId]);
      const r6b = await acquire("manual", false);
      const facts2 = await apply(r6b.token, [
        { op: "facts", patient_id: spId, registered_on: "2026-01-01", new_repeat: "new", source_ref: "fresh-facts:1", expected_row_version: Number(rvAfterFill.rows[0].rv) },
      ]);
      assert(facts2.rows[0].j.counts.facts === 1, `matching row_version (facts): expected facts=1, got ${JSON.stringify(facts2.rows[0].j.counts)}`);
      await finish(r6b.token);

      // (f) accented name: the dupe check folds common Latin-1 accents (Codex
      // review) so "José Peña" (typed with accents, e.g. by an admin) and
      // "Jose Pena" (the sheet's plain-ASCII spelling of the same person)
      // still count as the same identity — invented name, never a real patient.
      await setRole("postgres", null);
      await q(
        `insert into public.patients (first_name, last_name, birthdate) values ('José', 'Peña', '1982-02-02')`,
      );
      await setRole("service_role", null);
      const r7 = await acquire("manual", false);
      const c7 = await apply(r7.token, [
        create("accent:1", { first_name: "Jose", last_name: "Pena", birthdate: "1982-02-02" }),
      ]);
      assert(
        c7.rows[0].j.counts.created === 0 && c7.rows[0].j.counts.skipped_existing === 1,
        `accented dupe (José Peña vs Jose Pena): expected created=0 skipped_existing=1, got ${JSON.stringify(c7.rows[0].j.counts)}`,
      );
      await finish(r7.token);
      const accentCount = await q<{ n: string }>(
        `select count(*)::text as n from public.patients where last_name in ('Peña', 'Pena')`,
      );
      assert(accentCount.rows[0].n === "1", `accented dupe: expected exactly 1 patient, got ${accentCount.rows[0].n}`);
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

      // --- Run W: create a patient (one auto key + one admin key) and auto-link
      // a third key to existing patient T; revert deletes the created patient
      // and turns all three keys into HOLDS (sticky undo); an admin decision
      // the run never wrote is untouched; second revert -> 22023. ---
      const wKeys = ["sheet:revert-w:link-1", "sheet:revert-w:link-2", "sheet:revert-w:link-3"];
      await q(
        `insert into public.sheet_patient_links (link_key, patient_id, decision, method)
         values ('sheet:revert-w:admin-keep', $1, 'link', 'admin')`,
        [tId],
      );
      const leaseW = await acquire("manual", false);
      const opW = {
        op: "create",
        create_key: "revert-w-1",
        method: "admin",
        fields: { first_name: "Wilma", last_name: "Domingo", referral_source: "walk_in" },
        link_keys: [wKeys[0], wKeys[1]],
        admin_link_keys: [wKeys[1]],
        facts: { registered_on: "2026-09-02", new_repeat: "new", source_ref: "sheet-row-9002" },
      };
      const linkW = { op: "link", link_key: wKeys[2], patient_id: tId, method: "auto_exact" };
      const rW = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [leaseW.token, JSON.stringify([opW, linkW])],
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
      assert(
        revW.rows[0].j.held === 3,
        `revert W: expected held=3 (two keys of the deleted patient + the run's auto link), got ${JSON.stringify(revW.rows[0].j)}`,
      );
      const wLinks = await q<{ link_key: string; decision: string; patient_id: string | null; method: string; run_id: string | null }>(
        `select link_key, decision, patient_id::text as patient_id, method, run_id::text as run_id
           from public.sheet_patient_links where link_key = any($1::text[]) order by link_key`,
        [wKeys],
      );
      assert(
        wLinks.rows.length === 3,
        `revert W: the deleted patient's keys must survive as holds (not cascade away), got ${wLinks.rows.length} rows`,
      );
      assert(
        wLinks.rows.every(
          (l) => l.decision === "review" && l.patient_id === null && l.run_id === leaseRevW.runId,
        ),
        `revert W: expected all three keys held (review, no patient, run_id = the undo run), got ${JSON.stringify(wLinks.rows)}`,
      );
      const keep = await q<{ decision: string; patient_id: string; method: string; run_id: string | null }>(
        `select decision, patient_id::text as patient_id, method, run_id::text as run_id
           from public.sheet_patient_links where link_key = 'sheet:revert-w:admin-keep'`,
      );
      assert(
        keep.rows[0].decision === "link" && keep.rows[0].patient_id === tId &&
          keep.rows[0].method === "admin" && keep.rows[0].run_id === null,
        `revert W: an admin decision the run never wrote must be untouched, got ${JSON.stringify(keep.rows[0])}`,
      );
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

      // An item re-reported with NO payload keeps a valid (empty) payload
      // rather than failing the NOT NULL column (M6).
      const r2b = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`,
        [lease2.token, JSON.stringify([{ kind: "unmapped_source", item_key: itemKey }])],
      );
      assert(
        r2b.rows[0].j.updated === 1,
        `upsert without payload: expected updated=1, got ${JSON.stringify(r2b.rows[0].j)}`,
      );
      const payload = await q<{ payload: Json }>(
        `select payload from public.sheet_sync_review_items where kind = 'unmapped_source' and item_key = $1`,
        [itemKey],
      );
      assert(
        JSON.stringify(payload.rows[0].payload) === "{}",
        `upsert without payload: expected payload {}, got ${JSON.stringify(payload.rows[0].payload)}`,
      );
      // Admin resolves are refused while a real run holds the lease (M5), so
      // close this run first.
      await finish(lease2.token);

      // Dismiss it -> the next upsert must not reopen it.
      const itemId = (
        await q<{ id: string }>(
          `select id from public.sheet_sync_review_items where kind = 'unmapped_source' and item_key = $1`,
          [itemKey],
        )
      ).rows[0].id;
      await q(`select public.sheet_review_resolve($1::uuid, null, 'dismiss', null)`, [itemId]);

      const lease3 = await acquire("manual", false);
      const r3 = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`,
        [lease3.token, items2],
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
          lease3.token,
          JSON.stringify([{ kind: "invalid_row", item_key: otherKey, payload: {} }]),
        ],
      );
      const clear = await q<{ j: Json }>(
        `select public.sheet_sync_upsert_review($1::uuid, 'customers', '[]'::jsonb, true) as j`,
        [lease3.token],
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

      await finish(lease3.token);

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
    });

    // 12. Hold op -------------------------------------------------------
    await check("Hold op", async () => {
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_patient_links (link_key, patient_id, decision, method) values
           ('hold:admin-1', $1, 'link', 'admin'),
           ('hold:auto-1',  $1, 'link', 'auto_exact')`,
        [fx.patientPId],
      );
      await setRole("service_role", null);
      const lease = await acquire("manual", false);
      const ops = JSON.stringify([
        { op: "hold", link_key: "hold:new-1", reason: "ambiguous_patient" },
        { op: "hold", link_key: "hold:auto-1", reason: "identity_conflict" },
        { op: "hold", link_key: "hold:admin-1", reason: "identity_conflict" },
      ]);
      const r = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [lease.token, ops],
      );
      assert(
        r.rows[0].j.counts.held === 2 && r.rows[0].j.counts.skipped === 1,
        `hold ops: expected held=2 skipped=1 (the admin row is never held), got ${JSON.stringify(r.rows[0].j)}`,
      );
      await expectPgError("hold op with no link_key", "22023", () =>
        q(`select public.sheet_sync_apply_customer_ops($1::uuid, '[{"op":"hold","reason":"x"}]'::jsonb)`, [
          lease.token,
        ]),
      );
      await finish(lease.token);

      const rows = await q<{ link_key: string; decision: string; patient_id: string | null; method: string; run_id: string | null; hold_reason: string | null }>(
        `select link_key, decision, patient_id::text as patient_id, method, run_id::text as run_id, hold_reason
           from public.sheet_patient_links where link_key like 'hold:%' order by link_key`,
      );
      const byKey = Object.fromEntries(rows.rows.map((x) => [x.link_key, x]));
      const n1 = byKey["hold:new-1"];
      assert(
        n1 && n1.decision === "review" && n1.patient_id === null && n1.method === "auto_exact" && n1.run_id === lease.runId &&
          n1.hold_reason === "ambiguous_patient",
        `hold:new-1: expected a new review hold stamped with this run, got ${JSON.stringify(n1)}`,
      );
      const a1 = byKey["hold:auto-1"];
      assert(
        a1 && a1.decision === "review" && a1.patient_id === null && a1.run_id === lease.runId,
        `hold:auto-1: expected the auto link turned into a hold, got ${JSON.stringify(a1)}`,
      );
      const ad = byKey["hold:admin-1"];
      assert(
        ad && ad.decision === "link" && ad.patient_id === fx.patientPId && ad.method === "admin" && ad.run_id === null,
        `hold:admin-1: an admin link must not be held, got ${JSON.stringify(ad)}`,
      );

      // An admin resolve overwrites a hold (no lease open here).
      const item = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload)
         values ('customers', 'hold:new-1', 'ambiguous_patient', '{"link_keys":["hold:new-1"]}'::jsonb)
         returning id`,
      );
      await q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'link', $3::uuid)`, [
        item.rows[0].id,
        fx.adminId,
        fx.patientPId,
      ]);
      const resolved = await q<{ decision: string; patient_id: string; method: string; run_id: string | null }>(
        `select decision, patient_id::text as patient_id, method, run_id::text as run_id
           from public.sheet_patient_links where link_key = 'hold:new-1'`,
      );
      assert(
        resolved.rows[0].decision === "link" && resolved.rows[0].patient_id === fx.patientPId &&
          resolved.rows[0].method === "admin" && resolved.rows[0].run_id === null,
        `admin resolve over a hold: expected an admin link with no run_id, got ${JSON.stringify(resolved.rows[0])}`,
      );
    });

    // 13. Revert keeps a sheet-owned channel sheet-owned (I2) ---------------
    await check("Revert of a sheet-to-sheet channel keeps origin sheet", async () => {
      await setRole("service_role", null);
      const leaseC = await acquire("manual", false);
      const rc = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [
          leaseC.token,
          JSON.stringify([
            {
              op: "create",
              create_key: "i2-1",
              method: "auto_exact",
              fields: { first_name: "Irene", last_name: "Salazar", middle_name: null, referral_source: "other" },
              link_keys: ["sheet:i2:link-1"],
              admin_link_keys: [],
              legacy_intake: {},
              facts: { registered_on: null, new_repeat: null, source_ref: "sheet-row-9003" },
            },
          ]),
        ],
      );
      const iId = rc.rows[0].j.created["i2-1"];
      await finish(leaseC.token);

      await setRole("postgres", null);
      await q(
        `insert into public.sheet_customer_rows
           (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, source_norm, patient_id, link_state, row_hash, run_id)
         values (2, 'probe-src-i2', 'Salazar, Irene', 'salazar|irene', 'salazarirene', 'sheet:i2:link-1',
                 'probe answer i2', $1, 'linked', 'hash-i2', $2)`,
        [iId, leaseC.runId],
      );
      await setRole("service_role", null);

      const leaseA = await acquire("alias", false);
      const na = await q<{ n: number }>(
        `select public.sheet_alias_apply($1::uuid, 'probe answer i2', 'online_google', null) as n`,
        [leaseA.token],
      );
      assert(na.rows[0].n === 1, `alias apply: expected 1 patient moved, got ${na.rows[0].n}`);
      const mid = await q<{ source: string; origin: string }>(
        `select referral_source as source, referral_source_origin as origin from public.patients where id = $1`,
        [iId],
      );
      assert(
        mid.rows[0].source === "online_google" && mid.rows[0].origin === "sheet",
        `alias apply: expected online_google / sheet, got ${JSON.stringify(mid.rows[0])}`,
      );
      await finish(leaseA.token);

      const leaseR = await acquire("revert", false);
      const rv = await q<{ j: Json }>(
        `select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`,
        [leaseR.token, leaseA.runId],
      );
      assert(rv.rows[0].j.restored === 1, `revert alias: expected restored=1, got ${JSON.stringify(rv.rows[0].j)}`);
      const after = await q<{ source: string; origin: string }>(
        `select referral_source as source, referral_source_origin as origin from public.patients where id = $1`,
        [iId],
      );
      assert(
        after.rows[0].source === "other" && after.rows[0].origin === "sheet",
        `revert alias: expected other / sheet (a sheet-owned channel stays sheet-owned), got ${JSON.stringify(after.rows[0])}`,
      );
      // An alias run changes channels, not identity: its undo holds no link.
      const link = await q<{ decision: string; patient_id: string | null }>(
        `select decision, patient_id::text as patient_id from public.sheet_patient_links where link_key = 'sheet:i2:link-1'`,
      );
      assert(
        link.rows[0].decision === "link" && link.rows[0].patient_id === iId,
        `revert alias: the patient's link must stay a link (alias undo is not an identity undo), got ${JSON.stringify(link.rows[0])}`,
      );
      await finish(leaseR.token);
    });

    // 14. Revert restores the EARLIEST before-image (M2) ---------------------
    await check("Revert restores the earliest value when a run changed a column twice", async () => {
      await setRole("service_role", null);
      const p = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate, referral_source, legacy_intake)
         values ('Lorna', 'Mendoza', '1970-01-01', 'other', '{"source":"google_sheet_CUSTOMER_LIST2"}'::jsonb)
         returning id`,
      );
      const lId = p.rows[0].id;
      const lease = await acquire("resort", false);
      await q(`select public.sheet_resort_apply($1::uuid, $2::uuid[], 'other', 'online_google')`, [lease.token, [lId]]);
      await q(`select public.sheet_resort_apply($1::uuid, $2::uuid[], 'online_google', 'online_facebook')`, [
        lease.token,
        [lId],
      ]);
      await finish(lease.token);

      const leaseR = await acquire("revert", false);
      const rv = await q<{ j: Json }>(
        `select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`,
        [leaseR.token, lease.runId],
      );
      assert(rv.rows[0].j.restored === 1, `revert: expected restored=1, got ${JSON.stringify(rv.rows[0].j)}`);
      const after = await q<{ source: string; origin: string }>(
        `select referral_source as source, referral_source_origin as origin from public.patients where id = $1`,
        [lId],
      );
      assert(
        after.rows[0].source === "other" && after.rows[0].origin === "staff",
        `revert: expected the pre-run other / staff, got ${JSON.stringify(after.rows[0])}`,
      );
      await finish(leaseR.token);
    });

    // 15. Senior/PWD pair fills together (M7) --------------------------------
    await check("Senior/PWD pair fills only as a pair", async () => {
      await setRole("service_role", null);
      const p = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Sergio', 'Reyes', '1950-05-05') returning id`,
      );
      const sId = p.rows[0].id;
      const lease = await acquire("manual", false);
      const half = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [lease.token, JSON.stringify([{ op: "fill", patient_id: sId, fields: { senior_pwd_id_kind: "senior" } }])],
      );
      assert(
        half.rows[0].j.counts.skipped === 1,
        `kind without number: expected a skipped no-op, got ${JSON.stringify(half.rows[0].j)}`,
      );
      const both = await q<{ j: Json }>(
        `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`,
        [
          lease.token,
          JSON.stringify([
            { op: "fill", patient_id: sId, fields: { senior_pwd_id_kind: "senior", senior_pwd_id_number: "SC-0001" } },
          ]),
        ],
      );
      assert(both.rows[0].j.counts.filled === 1, `kind + number: expected filled=1, got ${JSON.stringify(both.rows[0].j)}`);
      const row = await q<{ k: string; n: string; rv: string }>(
        `select senior_pwd_id_kind as k, senior_pwd_id_number as n, row_version::text as rv from public.patients where id = $1`,
        [sId],
      );
      assert(
        row.rows[0].k === "senior" && row.rows[0].n === "SC-0001" && row.rows[0].rv === "1",
        `kind + number: expected senior / SC-0001 at row_version 1, got ${JSON.stringify(row.rows[0])}`,
      );
      await finish(lease.token);
    });

    // 16. Dry-run lease cannot write (M1) ------------------------------------
    await check("Dry-run lease cannot write", async () => {
      await setRole("service_role", null);
      const labBefore = (
        await q<{ n: string }>(`select count(*)::text as n from public.sheet_encounter_lines where tab = 'lab'`)
      ).rows[0].n;
      const d = await acquire("manual", true);
      assert(d.status === "running", `dry acquire: expected running, got ${d.status}`);
      const writes: [string, string, unknown[]][] = [
        ["stage", `select public.sheet_mirror_stage($1::uuid, 'lab', '[{"sheet_row":1}]'::jsonb)`, [d.token]],
        ["ops", `select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb)`,
          [d.token, JSON.stringify([{ op: "fill", patient_id: fx.patientPId, fields: { email: "dry@example.test" } }])]],
        ["commit", `select public.sheet_mirror_commit($1::uuid, 'lab', 0)`, [d.token]],
        ["review upsert", `select public.sheet_sync_upsert_review($1::uuid, 'customers', '[]'::jsonb, true)`, [d.token]],
        ["resort", `select public.sheet_resort_apply($1::uuid, array[]::uuid[], 'other', 'walk_in')`, [d.token]],
        ["alias", `select public.sheet_alias_apply($1::uuid, 'probe', 'other', null)`, [d.token]],
        ["revert", `select public.sheet_sync_revert_run($1::uuid, gen_random_uuid())`, [d.token]],
      ];
      for (const [label, sql, params] of writes) {
        await expectPgError(`dry-run ${label}`, "22023", () => q(sql, params));
      }
      await expectOk("dry-run heartbeat", () => q(`select public.sheet_sync_heartbeat($1::uuid)`, [d.token]));
      await expectOk("dry-run finish", () => finish(d.token));
      const st = await q<{ status: string }>(`select status from public.sheet_sync_runs where id = $1`, [d.runId]);
      assert(st.rows[0].status === "succeeded", `dry-run finish: expected succeeded, got ${st.rows[0].status}`);
      const labAfter = (
        await q<{ n: string }>(`select count(*)::text as n from public.sheet_encounter_lines where tab = 'lab'`)
      ).rows[0].n;
      assert(labAfter === labBefore, `dry-run: lab mirror changed (${labBefore} -> ${labAfter})`);
    });

    // 17. Review resolve refused mid-run (M5) ---------------------------------
    await check("Review resolve refused while a real run is running", async () => {
      await setRole("postgres", null);
      const items = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind) values
           ('customers', 'probe-m5-1', 'invalid_row'),
           ('customers', 'probe-m5-2', 'invalid_row')
         returning id`,
      );
      const [x, y] = items.rows.map((r) => r.id);
      await setRole("service_role", null);

      const real = await acquire("manual", false);
      await expectPgError("resolve while a real run is live", "P0062", () =>
        q(`select public.sheet_review_resolve($1::uuid, null, 'dismiss', null)`, [x]),
      );
      // A run with no heartbeat for 10 minutes is dead by the lease's rule.
      await q(`update public.sheet_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`, [
        real.runId,
      ]);
      await expectOk("resolve beside a stale run", () =>
        q(`select public.sheet_review_resolve($1::uuid, null, 'dismiss', null)`, [x]),
      );
      // …and that dead run can no longer write anything, not even finish: it
      // planned from decisions the resolve may just have changed.
      await expectPgError("finish by the stale run after a resolve", "P0063", () => finish(real.token));

      const dry = await acquire("manual", true);
      await expectOk("resolve beside a preview run", () =>
        q(`select public.sheet_review_resolve($1::uuid, null, 'dismiss', null)`, [y]),
      );
      await finish(dry.token);
    });

    // 18. Commit refuses a count mismatch (M10) --------------------------------
    await check("Commit with the wrong expected count changes nothing", async () => {
      await setRole("service_role", null);
      const liveBefore = await q<{ n: string; h: string }>(
        `select count(*)::text as n, coalesce(string_agg(row_hash, ',' order by row_hash), '') as h
           from public.sheet_encounter_lines where tab = 'lab'`,
      );
      const lease = await acquire("manual", false);
      const rows = JSON.stringify(
        [1, 2].map((i) => ({
          sheet_row: i,
          service_date: "2026-09-21",
          name_raw: `Probe M10 ${i}`,
          name_norm: `probe m10 ${i}`,
          loose_key: `probem10${i}`,
          identity_key: `name:probem10${i}|2026-09-21`,
          raw: {},
          row_hash: `hash-m10-${i}`,
        })),
      );
      await q(`select public.sheet_mirror_stage($1::uuid, 'lab', $2::jsonb)`, [lease.token, rows]);
      await expectPgError("commit expecting 3 of 2 staged", "22023", () =>
        q(`select public.sheet_mirror_commit($1::uuid, 'lab', 3)`, [lease.token]),
      );
      const liveAfter = await q<{ n: string; h: string }>(
        `select count(*)::text as n, coalesce(string_agg(row_hash, ',' order by row_hash), '') as h
           from public.sheet_encounter_lines where tab = 'lab'`,
      );
      assert(
        liveAfter.rows[0].n === liveBefore.rows[0].n && liveAfter.rows[0].h === liveBefore.rows[0].h,
        `mismatch: live lab rows changed (${liveBefore.rows[0].n} -> ${liveAfter.rows[0].n})`,
      );
      const staged = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_mirror_staging where run_id = $1`,
        [lease.runId],
      );
      assert(staged.rows[0].n === "2", `mismatch: expected the 2 staged rows kept, got ${staged.rows[0].n}`);
      const ok = await q<{ n: number }>(`select public.sheet_mirror_commit($1::uuid, 'lab', 2) as n`, [lease.token]);
      assert(ok.rows[0].n === 2, `commit with the right count: expected 2, got ${ok.rows[0].n}`);
      await finish(lease.token);
    });

    // 19. Create over a saved admin "create" decision (review round 3, g) -----
    await check("Create over a saved admin create decision", async () => {
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_patient_links (link_key, decision, method, decided_by)
         values ('g1:admin-create', 'create', 'admin', $1)`,
        [fx.adminId],
      );
      await setRole("service_role", null);
      const lease = await acquire("manual", false);
      const r = await expectOk("create over the admin create", () =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
          lease.token,
          JSON.stringify([
            {
              op: "create", create_key: "g1", method: "admin",
              fields: { first_name: "Gina", last_name: "Uno", middle_name: null },
              link_keys: ["g1:admin-create", "g1:joined"], admin_link_keys: ["g1:admin-create"], legacy_intake: {},
              facts: { registered_on: null, new_repeat: null, source_ref: "g1" },
            },
          ]),
        ]),
      );
      const id = r.rows[0].j.created.g1;
      const links = await q<{ link_key: string; decision: string; method: string; patient_id: string | null; run_id: string | null }>(
        `select link_key, decision, method, patient_id::text as patient_id, run_id::text as run_id
           from public.sheet_patient_links where link_key like 'g1:%' order by link_key`,
      );
      const [adm, joined] = links.rows;
      assert(
        adm.decision === "link" && adm.method === "admin" && adm.patient_id === id && adm.run_id === lease.runId,
        `admin create key: expected an admin link to the new patient stamped with this run, got ${JSON.stringify(adm)}`,
      );
      assert(
        joined.decision === "link" && joined.method === "auto_exact" && joined.patient_id === id,
        `joined key: expected an auto_exact link to the new patient, got ${JSON.stringify(joined)}`,
      );
      await finish(lease.token);
    });

    // 20. The create path writes the Senior/PWD pair only as a pair ------------
    await check("Create writes the Senior/PWD pair only as a pair", async () => {
      await setRole("service_role", null);
      const lease = await acquire("manual", false);
      const mk = (key: string, fields: Record<string, string>) => ({
        op: "create", create_key: key, method: "auto_exact",
        fields: { first_name: "Selma", last_name: key, middle_name: null, ...fields },
        link_keys: [`g2:${key}`], admin_link_keys: [], legacy_intake: {},
        facts: { registered_on: null, new_repeat: null, source_ref: key },
      });
      const r = await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
        lease.token,
        JSON.stringify([mk("Half", { senior_pwd_id_kind: "senior" }), mk("Both", { senior_pwd_id_kind: "pwd", senior_pwd_id_number: "PWD-1" })]),
      ]);
      const got = await q<{ last_name: string; k: string | null; n: string | null }>(
        `select last_name, senior_pwd_id_kind as k, senior_pwd_id_number as n from public.patients
          where id = any($1::uuid[]) order by last_name`,
        [[r.rows[0].j.created.Half, r.rows[0].j.created.Both]],
      );
      const [both, half] = got.rows;
      assert(half.k === null && half.n === null, `kind without number: expected neither written, got ${JSON.stringify(half)}`);
      assert(both.k === "pwd" && both.n === "PWD-1", `kind + number: expected pwd / PWD-1, got ${JSON.stringify(both)}`);
      await finish(lease.token);
    });

    // 21. Holds are enforced in SQL too (review round 3, finding 3 + minor a) ---
    await check("Link and create never overwrite a hold; a link op cannot claim admin", async () => {
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_patient_links (link_key, decision, method, hold_reason)
         values ('h3:held', 'review', 'auto_exact', 'probe hold')`,
      );
      await setRole("service_role", null);
      const lease = await acquire("manual", false);
      const apply = (ops: unknown[]) =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [lease.token, JSON.stringify(ops)]);

      const l = await apply([{ op: "link", link_key: "h3:held", patient_id: fx.patientPId, method: "auto_exact" }]);
      assert(
        l.rows[0].j.counts.linked === 0 && l.rows[0].j.counts.skipped === 1,
        `link over a hold: expected skipped, got ${JSON.stringify(l.rows[0].j.counts)}`,
      );
      await expectPgError("create whose key is held", "22023", () =>
        apply([
          {
            op: "create", create_key: "h3", method: "auto_exact",
            fields: { first_name: "Hilda", last_name: "Heldthree", middle_name: null },
            link_keys: ["h3:held"], admin_link_keys: [], legacy_intake: {},
            facts: { registered_on: null, new_repeat: null, source_ref: "h3" },
          },
        ]),
      );
      const held = await q<{ decision: string; patient_id: string | null; hold_reason: string | null }>(
        `select decision, patient_id::text as patient_id, hold_reason from public.sheet_patient_links where link_key = 'h3:held'`,
      );
      assert(
        held.rows[0].decision === "review" && held.rows[0].patient_id === null && held.rows[0].hold_reason === "probe hold",
        `the hold must be untouched, got ${JSON.stringify(held.rows[0])}`,
      );
      const orphans = await q<{ n: string }>(`select count(*)::text as n from public.patients where last_name = 'Heldthree'`);
      assert(orphans.rows[0].n === "0", `a refused create must leave no patient behind, found ${orphans.rows[0].n}`);

      await expectPgError("link op with method admin", "22023", () =>
        apply([{ op: "link", link_key: "h3:new", patient_id: fx.patientPId, method: "admin" }]),
      );
      await expectPgError("link op with no method", "22023", () =>
        apply([{ op: "link", link_key: "h3:new", patient_id: fx.patientPId }]),
      );
      await finish(lease.token);
    });

    // 22. A stale lease is dead even before a takeover (review round 3, 2 + d) --
    await check("A stale lease cannot write; a takeover clears its staging", async () => {
      await setRole("service_role", null);
      const a = await acquire("manual", false);
      await q(`select public.sheet_mirror_stage($1::uuid, 'lab', '[{"sheet_row":1}]'::jsonb)`, [a.token]);
      await q(`update public.sheet_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`, [a.runId]);
      const calls: [string, string, unknown[]][] = [
        ["stage", `select public.sheet_mirror_stage($1::uuid, 'lab', '[]'::jsonb)`, [a.token]],
        ["ops", `select public.sheet_sync_apply_customer_ops($1::uuid, '[]'::jsonb)`, [a.token]],
        ["heartbeat", `select public.sheet_sync_heartbeat($1::uuid)`, [a.token]],
        ["finish", `select public.sheet_sync_finish($1::uuid, 'succeeded', '{}'::jsonb, '{}'::jsonb, null)`, [a.token]],
      ];
      for (const [label, sql, params] of calls) {
        await expectPgError(`stale lease ${label}`, "P0063", () => q(sql, params));
      }
      const stagedBefore = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_mirror_staging where run_id = $1`,
        [a.runId],
      );
      assert(stagedBefore.rows[0].n === "1", `stale run: expected its 1 staged row still there, got ${stagedBefore.rows[0].n}`);
      const b = await acquire("cli", false);
      assert(b.status === "running", `takeover: expected running, got ${b.status}`);
      const stagedAfter = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_mirror_staging where run_id = $1`,
        [a.runId],
      );
      assert(stagedAfter.rows[0].n === "0", `takeover: the dead run's staged rows must be gone, got ${stagedAfter.rows[0].n}`);
      await finish(b.token);
    });

    // 23. An undo sticks (review round 3, finding 1 + minor c) -----------------
    await check("Undo holds the auto links of a restored patient; a kept patient keeps its links", async () => {
      await setRole("postgres", null);
      const qp = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Quino', 'Undo', '1980-01-01') returning id`,
      );
      const qId = qp.rows[0].id;
      await setRole("service_role", null);
      const apply = (token: string, ops: unknown[]) =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [token, JSON.stringify(ops)]);

      // Run 1 links the key; run 2 fills through it (no link op of its own).
      const r1 = await acquire("manual", false);
      await apply(r1.token, [{ op: "link", link_key: "u1:auto", patient_id: qId, method: "auto_exact" }]);
      await finish(r1.token);
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_patient_links (link_key, patient_id, decision, method) values ('u1:admin', $1, 'link', 'admin')`,
        [qId],
      );
      await setRole("service_role", null);
      const r2 = await acquire("manual", false);
      const f = await apply(r2.token, [{ op: "fill", patient_id: qId, fields: { email: "quino@example.test" } }]);
      assert(f.rows[0].j.counts.filled === 1, `run 2: expected filled=1, got ${JSON.stringify(f.rows[0].j.counts)}`);
      await finish(r2.token);

      const rv = await acquire("revert", false);
      const u = await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [rv.token, r2.runId]);
      assert(
        u.rows[0].j.restored === 1 && u.rows[0].j.held === 1,
        `undo run 2: expected restored=1 held=1, got ${JSON.stringify(u.rows[0].j)}`,
      );
      await finish(rv.token);
      const links = await q<{ link_key: string; decision: string; patient_id: string | null; run_id: string | null; hold_reason: string | null }>(
        `select link_key, decision, patient_id::text as patient_id, run_id::text as run_id, hold_reason
           from public.sheet_patient_links where link_key like 'u1:%' order by link_key`,
      );
      const byKey = Object.fromEntries(links.rows.map((x) => [x.link_key, x]));
      assert(
        byKey["u1:auto"].decision === "review" && byKey["u1:auto"].patient_id === null &&
          byKey["u1:auto"].run_id === rv.runId && byKey["u1:auto"].hold_reason === "undone by an admin",
        `undo: the earlier run's auto link to the restored patient must be held, got ${JSON.stringify(byKey["u1:auto"])}`,
      );
      assert(
        byKey["u1:admin"].decision === "link" && byKey["u1:admin"].patient_id === qId,
        `undo: an admin link is left alone, got ${JSON.stringify(byKey["u1:admin"])}`,
      );

      // The next run cannot re-link the held key (the SQL half of "no re-fill").
      const r3 = await acquire("manual", false);
      const again = await apply(r3.token, [{ op: "link", link_key: "u1:auto", patient_id: qId, method: "auto_exact" }]);
      assert(again.rows[0].j.counts.skipped === 1, `next run: the held key must not re-link, got ${JSON.stringify(again.rows[0].j.counts)}`);
      await finish(r3.token);

      // A created patient the undo must keep (changed since) keeps its links.
      const r4 = await acquire("manual", false);
      const c = await apply(r4.token, [
        {
          op: "create", create_key: "u1k", method: "auto_exact",
          fields: { first_name: "Kira", last_name: "Kept", middle_name: null },
          link_keys: ["u1:kept"], admin_link_keys: [], legacy_intake: {},
          facts: { registered_on: null, new_repeat: null, source_ref: "u1k" },
        },
      ]);
      const kId = c.rows[0].j.created.u1k;
      await finish(r4.token);
      await setRole("postgres", null);
      await q(`update public.patients set address = 'Touched by reception' where id = $1`, [kId]);
      await setRole("service_role", null);
      const rv2 = await acquire("revert", false);
      const u2 = await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [rv2.token, r4.runId]);
      assert(
        u2.rows[0].j.kept === 1 && u2.rows[0].j.deleted === 0 && u2.rows[0].j.held === 0,
        `undo of a changed create: expected kept=1 deleted=0 held=0, got ${JSON.stringify(u2.rows[0].j)}`,
      );
      await finish(rv2.token);
      const kept = await q<{ decision: string; patient_id: string | null }>(
        `select decision, patient_id::text as patient_id from public.sheet_patient_links where link_key = 'u1:kept'`,
      );
      assert(
        kept.rows[0].decision === "link" && kept.rows[0].patient_id === kId,
        `a kept patient keeps its link, got ${JSON.stringify(kept.rows[0])}`,
      );

      // A patient whose restore is BLOCKED (changed since) keeps the run's
      // own link too: its filled values stay, so its sheet rows stay linked.
      await setRole("postgres", null);
      const bp = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Blas', 'Blocked', '1981-01-01') returning id`,
      );
      const bId = bp.rows[0].id;
      await setRole("service_role", null);
      const r5 = await acquire("manual", false);
      await apply(r5.token, [
        { op: "link", link_key: "u1:blocked", patient_id: bId, method: "auto_exact" },
        { op: "fill", patient_id: bId, fields: { email: "blas@example.test" } },
      ]);
      await finish(r5.token);
      await setRole("postgres", null);
      await q(`update public.patients set address = 'Touched by reception' where id = $1`, [bId]);
      await setRole("service_role", null);
      const rv3 = await acquire("revert", false);
      const u3 = await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [rv3.token, r5.runId]);
      assert(
        u3.rows[0].j.blocked === 1 && u3.rows[0].j.held === 0 && u3.rows[0].j.links_left === 1,
        `undo with a blocked restore: expected blocked=1 held=0 links_left=1, got ${JSON.stringify(u3.rows[0].j)}`,
      );
      await finish(rv3.token);
      const bl = await q<{ decision: string; patient_id: string | null }>(
        `select decision, patient_id::text as patient_id from public.sheet_patient_links where link_key = 'u1:blocked'`,
      );
      assert(
        bl.rows[0].decision === "link" && bl.rows[0].patient_id === bId,
        `a blocked patient keeps the run's link, got ${JSON.stringify(bl.rows[0])}`,
      );
    });

    // 23b. Undo must never cascade-delete a consent (patient_consents.patient_id
    //      is ON DELETE CASCADE — the only such child of patients) -----------
    await check("Undo of a create keeps a patient that carries a consent record", async () => {
      await setRole("service_role", null);
      const apply = (token: string, ops: unknown[]) =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [token, JSON.stringify(ops)]);
      const r = await acquire("manual", false);
      const c = await apply(r.token, [{
        op: "create", create_key: "cst1", method: "auto_exact",
        fields: { first_name: "Nora", last_name: "Consented", middle_name: null },
        link_keys: ["cst:1"], admin_link_keys: [], legacy_intake: {},
        facts: { registered_on: null, new_repeat: null, source_ref: "cst1" },
      }]);
      const cId = c.rows[0].j.created.cst1;
      await finish(r.token);
      await setRole("postgres", null);
      await q(
        `insert into public.patient_consents (patient_id, event_type, actor_kind, method, notice_version, signatory)
         values ($1, 'granted', 'staff', 'paper_wet_signature', 'v1', 'self')`,
        [cId],
      );
      // trg_patient_consents_sync (AFTER INSERT on patient_consents) already
      // UPDATEs patients (consent_current etc.), which on its own bumps
      // row_version past 0 and would trip the EARLIER "changed since" kept
      // branch — this guard would never be reached in the app's normal flow.
      // Force row_version back to 0 (bypassing the ownership trigger, which
      // would otherwise just bump whatever this UPDATE sets it to) so this
      // check proves the NEW guard itself holds, independent of that other
      // trigger continuing to exist.
      await q(`alter table public.patients disable trigger trg_patients_referral_origin`);
      await q(`update public.patients set row_version = 0 where id = $1`, [cId]);
      await q(`alter table public.patients enable trigger trg_patients_referral_origin`);
      const forced = await q<{ rv: string }>(`select row_version::text as rv from public.patients where id = $1`, [cId]);
      assert(forced.rows[0].rv === "0", `setup: expected row_version forced back to 0, got ${forced.rows[0].rv}`);
      await setRole("service_role", null);
      const rv = await acquire("revert", false);
      const u = await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [rv.token, r.runId]);
      assert(
        u.rows[0].j.kept === 1 && u.rows[0].j.deleted === 0,
        `undo of a create with a consent: expected kept=1 deleted=0 (not cascade-deleted), got ${JSON.stringify(u.rows[0].j)}`,
      );
      await finish(rv.token);
      const stillThere = await q<{ n: string }>(`select count(*)::text as n from public.patients where id = $1`, [cId]);
      assert(stillThere.rows[0].n === "1", `the patient must survive the undo, got ${stillThere.rows[0].n} rows`);
      const consentStillThere = await q<{ n: string }>(`select count(*)::text as n from public.patient_consents where patient_id = $1`, [cId]);
      assert(consentStillThere.rows[0].n === "1", `the consent record must survive, got ${consentStillThere.rows[0].n} rows`);
      const link = await q<{ decision: string }>(`select decision from public.sheet_patient_links where link_key = 'cst:1'`);
      assert(link.rows[0].decision === "link", `the create's link is left alone (kept, not held), got ${JSON.stringify(link.rows[0])}`);
    });

    // 24. Undoing a map-answer run takes back its alias (review round 3, 1) ----
    await check("Undo of a map-answer run removes the alias it added and restores one it replaced", async () => {
      await setRole("service_role", null);
      const a1 = await acquire("alias", false);
      await q(`select public.sheet_alias_apply($1::uuid, 'u1b answer', 'flyers', null)`, [a1.token]);
      await finish(a1.token);
      const mid = await q<{ src: string; run_id: string | null; replaced: Json }>(
        `select referral_source_id as src, run_id::text as run_id, replaced from public.referral_source_aliases where raw_normalized = 'u1b answer'`,
      );
      assert(
        mid.rows[0]?.src === "flyers" && mid.rows[0].run_id === a1.runId && mid.rows[0].replaced === null,
        `alias apply: expected a new alias stamped with its run, got ${JSON.stringify(mid.rows[0])}`,
      );
      const rv = await acquire("revert", false);
      const u = await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [rv.token, a1.runId]);
      assert(u.rows[0].j.alias_removed === 1, `undo alias run: expected alias_removed=1, got ${JSON.stringify(u.rows[0].j)}`);
      await finish(rv.token);
      const gone = await q<{ n: string }>(
        `select count(*)::text as n from public.referral_source_aliases where raw_normalized = 'u1b answer'`,
      );
      assert(gone.rows[0].n === "0", `undo alias run: the alias it added must be gone, found ${gone.rows[0].n}`);

      // Replacing an existing alias twice in one run, then undoing: the
      // pre-run alias comes back exactly.
      const a2 = await acquire("alias", false);
      await q(`select public.sheet_alias_apply($1::uuid, 'probe-alias-1', 'walk_in', null)`, [a2.token]);
      await q(`select public.sheet_alias_apply($1::uuid, 'probe-alias-1', 'flyers', null)`, [a2.token]);
      await finish(a2.token);
      const rv2 = await acquire("revert", false);
      const u2 = await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [rv2.token, a2.runId]);
      assert(u2.rows[0].j.alias_restored === 1, `undo alias run 2: expected alias_restored=1, got ${JSON.stringify(u2.rows[0].j)}`);
      await finish(rv2.token);
      const back = await q<{ src: string; run_id: string | null; replaced: Json }>(
        `select referral_source_id as src, run_id::text as run_id, replaced from public.referral_source_aliases where raw_normalized = 'probe-alias-1'`,
      );
      assert(
        back.rows[0].src === "other" && back.rows[0].run_id === null && back.rows[0].replaced === null,
        `undo alias run 2: expected the pre-run alias (other, no run), got ${JSON.stringify(back.rows[0])}`,
      );

      // Two runs map the same answer; undo them in either order. Either way
      // the answer ends unmapped — an undone mapping never comes back.
      const aliasRun = async (raw: string, src: string) => {
        const l = await acquire("alias", false);
        await q(`select public.sheet_alias_apply($1::uuid, $2, $3, null)`, [l.token, raw, src]);
        await finish(l.token);
        return l.runId;
      };
      const undo = async (runId: string) => {
        const l = await acquire("revert", false);
        const j = (await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [l.token, runId])).rows[0].j;
        await finish(l.token);
        return j;
      };
      const aliasOf = async (raw: string) =>
        (await q<{ src: string }>(`select referral_source_id as src from public.referral_source_aliases where raw_normalized = $1`, [raw])).rows[0]?.src ?? null;
      for (const [raw, firstUndo] of [["u1c answer", "older"], ["u1d answer", "newer"]] as const) {
        const older = await aliasRun(raw, "flyers");
        const newer = await aliasRun(raw, "walk_in");
        if (firstUndo === "older") {
          await undo(older);
          const mid2 = await aliasOf(raw);
          assert(mid2 === "walk_in", `${raw}: undoing the older run must leave the newer mapping, got ${mid2}`);
          await undo(newer);
        } else {
          await undo(newer);
          const mid2 = await aliasOf(raw);
          assert(mid2 === "flyers", `${raw}: undoing the newer run must bring back the older mapping, got ${mid2}`);
          await undo(older);
        }
        const end = await aliasOf(raw);
        assert(end === null, `${raw} (older run undone ${firstUndo === "older" ? "first" : "last"}): expected no alias left, got ${end}`);
      }
    });

    // 25. Map answer follows the fill's own channel rule (review round 3, 5) ---
    await check("Map answer moves only patients whose earliest answered row carries it", async () => {
      await setRole("postgres", null);
      const ps = await q<{ id: string; first_name: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values
           ('Zeta1', 'Earliest', '1971-01-01'), ('Zeta2', 'Earliest', '1972-01-01'),
           ('Zeta3', 'Earliest', '1973-01-01'), ('Zeta4', 'Earliest', '1974-01-01'),
           ('Zeta5', 'Earliest', '1975-01-01')
         returning id, first_name`,
      );
      const z = Object.fromEntries(ps.rows.map((r) => [r.first_name, r.id]));
      const seedRun = (await q<{ id: string }>(`select id from public.sheet_sync_runs order by started_at, id limit 1`)).rows[0].id;
      const rows: [string, string, string | null, string][] = [
        // Zeta1: earliest answered row says "f5 first" → not moved
        ["Zeta1", "f5-z1a", "2026-01-01", "f5 first"], ["Zeta1", "f5-z1b", "2026-02-01", "f5 later"],
        // Zeta2: its only row → moved
        ["Zeta2", "f5-z2a", "2026-02-01", "f5 later"],
        // Zeta3: the dated row is blank (no answer); the undated one answers → moved
        ["Zeta3", "f5-z3a", null, "f5 later"], ["Zeta3", "f5-z3b", "2026-01-01", ""],
        // Zeta4: same day, source_key breaks the tie (f5-z4a first) → moved
        ["Zeta4", "f5-z4b", "2026-01-05", "f5 other"], ["Zeta4", "f5-z4a", "2026-01-05", "f5 later"],
        // Zeta5: the undated row answers "f5 later", but undated rows sort LAST,
        // so the dated "f5 other" row is the earliest answer → not moved
        ["Zeta5", "f5-z5a", null, "f5 later"], ["Zeta5", "f5-z5b", "2026-03-01", "f5 other"],
      ];
      let i = 0;
      for (const [who, key, reg, norm] of rows) {
        await q(
          `insert into public.sheet_customer_rows
             (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, registered_on, source_norm,
              patient_id, link_state, row_hash, run_id)
           values ($1, $2, 'Earliest, Zeta', 'earliest|zeta', 'earliestzeta', $3, $4::date, $5, $6, 'linked', $2, $7)`,
          [9000 + i++, key, `f5:${who}`, reg, norm, z[who], seedRun],
        );
      }
      await setRole("service_role", null);
      const a = await acquire("alias", false);
      const n = await q<{ n: number }>(`select public.sheet_alias_apply($1::uuid, 'f5 later', 'flyers', null) as n`, [a.token]);
      await finish(a.token);
      assert(n.rows[0].n === 3, `map answer: expected 3 patients moved (Zeta2, Zeta3, Zeta4), got ${n.rows[0].n}`);
      const got = await q<{ first_name: string; src: string | null }>(
        `select first_name, referral_source as src from public.patients where last_name = 'Earliest' order by first_name`,
      );
      assert(
        JSON.stringify(got.rows.map((r) => r.src)) === JSON.stringify([null, "flyers", "flyers", "flyers", null]),
        `map answer: expected [null, flyers, flyers, flyers, null], got ${JSON.stringify(got.rows)}`,
      );
    });

    // 25b. Map answer is fenced to its review item (Codex P2: two admins
    //      racing to map the same answer) -----------------------------------
    await check("Map answer refuses a second call against an already-handled review item", async () => {
      await setRole("postgres", null);
      const item = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, status)
         values ('customers', 'race answer', 'unmapped_source', 'open') returning id::text`,
      );
      const itemId = item.rows[0].id;
      await setRole("service_role", null);
      const a1 = await acquire("alias", false);
      await expectOk("first admin maps the answer", () =>
        q(`select public.sheet_alias_apply($1::uuid, 'race answer', 'flyers', null, $2::uuid)`, [a1.token, itemId]));
      await finish(a1.token);
      const resolved = await q<{ status: string }>(`select status from public.sheet_sync_review_items where id = $1`, [itemId]);
      assert(resolved.rows[0].status === "resolved", `first call: expected the item resolved, got ${resolved.rows[0].status}`);

      // A second admin's call raced in with the SAME (now stale) item id —
      // the RPC itself refuses, atomically with its own lease/write, instead
      // of silently overwriting the first admin's channel choice.
      const a2 = await acquire("alias", false);
      await expectPgError("second admin races the same item", "P0064", () =>
        q(`select public.sheet_alias_apply($1::uuid, 'race answer', 'walk_in', null, $2::uuid)`, [a2.token, itemId]));
      await finish(a2.token);
      const still = await q<{ resolution: Json }>(`select resolution from public.sheet_sync_review_items where id = $1`, [itemId]);
      assert(
        still.rows[0].resolution?.referral_source_id === "flyers",
        `after the race: the first admin's channel must stand, got ${JSON.stringify(still.rows[0].resolution)}`,
      );

      // A mismatched item (wrong item_key) is refused the same way.
      const other = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, status)
         values ('customers', 'a different answer', 'unmapped_source', 'open') returning id::text`,
      );
      const a3 = await acquire("alias", false);
      await expectPgError("item_key does not match the answer", "P0064", () =>
        q(`select public.sheet_alias_apply($1::uuid, 'race answer', 'walk_in', null, $2::uuid)`, [a3.token, other.rows[0].id]));
      await finish(a3.token);

      // p_item_id null keeps the old (no-fencing) behaviour, e.g. for a
      // caller with no review item in hand.
      const a4 = await acquire("alias", false);
      await expectOk("no item id: unfenced, as before", () =>
        q(`select public.sheet_alias_apply($1::uuid, 'no item id answer', 'flyers', null)`, [a4.token]));
      await finish(a4.token);
    });

    // 26. An undo run cannot itself be undone (review round 3, minor b) --------
    await check("An undo cannot itself be undone", async () => {
      await setRole("service_role", null);
      const r = await acquire("manual", false);
      await finish(r.token);
      const rv = await acquire("revert", false);
      await q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid)`, [rv.token, r.runId]);
      await finish(rv.token);
      const rv2 = await acquire("revert", false);
      await expectPgError("undo of an undo", "22023", () =>
        q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid)`, [rv2.token, rv.runId]),
      );
      await finish(rv2.token);
    });

    // 27. A hold is never hidden by a dismiss (review round 3, minor e) --------
    await check("Dismiss: refused on an evidence hold, allowed as keep-undone on an undo hold; re-open rules", async () => {
      await setRole("postgres", null);
      await q(`insert into public.sheet_patient_links (link_key, decision, method) values ('e:held', 'review', 'auto_exact')`);
      const items = await q<{ id: string; item_key: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload, status) values
           ('customers', 'e:held', 'identity_conflict', '{"link_keys":["e:held"]}'::jsonb, 'open'),
           ('customers', 'e:free', 'ambiguous_patient', '{"link_keys":["e:free"]}'::jsonb, 'open'),
           ('customers', 'e:row', 'invalid_row', '{}'::jsonb, 'dismissed')
         returning id, item_key`,
      );
      const id = Object.fromEntries(items.rows.map((r) => [r.item_key, r.id]));
      await setRole("service_role", null);
      await expectPgError("dismiss a held item", "22023", () =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'dismiss', null)`, [id["e:held"], fx.adminId]),
      );
      await expectOk("dismiss an item with no hold", () =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'dismiss', null)`, [id["e:free"], fx.adminId]),
      );
      // Later a run holds e:free and reports it again: the item re-opens.
      // e:row (dismissed, no keys) stays dismissed.
      await setRole("postgres", null);
      await q(`insert into public.sheet_patient_links (link_key, decision, method) values ('e:free', 'review', 'auto_exact')`);
      await setRole("service_role", null);
      const lease = await acquire("manual", false);
      const up = await q<{ j: Json }>(`select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`, [
        lease.token,
        JSON.stringify([
          { kind: "ambiguous_patient", item_key: "e:free", payload: { link_keys: ["e:free"] } },
          { kind: "invalid_row", item_key: "e:row", payload: {} },
        ]),
      ]);
      await finish(lease.token);
      assert(
        up.rows[0].j.opened === 1 && up.rows[0].j.updated === 0,
        `upsert: expected only the held item re-opened, got ${JSON.stringify(up.rows[0].j)}`,
      );
      const open = await q<{ item_key: string }>(
        `select item_key from public.sheet_sync_review_items where item_key in ('e:free','e:row') and status = 'open'`,
      );
      assert(
        open.rows.length === 1 && open.rows[0].item_key === "e:free",
        `upsert: expected e:free open again and e:row still dismissed, got ${JSON.stringify(open.rows)}`,
      );

      // An item held only by an UNDO may be dismissed: "keep it undone". The
      // hold stays, and later runs do not re-open it — even under another
      // identity kind — until its CANDIDATES change (a new matching patient:
      // the planner never re-holds an undo-held key, so nothing else moves).
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_patient_links (link_key, decision, method, hold_reason)
         values ('e:undone', 'review', 'auto_exact', 'undone by an admin')`,
      );
      const u = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload)
         values ('customers', 'e:undone', 'ambiguous_patient', $1::jsonb) returning id`,
        [JSON.stringify({ link_keys: ["e:undone"], candidates: [{ patient_id: fx.patientPId }] })],
      );
      await setRole("service_role", null);
      await expectOk("dismiss an undo-held item (keep undone)", () =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'dismiss', null)`, [u.rows[0].id, fx.adminId]),
      );
      const res = await q<{ status: string; keep: boolean | null; decision: string }>(
        `select i.status, (i.resolution->>'keep_undone')::boolean as keep, l.decision
           from public.sheet_sync_review_items i join public.sheet_patient_links l on l.link_key = i.item_key
          where i.id = $1`,
        [u.rows[0].id],
      );
      assert(
        res.rows[0].status === "dismissed" && res.rows[0].keep === true && res.rows[0].decision === "review",
        `keep undone: expected dismissed, keep_undone, hold kept, got ${JSON.stringify(res.rows[0])}`,
      );
      // The planner-shaped item for this key: resolveHeld keeps the kind it
      // computes and lists its candidates (customer-plan.test.ts proves the
      // candidate set grows when a matching patient is registered).
      const report = (kind: string, candidates: string[]) => JSON.stringify([{ kind, item_key: "e:undone",
        payload: { link_keys: ["e:undone"], candidates: candidates.map((id) => ({ patient_id: id })), reason: "held for an admin decision",
          held_because: "undone by an admin" } }]);
      const upsert = async (kind: string, candidates: string[]) => {
        const l = await acquire("manual", false);
        const j = (await q<{ j: Json }>(`select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`, [
          l.token, report(kind, candidates)])).rows[0].j;
        await finish(l.token);
        return j;
      };
      const same = await upsert("identity_conflict", [fx.patientPId]);
      assert(
        same.opened === 0 && same.updated === 0,
        `keep undone: a later run with the same candidates (another identity kind) must not re-open it, got ${JSON.stringify(same)}`,
      );
      // Staff register the real patient: a new candidate appears.
      await setRole("postgres", null);
      const nb = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Newly', 'Registered', '1985-05-05') returning id`,
      );
      await setRole("service_role", null);
      const moved = await upsert("possible_existing_patient", [fx.patientPId, nb.rows[0].id]);
      assert(moved.opened === 1, `new candidates must re-open a keep-undone item, got ${JSON.stringify(moved)}`);
      const reopened = await q<{ id: string }>(
        `select id from public.sheet_sync_review_items where item_key = 'e:undone' and status = 'open'`,
      );
      assert(reopened.rows.length === 1, `expected one open e:undone item, got ${reopened.rows.length}`);
      await expectOk("keep undone again on the re-opened item", () =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'dismiss', null)`, [reopened.rows[0].id, fx.adminId]),
      );
      const again = await upsert("possible_existing_patient", [nb.rows[0].id, fx.patientPId]);
      assert(again.opened === 0 && again.updated === 0,
        `kept undone again with the same (reordered) candidates: expected no re-open, got ${JSON.stringify(again)}`);
    });

    // 28. Resolve never waits on the lease lock (review round 5, 6 + 7) -------
    // A second connection, outside this script's transaction. That
    // transaction has held the lease advisory lock since its first acquire
    // (xact locks last until the rollback at the end), so a resolve from the
    // other connection must answer "busy" at once instead of queueing until
    // lock_timeout. It writes nothing: it raises before reading the item.
    // (The running-row NOWAIT half cannot be shown this way: rows this
    // transaction inserted are invisible to another connection, and this
    // script never commits anything.)
    await check("Resolve answers busy at once while the lease lock is held (second connection)", async () => {
      const other = new Client({ connectionString: DB_URL });
      await other.connect();
      try {
        const got = await other.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext('sheet_sync_lease')) as ok`);
        assert(got.rows[0].ok === false, "precondition: this script's transaction should hold the lease lock");
        await other.query(`set lock_timeout = '2s'`);
        await other.query(`set role service_role`);
        const t0 = performance.now();
        let code: string | undefined;
        try {
          await other.query(`select public.sheet_review_resolve(gen_random_uuid(), null, 'dismiss', null)`);
        } catch (err) {
          code = (err as Error & { code?: string }).code;
        }
        const ms = Math.round(performance.now() - t0);
        assert(code === "P0062", `resolve beside a held lease lock: expected P0062, got ${code ?? "success"} after ${ms} ms`);
        assert(ms < 1000, `resolve must not wait for the lease lock (took ${ms} ms)`);
      } finally {
        await other.end();
      }
    });

    // 29. A paused acquire still sweeps a dead run's staging (review round 5, 8)
    await check("A paused acquire sweeps a dead run's staged rows without taking over (a live run's survive)", async () => {
      await setRole("service_role", null);
      // A LIVE run's staged rows survive a paused acquire's sweep.
      const live = await acquire("manual", false);
      await q(`select public.sheet_mirror_stage($1::uuid, 'lab', '[{"sheet_row":1},{"sheet_row":2}]'::jsonb)`, [live.token]);
      await setRole("postgres", null);
      await q(`update public.sheet_sync_settings set paused = true where id`);
      await setRole("service_role", null);
      const p0 = await acquire("cron", false);
      assert(p0.status === "skipped_paused", `paused cron beside a live run: expected skipped_paused, got ${p0.status}`);
      const kept = await q<{ n: string }>(`select count(*)::text as n from public.sheet_mirror_staging where run_id = $1`, [live.runId]);
      assert(kept.rows[0].n === "2", `a live run's staged rows must survive the sweep, got ${kept.rows[0].n}`);
      await finish(live.token);
      await setRole("postgres", null);
      await q(`update public.sheet_sync_settings set paused = false where id`);
      await setRole("service_role", null);

      const a = await acquire("manual", false);
      await q(`select public.sheet_mirror_stage($1::uuid, 'lab', '[{"sheet_row":1}]'::jsonb)`, [a.token]);
      await q(`update public.sheet_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`, [a.runId]);
      await setRole("postgres", null);
      await q(`update public.sheet_sync_settings set paused = true where id`);
      await setRole("service_role", null);
      const p = await acquire("cron", false);
      assert(p.status === "skipped_paused", `paused cron: expected skipped_paused, got ${p.status}`);
      const staged = await q<{ n: string }>(`select count(*)::text as n from public.sheet_mirror_staging where run_id = $1`, [a.runId]);
      assert(staged.rows[0].n === "0", `paused acquire: the dead run's staged rows must be gone, got ${staged.rows[0].n}`);
      const st = await q<{ status: string }>(`select status from public.sheet_sync_runs where id = $1`, [a.runId]);
      assert(st.rows[0].status === "running", `paused acquire must not take the lease over, got ${st.rows[0].status}`);
      await setRole("postgres", null);
      await q(`update public.sheet_sync_settings set paused = false where id`);
      await setRole("service_role", null);
      const b = await acquire("manual", false);
      assert(b.status === "running", `takeover after unpause: expected running, got ${b.status}`);
      await finish(b.token);
    });

    // 30. A paged undo resumes and finishes exactly once (review round 5, 3) --
    await check("Paged undo: each call resumes where the last stopped; only the last one finishes the run", async () => {
      await setRole("postgres", null);
      const ps = (await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate)
         select 'Page ' || g, 'Paged', date '1950-01-01' + g from generate_series(1, 3) g returning id`,
      )).rows.map((r) => r.id);
      await setRole("service_role", null);
      const r = await acquire("manual", false);
      await q(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb)`, [r.token, JSON.stringify([
        ...ps.map((id, i) => ({ op: "link", link_key: `pg:link-${i}`, patient_id: id, method: "auto_exact" })),
        ...ps.map((id) => ({ op: "fill", patient_id: id, fields: { email: `${id}@example.test` } })),
        ...[0, 1].map((i) => ({ op: "create", create_key: `pg-new-${i}`, method: "auto_exact",
          fields: { first_name: `New ${i}`, last_name: "Paged", middle_name: null }, link_keys: [`pg:new-${i}`],
          admin_link_keys: [], legacy_intake: {}, facts: { registered_on: null, new_repeat: null, source_ref: `pg${i}` } })),
      ])]);
      await finish(r.token);
      const rv = await acquire("revert", false);
      await expectPgError("undo page size 0", "22023", () =>
        q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid, 0)`, [rv.token, r.runId]));
      const page = async () =>
        (await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid, 2) as j`, [rv.token, r.runId])).rows[0].j;
      const stamped = async () =>
        (await q<{ by: string | null }>(`select reverted_by_run_id::text as by from public.sheet_sync_runs where id = $1`, [r.runId])).rows[0].by;
      const p1 = await page();
      assert(p1.done === false && p1.restored === 2 && p1.deleted === 0, `page 1: expected 2 restored, not done, got ${JSON.stringify(p1)}`);
      assert((await stamped()) === null, "page 1: the run must not be marked undone yet");

      // Between pages: staff edit the one patient page 1 did not reach, and
      // the undo worker dies (no heartbeat for 11 minutes); a new undo run
      // takes the lease over and resumes.
      const left = await q<{ pid: string }>(
        `select distinct patient_id::text as pid from public.sheet_sync_changes
          where run_id = $1 and change_kind = 'update' and undo_outcome is null`, [r.runId]);
      assert(left.rows.length === 1, `after page 1: expected one fill left, got ${left.rows.length}`);
      await setRole("postgres", null);
      await q(`update public.patients set address = 'Edited between pages' where id = $1`, [left.rows[0].pid]);
      await setRole("service_role", null);
      await q(`update public.sheet_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`, [rv.runId]);
      const rv2 = await acquire("revert", false);
      await expectPgError("the dead undo worker cannot write a page", "P0063", () => page());
      const page2 = async () =>
        (await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid, 2) as j`, [rv2.token, r.runId])).rows[0].j;
      const p2 = await page2();
      assert(p2.done === false && p2.restored === 0 && p2.blocked === 1 && p2.deleted === 1,
        `page 2 (new undo run): expected the edited patient blocked + 1 deleted, not done, got ${JSON.stringify(p2)}`);
      // Staff remove the last created patient before the undo reaches it:
      // the page still makes progress, reported as gone.
      const lastNew = await q<{ pid: string }>(
        `select patient_id::text as pid from public.sheet_sync_changes
          where run_id = $1 and change_kind = 'create' and undo_outcome is null`, [r.runId]);
      assert(lastNew.rows.length === 1, `after page 2: expected one create left, got ${lastNew.rows.length}`);
      await setRole("postgres", null);
      await q(`delete from public.patients where id = $1`, [lastNew.rows[0].pid]);
      await setRole("service_role", null);
      const p3 = await page2();
      assert(p3.done === true && p3.restored === 0 && p3.deleted === 0 && p3.gone === 1 && p3.links_left === 1,
        `page 3: expected the removed patient counted gone, done, and the blocked patient's link left, got ${JSON.stringify(p3)}`);
      assert((await stamped()) === rv2.runId, "page 3: the run must now be marked undone by the undo run that finished it");
      const held = [p1, p2, p3].reduce((n, p) => n + p.held, 0);
      assert(held === 3, `paged undo: expected 3 holds (2 restored patients + 1 deleted; the blocked patient keeps its link), got ${held}`);
      // Nothing applied twice; every change row names the undo run that decided it.
      const trace = await q<{ outcome: string; by: string; n: string }>(
        `select undo_outcome as outcome, undo_run_id::text as by, count(*)::text as n from public.sheet_sync_changes
          where run_id = $1 group by 1, 2 order by 1, 2`, [r.runId]);
      const want = [["blocked", rv2.runId, "1"], ["deleted", rv2.runId, "1"], ["gone", rv2.runId, "1"], ["restored", rv.runId, "2"]]
        .sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1));
      assert(JSON.stringify(trace.rows.map((t) => [t.outcome, t.by, t.n])) === JSON.stringify(want),
        `traceability: expected ${JSON.stringify(want)}, got ${JSON.stringify(trace.rows)}`);
      await expectPgError("a page after done", "22023", () => page2());
      await finish(rv2.token);
    });

    // 31. Undo of a first-catch-up-sized run under the PostgREST limits -------
    // statement_timeout (and lock_timeout) is 8 s for `authenticator`, which
    // service_role inherits. The first real run creates/fills ~8k patients;
    // this one fills 8,000 AND creates 8,000, then undoes all of it in ONE
    // call, with every call below under `set local statement_timeout = '8s'`.
    await check("Timing: 8,000 fills + 8,000 creates in 500-op chunks, full-size mirror commits, a paged undo (statement_timeout 8 s)", async () => {
      const N = 8000;
      const CHUNK = 500;
      const LIMIT_MS = 8000;
      await setRole("postgres", null);
      const ids = (
        await q<{ id: string }>(
          `insert into public.patients (first_name, last_name, birthdate)
           select 'Fill ' || g, 'Timing8k', date '1960-01-01' + g from generate_series(1, ${N}) g
           returning id`,
        )
      ).rows.map((r) => r.id);
      await setRole("service_role", null);
      const apply = (token: string, ops: unknown[]) =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [token, JSON.stringify(ops)]);
      const r0 = await acquire("manual", false);
      for (let i = 0; i < N; i += CHUNK) {
        await apply(r0.token, ids.slice(i, i + CHUNK).map((id, j) => ({
          op: "link", link_key: `t8k-link-${i + j}`, patient_id: id, method: "auto_exact" })));
      }
      await finish(r0.token);

      const timings: [string, number][] = [];
      async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const t0 = performance.now();
        const out = await fn();
        timings.push([label, Math.round(performance.now() - t0)]);
        return out;
      }
      await q(`set local statement_timeout = '8s'`);
      try {
        const r1 = await acquire("manual", false);
        for (let i = 0; i < N; i += CHUNK) {
          await timed(`fill chunk ${i / CHUNK + 1}`, () => apply(r1.token, ids.slice(i, i + CHUNK).map((id, j) => ({
            op: "fill", patient_id: id,
            fields: { phone: `+6391700${String(i + j).padStart(5, "0")}`, email: `t8k${i + j}@example.test`, address: "Timing Town" } }))));
        }
        for (let i = 0; i < N; i += CHUNK) {
          await timed(`create chunk ${i / CHUNK + 1}`, () => apply(r1.token, Array.from({ length: CHUNK }, (_, j) => ({
            op: "create", create_key: `t8k-new-${i + j}`, method: "auto_exact",
            fields: { first_name: `New ${i + j}`, last_name: "Timing8k", middle_name: null, sex: "female",
              phone: `+6391800${String(i + j).padStart(5, "0")}`, referral_source: "online_facebook" },
            link_keys: [`t8k-new-${i + j}`], admin_link_keys: [], legacy_intake: { source: "sheet_sync:CUSTOMER LIST2" },
            facts: { registered_on: "2026-06-01", new_repeat: "new", source_ref: `t8k-${i + j}` } }))));
        }
        // Full-size mirror commits: each commit is ONE statement over a whole
        // tab (delete + insert of every staged row), so staging in chunks does
        // not protect it. Customers ~8k (the sheet has ~4.9k named rows); lab
        // at the WHOLE tab, 21,504 rows (the mirror window normally keeps
        // ~3k of them).
        const cust = (i: number) => ({
          sheet_row: i + 2, source_key: `t8k-src-${i}`, dup_count: 1, full_name_raw: `Timing8k, Person ${i}`,
          name_norm: `timing8k|person ${i}`, loose_key: `timing8kperson${i}`, link_key: `t8k-new-${i}`, phone_norm: "9171234567",
          dob: "1990-01-01", registered_on: "2026-06-01", source_raw: "Facebook", source_norm: "facebook",
          referral_source_id: "online_facebook", referred_by_raw: null, new_repeat: "new", release_medium_raw: "Email",
          patient_id: null, link_state: "unlinked", row_hash: `t8k-hash-${i}`,
        });
        const lab = (i: number) => ({
          sheet_row: i + 3, service_date: "2026-06-01", name_raw: `Timing8k, Person ${i}`, name_norm: `timing8k|person ${i}`,
          loose_key: `timing8kperson${i}`, patient_id: null, identity_key: `name:timing8k|person ${i}`,
          service_raw: "CBC, URINALYSIS, FBS", doctor_raw: "Dr. Example", hmo_raw: null, base_php: 850, final_php: 850,
          clinic_fee_php: null, revenue_php: 850, payment_method_raw: "CASH", payment_detail_raw: null,
          release_medium_raw: "EMAIL", released_on: "2026-06-02", control_no: `C-${i}`, test_no: `T-${i}`,
          raw: Array.from({ length: 20 }, (_, k) => (k === 4 ? `Timing8k, Person ${i}` : `cell ${k} value`)), row_hash: `t8k-lab-${i}`,
        });
        const STAGE = 2000;
        for (const [tab, total, row] of [["customers", N, cust], ["lab", 21504, lab]] as const) {
          for (let i = 0; i < total; i += STAGE) {
            const rows = Array.from({ length: Math.min(STAGE, total - i) }, (_, j) => row(i + j));
            await timed(`stage ${tab} chunk ${i / STAGE + 1}`, () =>
              q(`select public.sheet_mirror_stage($1::uuid, $2, $3::jsonb)`, [r1.token, tab, JSON.stringify(rows)]));
          }
          const c = await timed(`commit ${tab} (${total} rows, one statement)`, () =>
            q<{ n: number }>(`select public.sheet_mirror_commit($1::uuid, $2, $3) as n`, [r1.token, tab, total]));
          assert(c.rows[0].n === total, `commit ${tab}: expected ${total}, got ${c.rows[0].n}`);
        }
        await finish(r1.token);

        // Undo in pages of 2,000 patients (the runner's page size), summing
        // the per-call counts until done.
        const rv = await acquire("revert", false);
        const sum: Record<string, number> = {};
        let passes = 0;
        for (;;) {
          passes++;
          const u = await timed(`undo page ${passes} (p_limit 2000)`, () =>
            q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid, 2000) as j`, [rv.token, r1.runId]));
          for (const [k, v] of Object.entries(u.rows[0].j)) if (typeof v === "number") sum[k] = (sum[k] ?? 0) + v;
          if (u.rows[0].j.done) break;
          assert(passes < 20, "undo never finished");
        }
        await finish(rv.token);
        assert(
          passes === 8 && sum.restored === N && sum.deleted === N && sum.held === 2 * N,
          `paged undo: expected 8 calls, restored=${N} deleted=${N} held=${2 * N}, got ${passes} calls ${JSON.stringify(sum)}`,
        );
      } finally {
        await q(`set local statement_timeout = 0`).catch(() => {});
      }
      const worst = (prefix: string) => Math.max(...timings.filter(([l]) => l.startsWith(prefix)).map(([, ms]) => ms));
      console.log(`       ${String(worst("fill chunk")).padStart(6)} ms  worst 500-op fill chunk`);
      console.log(`       ${String(worst("create chunk")).padStart(6)} ms  worst 500-op create chunk`);
      console.log(`       ${String(worst("undo page")).padStart(6)} ms  worst undo page (2,000 patients)`);
      console.log(`       ${String(worst("stage ")).padStart(6)} ms  worst 2,000-row stage chunk`);
      for (const [label, ms] of timings.filter(([l]) => !l.includes("chunk "))) console.log(`       ${String(ms).padStart(6)} ms  ${label}`);
      const slow = timings.filter(([, ms]) => ms >= LIMIT_MS);
      assert(slow.length === 0, `over ${LIMIT_MS} ms: ${slow.map(([l, ms]) => `${l} (${ms} ms)`).join("; ")}`);
    });

    // 32. Identity kinds share one review item per key (e2e finding, round 8) --
    // A held key's kind can move between runs (customer-plan.test.ts: "a held
    // key's review KIND can change"). That must update the one item in place —
    // never resolve it as "no longer reported" and open another.
    await check("Identity kinds share one review item per key (a kind change never churns the item)", async () => {
      await setRole("service_role", null);
      const upsert = async (items: unknown[], clear: boolean) => {
        const l = await acquire("manual", false);
        const j = (await q<{ j: Json }>(`select public.sheet_sync_upsert_review($1::uuid, 'consult', $2::jsonb, $3) as j`, [
          l.token, JSON.stringify(items), clear])).rows[0].j;
        await finish(l.token);
        return j;
      };
      const item = (kind: string, key: string) => ({ kind, item_key: key, payload: { link_keys: [key], reason: kind } });
      const rows = async (key: string) => (await q<{ id: string; kind: string; status: string }>(
        `select id::text, kind, status from public.sheet_sync_review_items where item_key = $1 order by first_seen_at, id`, [key])).rows;

      const o1 = await upsert([item("possible_existing_patient", "ns:k1"), item("invalid_row", "ns:row")], false);
      assert(o1.opened === 2, `first report: expected 2 opened, got ${JSON.stringify(o1)}`);
      const [first] = await rows("ns:k1");
      // Next run: same key, another identity kind, with clear_absent on.
      const o2 = await upsert([item("ambiguous_patient", "ns:k1"), item("invalid_row", "ns:row")], true);
      assert(o2.opened === 0 && o2.updated === 2, `kind change: expected 0 opened / 2 updated, got ${JSON.stringify(o2)}`);
      const after = await rows("ns:k1");
      assert(after.length === 1 && after[0].id === first.id && after[0].kind === "ambiguous_patient" && after[0].status === "open",
        `kind change: expected the SAME open item, now ambiguous_patient, got ${JSON.stringify(after)}`);

      // A dismissed identity item stays dismissed (and is refreshed) under a new kind.
      await setRole("postgres", null);
      await q(`update public.sheet_sync_review_items set status = 'dismissed', resolved_at = now(),
                 resolution = '{"action":"dismiss"}'::jsonb where id = $1`, [first.id]);
      await setRole("service_role", null);
      const o3 = await upsert([item("identity_conflict", "ns:k1"), item("invalid_row", "ns:row")], true);
      assert(o3.opened === 0 && o3.kept_dismissed === 1, `dismissed + kind change: expected kept dismissed, got ${JSON.stringify(o3)}`);
      const after3 = await rows("ns:k1");
      assert(after3.length === 1 && after3[0].status === "dismissed" && after3[0].kind === "identity_conflict",
        `dismissed + kind change: expected one dismissed identity_conflict item, got ${JSON.stringify(after3)}`);
      // Non-identity kinds still keep one item per (kind, key).
      const o4 = await upsert([item("identity_conflict", "ns:k1"), item("unparseable_date", "ns:row")], true);
      assert(o4.opened === 1 && o4.cleared >= 1, `non-identity kinds do not share: expected a new item and the old one cleared, got ${JSON.stringify(o4)}`);

      // The runner upserts big lists in chunks and clears once with
      // sheet_sync_clear_absent_review — same namespace rule.
      await upsert([item("possible_existing_patient", "ns:k2")], false);
      const lc = await acquire("manual", false);
      const cleared = (await q<{ n: number }>(`select public.sheet_sync_clear_absent_review($1::uuid, 'consult', $2::jsonb) as n`, [
        lc.token, JSON.stringify([{ kind: "ambiguous_patient", item_key: "ns:k2" }])])).rows[0].n;
      await finish(lc.token);
      const k2 = await rows("ns:k2");
      const row = await rows("ns:row");
      assert(k2.length === 1 && k2[0].status === "open", `clear: an identity key reported under another identity kind stays open, got ${JSON.stringify(k2)}`);
      assert(cleared >= 1 && row.every((r) => r.status === "resolved"), `clear: unreported items are resolved, got ${cleared} / ${JSON.stringify(row)}`);
    });

    // 33. An undo's items are raised kept undone; "Let the sync decide again"
    //     releases exactly that undo's holds (e2e finding, round 8) ----------
    await check("Undo-held items are raised kept undone; Let the sync decide again releases that undo's holds (paged)", async () => {
      await setRole("service_role", null);
      const apply = (token: string, ops: unknown[]) =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [token, JSON.stringify(ops)]);
      const create = (key: string) => ({ op: "create", create_key: key, method: "auto_exact",
        fields: { first_name: key, last_name: "Released", middle_name: null }, link_keys: [key], admin_link_keys: [],
        legacy_intake: {}, facts: { registered_on: null, new_repeat: null, source_ref: key } });
      const undo = async (runId: string) => {
        const l = await acquire("revert", false);
        await q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid)`, [l.token, runId]);
        await finish(l.token);
        return l.runId;
      };
      // Run R creates three rows; run S creates one. Both are undone.
      const r = await acquire("manual", false);
      const rCreated = await apply(r.token, ["rl:0", "rl:1", "rl:2"].map(create));
      await finish(r.token);
      // An admin separately linked another sheet row to the SAME patient run
      // R created for "rl:0" (a real shape: two Customers rows, one an auto
      // create, one an admin link to it). The undo holds it too (it holds
      // EVERY key pointing at the patient it deletes) — but release must
      // never hand an admin-method hold back to auto-decide.
      await setRole("postgres", null);
      await q(
        `insert into public.sheet_patient_links (link_key, patient_id, decision, method) values ('rl:0admin', $1, 'link', 'admin')`,
        [rCreated.rows[0].j.created["rl:0"]],
      );
      await setRole("service_role", null);
      const s = await acquire("manual", false);
      await apply(s.token, [create("rl:other")]);
      await finish(s.token);
      const undoR = await undo(r.runId);
      await undo(s.runId);
      const adminHeld = await q<{ decision: string; method: string; hold_reason: string | null }>(
        `select decision, method, hold_reason from public.sheet_patient_links where link_key = 'rl:0admin'`,
      );
      assert(
        adminHeld.rows[0].decision === "review" && adminHeld.rows[0].method === "admin" && adminHeld.rows[0].hold_reason === "undone by an admin",
        `undo: the admin link of a deleted create must be HELD (not deleted, not left as-is), got ${JSON.stringify(adminHeld.rows[0])}`,
      );

      // The next sync reports those rows: raised kept undone, not open.
      const report = (keys: string[]) => JSON.stringify(keys.map((k) => ({ kind: "ambiguous_patient", item_key: k,
        payload: { link_keys: [k], candidates: [], reason: "held for an admin decision", held_because: "undone by an admin" } })));
      const l1 = await acquire("manual", false);
      const up1 = (await q<{ j: Json }>(`select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`, [
        l1.token, report(["rl:0", "rl:1", "rl:2", "rl:other"])])).rows[0].j;
      await finish(l1.token);
      assert(up1.opened === 0 && up1.kept_undone === 4, `undo-held rows: expected 4 raised kept undone and none open, got ${JSON.stringify(up1)}`);
      const auto = await q<{ n: string }>(
        `select count(*)::text as n from public.sheet_sync_review_items
          where item_key like 'rl:%' and status = 'dismissed' and (resolution->>'auto_from_undo')::boolean
            and (resolution->>'keep_undone')::boolean and resolution->'candidate_ids' = '[]'::jsonb`);
      assert(auto.rows[0].n === "4", `expected 4 auto kept-undone items, got ${auto.rows[0].n}`);

      // Release run R's undo, two holds a page.
      const rel = await acquire("release", false);
      const page = async () => (await q<{ j: Json }>(`select public.sheet_sync_release_undo($1::uuid, $2::uuid, 2) as j`, [
        rel.token, undoR])).rows[0].j;
      const p1 = await page();
      assert(p1.done === false && p1.released === 2 && p1.items_resolved === 2, `release page 1: got ${JSON.stringify(p1)}`);
      const p2 = await page();
      assert(p2.done === true && p2.released === 1 && p2.items_resolved === 1, `release page 2: got ${JSON.stringify(p2)}`);
      await finish(rel.token);
      const links = await q<{ link_key: string; decision: string; method: string }>(
        `select link_key, decision, method from public.sheet_patient_links where link_key like 'rl:%' order by 1`);
      assert(JSON.stringify(links.rows.map((x) => x.link_key)) === JSON.stringify(["rl:0admin", "rl:other"]),
        `release: only run R's non-admin undo holds go — the admin hold and the other undo's hold both stay, got ${JSON.stringify(links.rows)}`);
      const survivorAdmin = links.rows.find((x) => x.link_key === "rl:0admin")!;
      assert(
        survivorAdmin.decision === "review" && survivorAdmin.method === "admin",
        `release: the admin hold must survive untouched (still a review hold, not deleted), got ${JSON.stringify(survivorAdmin)}`,
      );
      const items = await q<{ status: string; action: string | null; n: string }>(
        `select status, resolution->>'action' as action, count(*)::text as n from public.sheet_sync_review_items
          where item_key like 'rl:%' group by 1, 2 order by 1, 2`);
      assert(JSON.stringify(items.rows.map((x) => [x.status, x.action, x.n])) === JSON.stringify([["dismissed", "dismiss", "1"], ["resolved", "released", "3"]]),
        `release: expected 3 items resolved as released and the other undo's item still kept undone, got ${JSON.stringify(items.rows)}`);
      const stamped = await q<{ by: string | null }>(`select released_by_run_id::text as by from public.sheet_sync_runs where id = $1`, [undoR]);
      assert(stamped.rows[0].by === rel.runId, `release: the undo run must be marked released by this run, got ${stamped.rows[0].by}`);

      // Refusals: again, a non-undo run, and undoing the release itself.
      const again = await acquire("release", false);
      await expectPgError("release the same undo twice", "22023", () =>
        q(`select public.sheet_sync_release_undo($1::uuid, $2::uuid)`, [again.token, undoR]));
      await expectPgError("release a run that is not an undo", "22023", () =>
        q(`select public.sheet_sync_release_undo($1::uuid, $2::uuid)`, [again.token, r.runId]));
      await finish(again.token);
      const rv = await acquire("revert", false);
      await expectPgError("undo a release", "22023", () =>
        q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid)`, [rv.token, rel.runId]));
      await finish(rv.token);

      // The next report of a released row opens a normal item (nothing holds it).
      const l2 = await acquire("manual", false);
      const up2 = (await q<{ j: Json }>(`select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`, [
        l2.token, report(["rl:0"])])).rows[0].j;
      await finish(l2.token);
      assert(up2.opened === 1 && up2.kept_undone === 0, `after release: expected a normal open item, got ${JSON.stringify(up2)}`);

      // Release refuses a PAGED undo that has not finished yet (reverted_by_run_id
      // still null on the target) — releasing early could act on holds a later
      // page has not placed.
      const t = await acquire("manual", false);
      await apply(t.token, ["rl:t0", "rl:t1"].map(create));
      await finish(t.token);
      const tRev1 = await acquire("revert", false);
      const page1 = (await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid, 1) as j`, [tRev1.token, t.runId])).rows[0].j;
      assert(page1.done === false, `paged undo setup: expected the first page to be unfinished, got ${JSON.stringify(page1)}`);
      await finish(tRev1.token);
      const relEarly = await acquire("release", false);
      await expectPgError("release a paged undo that has not finished", "22023", () =>
        q(`select public.sheet_sync_release_undo($1::uuid, $2::uuid)`, [relEarly.token, tRev1.runId]));
      await finish(relEarly.token);
      const tRev2 = await acquire("revert", false);
      const page2 = (await q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [tRev2.token, t.runId])).rows[0].j;
      assert(page2.done === true, `paged undo setup: expected the second call to finish it, got ${JSON.stringify(page2)}`);
      await finish(tRev2.token);
      const relLate = await acquire("release", false);
      await expectOk("release a finished undo", () => q(`select public.sheet_sync_release_undo($1::uuid, $2::uuid)`, [relLate.token, tRev1.runId]));
      await finish(relLate.token);
    });

    // 34. A row kept undone can still be linked or created (round 9) ---------
    await check("Link / Create on a kept-undone item replaces its hold like an open item; nothing else handled is actionable", async () => {
      await setRole("service_role", null);
      const create = (key: string) => ({ op: "create", create_key: key, method: "auto_exact",
        fields: { first_name: key, last_name: "KeptUndone", middle_name: null }, link_keys: [key], admin_link_keys: [],
        legacy_intake: {}, facts: { registered_on: null, new_repeat: null, source_ref: key } });
      const keys = ["ku:0", "ku:1", "ku:2", "ku:3"];
      const r = await acquire("manual", false);
      await q(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb)`, [r.token, JSON.stringify(keys.map(create))]);
      await finish(r.token);
      const rv = await acquire("revert", false);
      await q(`select public.sheet_sync_revert_run($1::uuid, $2::uuid)`, [rv.token, r.runId]);
      await finish(rv.token);
      const l = await acquire("manual", false);
      const up = (await q<{ j: Json }>(`select public.sheet_sync_upsert_review($1::uuid, 'customers', $2::jsonb, false) as j`, [
        l.token, JSON.stringify(keys.map((k) => ({ kind: "ambiguous_patient", item_key: k,
          payload: { link_keys: [k], candidates: [{ patient_id: fx.patientPId }], reason: "held for an admin decision" } })))])).rows[0].j;
      await finish(l.token);
      assert(up.kept_undone === 4, `setup: expected 4 items raised kept undone, got ${JSON.stringify(up)}`);
      const idOf = async (key: string, status = "dismissed") => (await q<{ id: string }>(
        `select id::text from public.sheet_sync_review_items where item_key = $1 and status = $2 order by first_seen_at, id limit 1`, [key, status])).rows[0]?.id;
      const resolve = (id: string, action: string, patient: string | null) =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, $3, $4::uuid)`, [id, fx.adminId, action, patient]);
      const link = async (key: string) => (await q<{ decision: string; method: string; patient_id: string | null; hold_reason: string | null }>(
        `select decision, method, patient_id::text as patient_id, hold_reason from public.sheet_patient_links where link_key = $1`, [key])).rows[0];

      // Link and Create both work on a kept-undone item and replace the undo hold.
      const i0 = (await idOf("ku:0"))!;
      await expectOk("link a kept-undone row", () => resolve(i0, "link", fx.patientPId));
      const l0 = await link("ku:0");
      assert(l0.decision === "link" && l0.method === "admin" && l0.patient_id === fx.patientPId && l0.hold_reason === null,
        `link: expected an admin link replacing the hold, got ${JSON.stringify(l0)}`);
      await expectOk("create for a kept-undone row", async () => resolve((await idOf("ku:1"))!, "create", null));
      const l1 = await link("ku:1");
      assert(l1.decision === "create" && l1.method === "admin", `create: expected an admin create decision, got ${JSON.stringify(l1)}`);
      const st = await q<{ status: string; action: string }>(
        `select status, resolution->>'action' as action from public.sheet_sync_review_items where id = $1`, [i0]);
      assert(st.rows[0].status === "resolved" && st.rows[0].action === "link", `link: item should be resolved, got ${JSON.stringify(st.rows[0])}`);

      // Not actionable: Dismiss on a kept-undone item, anything on a resolved item, a plain dismissal.
      await expectPgError("dismiss a kept-undone item again", "P0064", async () => resolve((await idOf("ku:2"))!, "dismiss", null));
      await expectPgError("link a resolved item", "P0064", () => resolve(i0, "link", fx.patientPId));
      await setRole("postgres", null);
      const plain = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload, status, resolution, resolved_at)
         values ('customers', 'ku:plain', 'ambiguous_patient', '{"link_keys":["ku:plain"]}'::jsonb, 'dismissed', '{"action":"dismiss","keep_undone":false}'::jsonb, now())
         returning id::text`);
      // An item re-opened for ku:3 beside its kept-undone one: one decision answers both.
      await q(`insert into public.sheet_sync_review_items (tab, item_key, kind, payload) values
                 ('customers', 'ku:3', 'possible_existing_patient', '{"link_keys":["ku:3"]}'::jsonb)`);
      await setRole("service_role", null);
      await expectPgError("link a plain dismissed item", "P0064", () => resolve(plain.rows[0].id, "link", fx.patientPId));
      await expectOk("create from the kept-undone item of ku:3", async () => resolve((await idOf("ku:3"))!, "create", null));
      const k3 = await q<{ status: string; n: string }>(
        `select status, count(*)::text as n from public.sheet_sync_review_items where item_key = 'ku:3' group by 1`);
      assert(k3.rows.length === 1 && k3.rows[0].status === "resolved" && k3.rows[0].n === "2",
        `ku:3: both items should be resolved by the one decision, got ${JSON.stringify(k3.rows)}`);
    });

    // 35. Timing (M9) ---------------------------------------------------------
    await check("Timing: 5,000-row commit, 500-op create chunk, undo (each < 8,000 ms)", async () => {
      await setRole("service_role", null);
      const LIMIT_MS = 8000;
      const timings: [string, number][] = [];
      async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const t0 = performance.now();
        const out = await fn();
        timings.push([label, Math.round(performance.now() - t0)]);
        return out;
      }

      const lease = await acquire("manual", false);
      const N = 5000;
      const CHUNK = 1000;
      for (let from = 0; from < N; from += CHUNK) {
        const chunk = Array.from({ length: CHUNK }, (_, j) => {
          const i = from + j;
          return {
            sheet_row: i + 2,
            source_key: `timing-src-${i}`,
            dup_count: 1,
            full_name_raw: `Timing, Person ${i}`,
            name_norm: `timing|person ${i}`,
            loose_key: `timingperson${i}`,
            link_key: `timing-link-${i}`,
            phone_norm: null,
            dob: null,
            registered_on: "2026-06-01",
            source_raw: "Facebook",
            source_norm: "facebook",
            referral_source_id: "online_facebook",
            referred_by_raw: null,
            new_repeat: "new",
            release_medium_raw: null,
            patient_id: null,
            link_state: "unlinked",
            row_hash: `timing-hash-${i}`,
          };
        });
        await timed(`stage customers chunk ${from / CHUNK + 1} (${CHUNK} rows)`, () =>
          q(`select public.sheet_mirror_stage($1::uuid, 'customers', $2::jsonb)`, [lease.token, JSON.stringify(chunk)]),
        );
      }
      const c = await timed(`commit customers (${N} rows)`, () =>
        q<{ n: number }>(`select public.sheet_mirror_commit($1::uuid, 'customers', $2) as n`, [lease.token, N]),
      );
      assert(c.rows[0].n === N, `timing commit: expected ${N} rows, got ${c.rows[0].n}`);

      const ops = Array.from({ length: 500 }, (_, i) => ({
        op: "create",
        create_key: `timing-create-${i}`,
        method: "auto_exact",
        fields: { first_name: `Person ${i}`, last_name: "Timing", middle_name: null, sex: "female", referral_source: "online_facebook" },
        link_keys: [`timing-create-link-${i}`],
        admin_link_keys: [],
        legacy_intake: { source: "sheet_sync:CUSTOMER LIST2" },
        facts: { registered_on: "2026-06-01", new_repeat: "new", source_ref: `timing-row-${i}` },
      }));
      const r = await timed("apply 500 create ops", () =>
        q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
          lease.token,
          JSON.stringify(ops),
        ]),
      );
      assert(r.rows[0].j.counts.created === 500, `timing ops: expected 500 created, got ${JSON.stringify(r.rows[0].j.counts)}`);
      await finish(lease.token);

      const leaseR = await acquire("revert", false);
      const rv = await timed("undo the 500-create run", () =>
        q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [leaseR.token, lease.runId]),
      );
      assert(
        rv.rows[0].j.deleted === 500 && rv.rows[0].j.held === 500,
        `timing undo: expected deleted=500 held=500, got ${JSON.stringify(rv.rows[0].j)}`,
      );
      await finish(leaseR.token);

      for (const [label, ms] of timings) console.log(`       ${String(ms).padStart(6)} ms  ${label}`);
      const slow = timings.filter(([, ms]) => ms >= LIMIT_MS);
      assert(slow.length === 0, `over ${LIMIT_MS} ms: ${slow.map(([l, ms]) => `${l} (${ms} ms)`).join("; ")}`);
    });

    // 36. 0167 (patient soft delete): a deleted patient is inactive everywhere
    // sheet sync touches patients ------------------------------------------
    await check("0167: a soft-deleted patient is inactive — create/link/fill/facts/resort/alias skip it, review resolve refuses it", async () => {
      await setRole("service_role", null);

      // A genuinely soft-deleted patient, via 0167's own delete_patient() RPC
      // (never by hand-setting deleted_at) — the same path an admin uses.
      const p = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate, referral_source, legacy_intake)
         values ('Deleted', 'ByAdmin', '1980-01-01', 'other', '{"source":"google_sheet_CUSTOMER_LIST2"}'::jsonb)
         returning id`,
      );
      const pid = p.rows[0].id;
      await q(`select public.delete_patient($1::uuid, 'test_record', null, $2::uuid, null)`, [pid, fx.adminId]);
      const after = await q<{ deleted_at: string | null; referral_source_origin: string | null }>(
        `select deleted_at, referral_source_origin from public.patients where id = $1`,
        [pid],
      );
      assert(after.rows[0].deleted_at !== null, "fixture: expected the patient to be deleted");
      assert(
        after.rows[0].referral_source_origin !== null,
        "fixture: a deleted patient with a referral_source must still carry a referral_source_origin — the CHECK constraint pairing (and the invariant 0170's backfill maintains for every existing row, deleted or not) survives delete_patient",
      );

      // create: owner decision 2026-09-25 (review fix E) — the sync must
      // NEVER silently re-create someone staff deleted, reversing the
      // original 0167 read of this check (a deleted record used to be exempt
      // from the dupe test; now it counts as "someone already holds this
      // identity" just like a live one). An AUTO create over the same
      // name+DOB is skipped_existing, no new patient. An ADMIN create over
      // the identical identity is the admin's own decision and is still
      // never second-guessed.
      const lease1 = await acquire("manual", false);
      const createOps = [{
        op: "create", create_key: "deleted-dupe:1", method: "auto_exact",
        fields: { first_name: "Deleted", last_name: "ByAdmin", middle_name: null, birthdate: "1980-01-01" },
        link_keys: ["deleted-dupe:1"], admin_link_keys: [], legacy_intake: {},
        facts: { registered_on: null, new_repeat: null, source_ref: "deleted-dupe:1" },
      }];
      const c = await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
        lease1.token, JSON.stringify(createOps),
      ]);
      assert(
        c.rows[0].j.counts.created === 0 && c.rows[0].j.counts.skipped_existing === 1,
        `auto create over a deleted patient: expected created=0 skipped_existing=1, got ${JSON.stringify(c.rows[0].j.counts)}`,
      );
      assert(
        Array.isArray(c.rows[0].j.skipped_create_keys) && c.rows[0].j.skipped_create_keys.includes("deleted-dupe:1"),
        `auto create over a deleted patient: expected skipped_create_keys to include "deleted-dupe:1", got ${JSON.stringify(c.rows[0].j.skipped_create_keys)}`,
      );
      const noNewPatient = await q<{ n: string }>(
        `select count(*)::text as n from public.patients where first_name = 'Deleted' and last_name = 'ByAdmin' and deleted_at is null`,
      );
      assert(noNewPatient.rows[0].n === "0", "auto create over a deleted patient must not create a new patient row");

      const adminCreateOps = [{
        op: "create", create_key: "deleted-dupe:admin", method: "admin",
        fields: { first_name: "Deleted", last_name: "ByAdmin", middle_name: null, birthdate: "1980-01-01" },
        link_keys: ["deleted-dupe:admin"], admin_link_keys: ["deleted-dupe:admin"], legacy_intake: {},
        facts: { registered_on: null, new_repeat: null, source_ref: "deleted-dupe:admin" },
      }];
      const ac = await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
        lease1.token, JSON.stringify(adminCreateOps),
      ]);
      assert(
        ac.rows[0].j.counts.created === 1 && (ac.rows[0].j.counts.skipped_existing ?? 0) === 0,
        `admin create over a deleted patient: expected created=1 skipped_existing=0 (an admin decision is never second-guessed), got ${JSON.stringify(ac.rows[0].j.counts)}`,
      );

      // link / fill / facts: targeting the deleted patient's id directly must never
      // write to it — counted stale/skipped, never a raised error.
      const linkFillOps = [
        { op: "link", link_key: "deleted-link:1", patient_id: pid, method: "auto_exact" },
        { op: "fill", patient_id: pid, fields: { email: "should-not-write@example.test" } },
        { op: "facts", patient_id: pid, registered_on: "2026-05-26", new_repeat: "new", source_ref: "deleted-facts:1" },
      ];
      const lf = await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
        lease1.token, JSON.stringify(linkFillOps),
      ]);
      assert(
        // 0193 (S3): the fill counts `stale` too now (it used to be `skipped`).
        lf.rows[0].j.counts.stale === 3 && (lf.rows[0].j.counts.skipped ?? 0) === 0 && lf.rows[0].j.counts.facts === 0,
        `link/fill/facts over a deleted patient: expected stale=3 skipped=0 facts=0, got ${JSON.stringify(lf.rows[0].j.counts)}`,
      );
      const linkRow = await q<{ n: string }>(`select count(*)::text as n from public.sheet_patient_links where link_key = 'deleted-link:1'`);
      assert(linkRow.rows[0].n === "0", "link over a deleted patient must write no link row");
      const stillNoEmail = await q<{ email: string | null }>(`select email from public.patients where id = $1`, [pid]);
      assert(stillNoEmail.rows[0].email === null, "fill over a deleted patient must not write");
      const factsRow = await q<{ n: string }>(`select count(*)::text as n from public.patient_acquisition_facts where source_ref = 'deleted-facts:1'`);
      assert(factsRow.rows[0].n === "0", "facts over a deleted patient must write no acquisition-facts row");
      await finish(lease1.token);

      // resort: excluded from the candidate list, and applying it is a no-op
      // (isolated from resort_apply's other predicates: this patient matches
      // every one of them except deleted_at).
      const candidates = await q<{ id: string }>(`select id from public.sheet_resort_candidates()`);
      assert(!candidates.rows.some((r) => r.id === pid), "sheet_resort_candidates must exclude a deleted patient");
      const lease2 = await acquire("resort", false);
      const rn = await q<{ sheet_resort_apply: number }>(
        `select public.sheet_resort_apply($1::uuid, $2::uuid[], 'other', 'online_google')`,
        [lease2.token, [pid]],
      );
      assert(rn.rows[0].sheet_resort_apply === 0, "sheet_resort_apply must no-op on a deleted patient");
      await finish(lease2.token);

      // alias: a mirror row pointing at the deleted patient is skipped. Uses
      // its OWN throwaway patient with no referral_source (unlike `p` above,
      // whose origin 'staff' would already exclude it from sheet_alias_apply
      // for an unrelated reason) so this isolates the deleted_at exclusion.
      const p2 = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Deleted', 'NoSource', '1981-01-01') returning id`,
      );
      const pid2 = p2.rows[0].id;
      await q(`select public.delete_patient($1::uuid, 'test_record', null, $2::uuid, null)`, [pid2, fx.adminId]);
      const runForMirror = await q<{ id: string }>(
        `insert into public.sheet_sync_runs (trigger, status, ended_at) values ('manual','succeeded', now()) returning id`,
      );
      await q(
        `insert into public.sheet_customer_rows
           (sheet_row, source_key, full_name_raw, name_norm, loose_key, link_key, phone_norm, dob, registered_on,
            source_raw, source_norm, patient_id, link_state, row_hash, run_id)
         values (1, 'deleted-alias-src', 'Deleted NoSource', 'nosource|deleted', 'nosource', 'deleted-alias-link', null, '1981-01-01', '2026-01-01',
                 'Some Clinic Ref', 'deleted alias probe', $1, 'linked', 'deleted-alias-hash', $2)`,
        [pid2, runForMirror.rows[0].id],
      );
      const lease3 = await acquire("alias", false);
      const an = await q<{ sheet_alias_apply: number }>(
        `select public.sheet_alias_apply($1::uuid, 'deleted alias probe', 'other', $2::uuid, null)`,
        [lease3.token, fx.adminId],
      );
      assert(an.rows[0].sheet_alias_apply === 0, "sheet_alias_apply must skip a deleted patient's mirror row");
      await finish(lease3.token);

      // review resolve: an admin Link onto a deleted patient is refused
      // outright (a deliberate one-shot decision, unlike the automated ops
      // above, which quietly re-plan a stale target instead).
      const item = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload)
         values ('customers', 'deleted-resolve:1', 'possible_existing_patient', '{"link_keys":["deleted-resolve:1"]}'::jsonb)
         returning id`,
      );
      await expectPgError("sheet_review_resolve link onto a deleted patient", "22023", () =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'link', $3::uuid)`, [item.rows[0].id, fx.adminId, pid]),
      );
    });

    // 36b. review fix E: "Keep deleted" is allowed on a deleted-patient-match
    // hold (hold_reason 'matches_deleted_patient') the same way "Keep undone"
    // is allowed on an undo hold — every OTHER evidence-based hold reason
    // still refuses Dismiss outright (22023).
    await check("review fix E: Dismiss (Keep deleted) succeeds on a matches_deleted_patient hold; an ordinary evidence-based hold still refuses it", async () => {
      await setRole("service_role", null);

      await q(
        `insert into public.sheet_patient_links (link_key, patient_id, decision, method, hold_reason)
         values ('keep-deleted:1', null, 'review', 'auto_exact', 'matches_deleted_patient')`,
      );
      const item1 = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload)
         values ('customers', 'keep-deleted:1', 'possible_existing_patient', '{"link_keys":["keep-deleted:1"]}'::jsonb)
         returning id`,
      );
      await q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'dismiss', null)`, [item1.rows[0].id, fx.adminId]);
      const resolved1 = await q<{ status: string; keep_undone: boolean | null }>(
        `select status, (resolution->>'keep_undone')::boolean as keep_undone from public.sheet_sync_review_items where id = $1`,
        [item1.rows[0].id],
      );
      assert(
        resolved1.rows[0].status === "dismissed" && resolved1.rows[0].keep_undone === true,
        `Keep deleted: expected dismissed + keep_undone=true, got ${JSON.stringify(resolved1.rows[0])}`,
      );
      const heldRow1 = await q<{ decision: string; hold_reason: string | null }>(
        `select decision, hold_reason from public.sheet_patient_links where link_key = 'keep-deleted:1'`,
      );
      assert(
        heldRow1.rows[0].decision === "review" && heldRow1.rows[0].hold_reason === "matches_deleted_patient",
        `Keep deleted: the hold itself must stay standing (never auto-created), got ${JSON.stringify(heldRow1.rows[0])}`,
      );

      // An ordinary evidence-based hold reason still refuses Dismiss.
      await q(
        `insert into public.sheet_patient_links (link_key, patient_id, decision, method, hold_reason)
         values ('ordinary-hold:1', null, 'review', 'auto_exact', 'several patients share this full name')`,
      );
      const item2 = await q<{ id: string }>(
        `insert into public.sheet_sync_review_items (tab, item_key, kind, payload)
         values ('customers', 'ordinary-hold:1', 'ambiguous_patient', '{"link_keys":["ordinary-hold:1"]}'::jsonb)
         returning id`,
      );
      await expectPgError("Dismiss on an ordinary evidence-based hold", "22023", () =>
        q(`select public.sheet_review_resolve($1::uuid, $2::uuid, 'dismiss', null)`, [item2.rows[0].id, fx.adminId]),
      );
    });

    // 37. 0167: undo and a soft-deleted patient -------------------------------
    await check("0167: undo blocks a restore onto a since-deleted patient, and calls a since-deleted CREATED patient gone (never kept, never re-deleted)", async () => {
      await setRole("service_role", null);

      // --- restore loop: blocked, never raised --------------------------------
      const target = await q<{ id: string }>(
        `insert into public.patients (first_name, last_name, birthdate) values ('Undo', 'ThenDeleted', '1977-07-07') returning id`,
      );
      const tid = target.rows[0].id;
      const leaseA = await acquire("manual", false);
      const fillOps = [{ op: "fill", patient_id: tid, fields: { email: "before-delete@example.test" } }];
      const fa = await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
        leaseA.token, JSON.stringify(fillOps),
      ]);
      assert(fa.rows[0].j.counts.filled === 1, `fixture: expected the fill to apply, got ${JSON.stringify(fa.rows[0].j.counts)}`);
      await finish(leaseA.token);

      await q(`select public.delete_patient($1::uuid, 'test_record', null, $2::uuid, null)`, [tid, fx.adminId]);

      const leaseR1 = await acquire("revert", false);
      const undoA = await expectOk("undo of a fill onto a since-deleted patient", () =>
        q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [leaseR1.token, leaseA.runId]),
      );
      assert(
        undoA.rows[0].j.blocked === 1 && undoA.rows[0].j.restored === 0,
        `undo onto a since-deleted patient: expected blocked=1 restored=0, got ${JSON.stringify(undoA.rows[0].j)}`,
      );
      await finish(leaseR1.token);
      const stillDeleted = await q<{ email: string | null; deleted_at: string | null }>(
        `select email, deleted_at from public.patients where id = $1`,
        [tid],
      );
      assert(stillDeleted.rows[0].deleted_at !== null, "undo must not touch a deleted patient's lifecycle fields");
      // A blocked restore leaves the patient exactly as the fill left it
      // (still "before-delete@example.test") — undo did NOT revert it back
      // to its pre-fill null.
      assert(
        stillDeleted.rows[0].email === "before-delete@example.test",
        `a blocked restore must not write the patient's columns, got email=${stillDeleted.rows[0].email}`,
      );

      // --- create loop: gone, never kept, never hard-deleted ------------------
      const leaseB = await acquire("manual", false);
      const createOps = [{
        op: "create", create_key: "undo-gone:1", method: "auto_exact",
        fields: { first_name: "WillBe", last_name: "SoftDeleted", middle_name: null, birthdate: "1999-01-01" },
        link_keys: ["undo-gone:1"], admin_link_keys: [], legacy_intake: {},
        facts: { registered_on: null, new_repeat: null, source_ref: "undo-gone:1" },
      }];
      const cb = await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [
        leaseB.token, JSON.stringify(createOps),
      ]);
      assert(cb.rows[0].j.counts.created === 1, `fixture: expected the create to apply, got ${JSON.stringify(cb.rows[0].j.counts)}`);
      const createdId = cb.rows[0].j.created["undo-gone:1"];
      await finish(leaseB.token);

      await q(`select public.delete_patient($1::uuid, 'test_record', null, $2::uuid, null)`, [createdId, fx.adminId]);

      const leaseR2 = await acquire("revert", false);
      const undoB = await expectOk("undo of a create whose patient was since soft-deleted", () =>
        q<{ j: Json }>(`select public.sheet_sync_revert_run($1::uuid, $2::uuid) as j`, [leaseR2.token, leaseB.runId]),
      );
      assert(
        undoB.rows[0].j.gone === 1 && undoB.rows[0].j.deleted === 0 && undoB.rows[0].j.kept === 0,
        `undo of a since-deleted create: expected gone=1 deleted=0 kept=0, got ${JSON.stringify(undoB.rows[0].j)}`,
      );
      await finish(leaseR2.token);
      const stillThere = await q<{ n: string }>(`select count(*)::text as n from public.patients where id = $1`, [createdId]);
      assert(stillThere.rows[0].n === "1", "a gone (soft-deleted) created patient must never be hard-deleted");
    });

    // 38. 0193 (sync review gaps): S2 facts stale guard + S3 fill on an inactive target,
    //     driven by the REAL planner's output through the real RPC -----------------------
    await check("0193 S2/S3: planner ops through SQL — facts survive their own fill (one chunk, two chunks, replay), stale identity rejects facts, a later run gets no credit, a fill on a deleted target is stale", async () => {
      const PATIENT_COLS = `id, drm_id, first_name, middle_name, last_name, to_char(birthdate, 'YYYY-MM-DD') as birthdate, phone, phone_normalized,
        email, sex, address, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number,
        referral_source, referral_source_origin, merged_into_id, row_version::int as row_version`;
      const readPatients = async (ids: string[]): Promise<PatientRecord[]> => {
        await setRole("postgres", null);
        const r = await q<PatientRecord>(`select ${PATIENT_COLS} from public.patients where deleted_at is null and id = any($1::uuid[])`, [ids]);
        return r.rows;
      };
      // 32874 = 1990-01-01 in the sheet's serial-date form
      const sheetRow = (name: string, ts: number) => {
        const r: unknown[] = new Array(22).fill("");
        r[4] = name; r[6] = 32874; r[11] = "09171230000"; r[12] = "planner@example.test"; r[19] = "NEW"; r[20] = ts;
        return parseCustomersTab([CUST_HEADER, r] as never, { today: "2026-09-24", aliases: new Map() }).rows;
      };
      const newPatient = async (last: string): Promise<string> => {
        await setRole("postgres", null);
        const p = await q<{ id: string }>(
          `insert into public.patients (first_name, last_name, birthdate) values ('Zeta', $1, '1990-01-01') returning id`, [last]);
        return p.rows[0].id;
      };
      const planFor = async (pid: string, last: string): Promise<CustomerOp[]> => {
        const out = planCustomers({ rows: sheetRow(`${last}, Zeta`, 46000), index: buildPatientIndex(await readPatients([pid])),
          links: new Map(), facts: new Map(), prevRows: [] });
        const kinds = out.ops.map((o) => o.op).sort().join(",");
        assert(kinds === "facts,fill,link", `fixture: expected the planner to emit link+fill+facts, got ${kinds}`);
        for (const o of out.ops) if (o.op !== "hold" && o.op !== "create") {
          assert(o.expected_row_version !== undefined, `planner: ${o.op} op carries no expected_row_version`);
        }
        return out.ops;
      };
      const ofKind = (ops: CustomerOp[], k: string) => ops.filter((o) => o.op === k);
      const apply = async (token: string, ops: unknown[]) => {
        await setRole("service_role", null);
        return (await q<{ j: Json }>(`select public.sheet_sync_apply_customer_ops($1::uuid, $2::jsonb) as j`, [token, JSON.stringify(ops)])).rows[0].j;
      };
      const factsRow = async (pid: string) => {
        await setRole("postgres", null);
        return (await q<{ source_ref: string | null }>(`select source_ref from public.patient_acquisition_facts where patient_id = $1`, [pid])).rows;
      };
      const staffEdit = async (pid: string) => {
        await setRole("postgres", null);
        await q(`update public.patients set address = coalesce(address, '') || 'x' where id = $1`, [pid]);
      };

      // (a) fill + facts in ONE chunk
      let pid = await newPatient("PlannerOne");
      let ops = await planFor(pid, "PlannerOne");
      let lease = await acquire("manual", false);
      let j = await apply(lease.token, ops);
      assert(j.counts.filled === 1 && j.counts.facts === 1 && j.counts.stale === 0 && j.stale_patient_ids.length === 0,
        `(a) one chunk: expected filled=1 facts=1 stale=0, got ${JSON.stringify(j)}`);
      assert((await factsRow(pid)).length === 1, "(a) one chunk: the facts row must be written");
      await finish(lease.token);

      // (b) fill in one call, facts in the NEXT call (a chunk boundary), same run
      pid = await newPatient("PlannerTwo");
      ops = await planFor(pid, "PlannerTwo");
      lease = await acquire("manual", false);
      j = await apply(lease.token, ops.filter((o) => o.op !== "facts"));
      assert(j.counts.filled === 1, `(b) chunk 1: expected filled=1, got ${JSON.stringify(j.counts)}`);
      j = await apply(lease.token, ofKind(ops, "facts"));
      assert(j.counts.facts === 1 && j.counts.stale === 0, `(b) chunk 2: expected facts=1 stale=0, got ${JSON.stringify(j)}`);
      assert((await factsRow(pid)).length === 1, "(b) chunk boundary: the facts row must be written");
      // (b2) lost response: the facts chunk is retried after it already committed
      j = await apply(lease.token, ofKind(ops, "facts"));
      assert(j.counts.facts === 1 && j.counts.stale === 0, `(b2) retried facts chunk: expected an idempotent facts=1 stale=0, got ${JSON.stringify(j)}`);
      // (b3) …and the fill chunk retried: the patient moved on, so it is stale (conservative, no double write, no error)
      j = await apply(lease.token, ops.filter((o) => o.op === "fill"));
      assert(j.counts.filled === 0 && j.counts.stale === 1 && j.stale_patient_ids.includes(pid),
        `(b3) retried fill chunk: expected filled=0 stale=1 (id reported), got ${JSON.stringify(j)}`);
      await finish(lease.token);

      // (c) stale identity: staff edited the patient after the planner read it
      pid = await newPatient("PlannerThree");
      ops = await planFor(pid, "PlannerThree");
      await staffEdit(pid);
      lease = await acquire("manual", false);
      j = await apply(lease.token, ops);
      assert(j.counts.filled === 0 && j.counts.facts === 0 && j.counts.linked === 0 && j.counts.stale === 3 && j.stale_patient_ids.includes(pid),
        `(c) stale identity: expected link/fill/facts all stale and the id reported, got ${JSON.stringify(j)}`);
      assert((await factsRow(pid)).length === 0, "(c) stale identity: no facts row may be written");
      await finish(lease.token);

      // (d) staff edit AFTER our fill but BEFORE the facts chunk: only our own bump is forgiven
      pid = await newPatient("PlannerFour");
      ops = await planFor(pid, "PlannerFour");
      lease = await acquire("manual", false);
      j = await apply(lease.token, ops.filter((o) => o.op !== "facts"));
      assert(j.counts.filled === 1, `(d) chunk 1: expected filled=1, got ${JSON.stringify(j.counts)}`);
      await staffEdit(pid);
      j = await apply(lease.token, ofKind(ops, "facts"));
      assert(j.counts.facts === 0 && j.counts.stale === 1 && j.stale_patient_ids.includes(pid),
        `(d) staff edit between chunks: expected facts=0 stale=1, got ${JSON.stringify(j)}`);
      assert((await factsRow(pid)).length === 0, "(d) staff edit between chunks: no facts row may be written");
      await finish(lease.token);

      // (e) a LATER run gets no credit for an earlier run's fill: run 1 fills, run 2 replays the old plan's facts
      pid = await newPatient("PlannerFive");
      ops = await planFor(pid, "PlannerFive");
      lease = await acquire("manual", false);
      j = await apply(lease.token, ops.filter((o) => o.op !== "facts"));
      assert(j.counts.filled === 1, `(e) run 1: expected filled=1, got ${JSON.stringify(j.counts)}`);
      await finish(lease.token);
      const lease2 = await acquire("manual", false);
      j = await apply(lease2.token, ofKind(ops, "facts"));
      assert(j.counts.facts === 0 && j.counts.stale === 1, `(e) next run: expected the old plan's facts to be stale, got ${JSON.stringify(j)}`);
      await finish(lease2.token);

      // (f) the forgiveness needs the fill's own version: a fill with NO expected version bumps the row,
      //     and a facts op whose expected version is not the version just below it is still stale
      pid = await newPatient("PlannerSix");
      ops = await planFor(pid, "PlannerSix");
      lease = await acquire("manual", false);
      const bare = ops.filter((o) => o.op === "fill").map((o) => { const { expected_row_version: _drop, ...rest } = o as never as Record<string, unknown>; void _drop; return rest; });
      j = await apply(lease.token, bare);
      assert(j.counts.filled === 1, `(f) bare fill: expected filled=1, got ${JSON.stringify(j.counts)}`);
      const wrongVersionFacts = ofKind(ops, "facts").map((o) => ({ ...o, expected_row_version: (o as { expected_row_version: number }).expected_row_version - 5 }));
      j = await apply(lease.token, wrongVersionFacts);
      assert(j.counts.facts === 0 && j.counts.stale === 1, `(f) expected version not one below the fill's: expected stale, got ${JSON.stringify(j)}`);
      await finish(lease.token);

      // (g) S3: the planner read a live patient, staff deleted it, then the ops arrive — the FILL is stale too
      pid = await newPatient("PlannerSeven");
      ops = await planFor(pid, "PlannerSeven");
      await setRole("postgres", null);
      await q(`select public.delete_patient($1::uuid, 'test_record', null, $2::uuid, null)`, [pid, fx.adminId]);
      lease = await acquire("manual", false);
      j = await apply(lease.token, ops);
      assert(j.counts.stale === 3 && (j.counts.skipped ?? 0) === 0 && j.counts.filled === 0 && j.stale_patient_ids.includes(pid),
        `(g) deleted target: expected link, fill AND facts stale (fill not skipped) with the id reported, got ${JSON.stringify(j)}`);
      const fillOnly = await apply(lease.token, ofKind(ops, "fill"));
      assert(fillOnly.counts.stale === 1 && (fillOnly.counts.skipped ?? 0) === 0 && fillOnly.stale_patient_ids.includes(pid),
        `(g) a lone fill on a deleted target must be stale with its id reported, got ${JSON.stringify(fillOnly)}`);
      const ghost = await apply(lease.token, [{ op: "fill", patient_id: "00000000-0000-4000-8000-00000000dead", fields: { email: "x@example.test" } }]);
      assert(ghost.counts.stale === 1 && (ghost.counts.skipped ?? 0) === 0, `(g) a fill on a missing patient: expected stale, got ${JSON.stringify(ghost)}`);
      await finish(lease.token);
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
