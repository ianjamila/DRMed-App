/**
 * Every migration function that takes a lock or claims work has a concurrency
 * proof (or a reasoned exemption).
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration 0198: a release and an undo on a part-released report touched
 * DIFFERENT rows, never waited on each other, and split the report. No review
 * and no sequential smoke saw it; only a two-connection concurrency proof did.
 * A lock or claim function that ships without such a proof is unverified in
 * exactly the way that bug was. This test reads the migration text (no
 * database), replays it in filename order to find the LIVE function bodies,
 * and fails when a locking/claiming function has no registered proof.
 *
 * DETECTION (src/lib/db/migration-lock-scan.ts)
 *   for update / for no key update / for share / for key share, skip locked,
 *   nowait, pg_[try_]advisory_[xact_]lock, lock table ... mode; a call to a
 *   lock helper (release_report_locks, lifecycle_lock*), because
 *   release_visit_results holds its locks only through that helper; and a
 *   claim/unclaim function NAME, because claim_panel_members is a
 *   compare-and-set UPDATE with no explicit lock at all. Comments and string
 *   literals are stripped first.
 *
 * THE BASELINE
 * ------------
 * BASELINE freezes the functions that predate the guard and have no proof,
 * as name -> migration file of the definition at freeze time. It is an
 * explicit list, not a migration-number cutoff, because "older than 0205"
 * does not say which functions were ever proven (0184's helpers are, its
 * trigger guards are not) and a cutoff cannot tell a stale entry from a live
 * one. A function whose latest definition moves to a different migration is
 * NEW WORK and needs a REGISTRY entry — redefining an unproven lock function
 * is how 0198 happened. The list may only shrink: never add to it.
 *
 * Self-tests at the bottom feed the detector synthetic SQL.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkGuard,
  lockSignals,
  missingEntryMessage,
  scanLockFunctions,
  type MigrationFile,
  type RegistryEntry,
} from "./migration-lock-scan";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

/** Functions with a proof that runs the race (or a reason none is needed). */
const REGISTRY: Record<string, RegistryEntry> = {
  ad_spend_delete: { proof: ["scripts/ad-spend-concurrency-proof.ts"] },
  ad_spend_import: { proof: ["scripts/ad-spend-concurrency-proof.ts"] },
  claim_panel_members: { proof: ["scripts/panel-claim-concurrency-proof.ts"] },
  unclaim_panel_members: { proof: ["scripts/panel-claim-concurrency-proof.ts"] },
  release_visit_results: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  undo_visit_release: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  release_report_locks: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  correct_payment: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  waive_visit_balance: { proof: ["supabase/tests/0183_waiver_race_smoke.sql"] },
  waiver_unrecognise_line: { proof: ["supabase/tests/0183_waiver_race_smoke.sql"] },
  lifecycle_lock: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  lifecycle_lock_and_assert: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  appointments_insert_slot_guarded: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  delete_patient: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  restore_patient: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  resolve_patient_guarded: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  record_hmo_settlement: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  reschedule_closure_appointments: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  result_edit_commit: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  bridge_payment_delete: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  _sheet_sync_fence: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_alias_apply: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_resort_apply: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_review_resolve: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_sync_acquire: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_sync_apply_customer_ops: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_sync_release_undo: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_sync_revert_run: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  sheet_sync_upsert_review: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  queue_claim_remarks: {
    exempt:
      "false positive on the name: a read-only SECURITY DEFINER reader over audit_log that takes no lock and claims nothing",
  },
};

/** FROZEN pre-guard functions with no proof. May only shrink. Name -> definition file. */
const BASELINE: Record<string, string> = {
  ap_post_recurring_template: "0049_ap_subledger_behavior.sql",
  ap_reallocate_bill_payment: "0049_ap_subledger_behavior.sql",
  ap_reverse_je_for_source: "0049_ap_subledger_behavior.sql",
  ap_update_bill_draft: "0049_ap_subledger_behavior.sql",
  ap_void_bill_payment_cascade: "0049_ap_subledger_behavior.sql",
  ap_void_bill_with_guard: "0049_ap_subledger_behavior.sql",
  bridge_cash_adjustment_insert: "0152_cash_journal_descriptions.sql",
  bridge_cash_adjustment_void: "0141_manila_posting_dates_remainder.sql",
  bridge_hmo_claim_resolution_insert: "0141_manila_posting_dates_remainder.sql",
  bridge_hmo_claim_resolution_void: "0141_manila_posting_dates_remainder.sql",
  bridge_payment_insert: "0140_manila_posting_dates.sql",
  bridge_payment_void: "0140_manila_posting_dates.sql",
  bridge_test_request_cancelled: "0183_waived_balance_gl.sql",
  bridge_test_request_released: "0183_waived_balance_gl.sql",
  claim_statement_email: "0177_statement_email_claim.sql",
  create_visit_encounter: "0184_patient_lifecycle_locks.sql",
  enforce_patient_activity: "0184_patient_lifecycle_locks.sql",
  fn_undo_release_bridge: "0183_waived_balance_gl.sql",
  guard_payment_on_waived_visit: "0183_waived_balance_gl.sql",
  guard_test_request_on_waived_visit: "0183_waived_balance_gl.sql",
  lifecycle_lock_results: "0184_patient_lifecycle_locks.sql",
  lock_hmo_batch_before_items: "0184_patient_lifecycle_locks.sql",
  recalc_visit_payment: "0111_payment_void_recalc.sql",
  recompute_hmo_batch_status: "0184_patient_lifecycle_locks.sql",
  result_claim_patient_notify: "0179_result_copy_followups.sql",
  result_create_linked: "0184_patient_lifecycle_locks.sql",
  result_finalise_commit: "0184_patient_lifecycle_locks.sql",
  result_mark_copy_contacted: "0179_result_copy_followups.sql",
  result_save_draft: "0184_patient_lifecycle_locks.sql",
  test_requests_claim_holder_guard: "0190_claim_holder_guard_and_view_as_end_for.sql",
  view_as_end_for: "0190_claim_holder_guard_and_view_as_end_for.sql",
  view_as_expire: "0187_view_as_followups.sql",
  view_as_transition: "0187_view_as_followups.sql",
  waiver_post_allocation: "0183_waived_balance_gl.sql",
};

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));
}

function readProof(rel: string): string | null {
  const full = join(ROOT, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

describe("concurrency-proof guard (real migrations)", () => {
  const live = scanLockFunctions(loadMigrations());

  it("finds the known lock and claim functions (the detector is not blind)", () => {
    const names = live.map((f) => f.name);
    for (const known of [
      "claim_panel_members",
      "unclaim_panel_members",
      "release_visit_results",
      "undo_visit_release",
      "ad_spend_import",
      "waive_visit_balance",
      "lifecycle_lock",
    ]) {
      expect(names, `${known} should be detected`).toContain(known);
    }
  });

  it("every lock/claim function has a proof, an exemption, or a frozen baseline entry", () => {
    const problems = checkGuard({ live, registry: REGISTRY, baseline: BASELINE, readProof });
    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("proof files named in the registry are real concurrency proofs", () => {
    // checkGuard already asserts existence, a mention of the function and a
    // race marker; this pins that REGISTRY is non-trivial.
    const proofs = Object.values(REGISTRY).filter((e) => "proof" in e);
    expect(proofs.length).toBeGreaterThanOrEqual(25);
  });
});

describe("lock detector (synthetic SQL)", () => {
  const mig = (file: string, sql: string): MigrationFile => ({ file, sql });
  const fn = (name: string, body: string, tag = "$$") =>
    `create or replace function public.${name}(p uuid) returns void language plpgsql as ${tag}\nbegin\n${body}\nend;\n${tag};\n`;

  it("catches for update inside a dollar-quoted body", () => {
    const r = scanLockFunctions([mig("0300_a.sql", fn("grab", "perform 1 from t where id = p for update;"))]);
    expect(r.map((f) => [f.name, f.signals])).toEqual([["grab", ["for update"]]]);
  });

  it("catches advisory locks, skip locked and lock table", () => {
    expect(lockSignals("perform pg_advisory_xact_lock(1);")).toEqual(["advisory lock"]);
    expect(lockSignals("select 1 from t for update skip locked;")).toEqual(["for update", "skip locked"]);
    expect(lockSignals("lock table public.t in share row exclusive mode;")).toEqual(["lock table"]);
  });

  it("ignores for update in a line comment, a block comment and a string", () => {
    const body = "-- for update\n/* for share */\nraise notice 'we do not use for update here';\nperform 1;";
    expect(scanLockFunctions([mig("0300_a.sql", fn("calm", body))])).toEqual([]);
  });

  it("handles nested dollar tags", () => {
    const body = "execute $q$ select 1 from t for update $q$;";
    const r = scanLockFunctions([mig("0300_a.sql", fn("dyn", body, "$fn$"))]);
    expect(r.map((f) => f.name)).toEqual(["dyn"]);
    // and a tag-shaped comment inside a body does not end it early
    const calm = scanLockFunctions([mig("0300_a.sql", fn("calm", "-- $fn$ for update\nperform 1;", "$fn$"))]);
    expect(calm).toEqual([]);
  });

  it("a later create or replace without locks un-flags the function; a drop removes it", () => {
    const first = mig("0300_a.sql", fn("grab", "perform 1 from t for update;"));
    const second = mig("0301_b.sql", fn("grab", "perform 1;"));
    expect(scanLockFunctions([first, second])).toEqual([]);
    expect(scanLockFunctions([first]).map((f) => f.name)).toEqual(["grab"]);
    const dropped = mig("0302_c.sql", "drop function if exists public.grab(uuid);");
    expect(scanLockFunctions([first, dropped])).toEqual([]);
  });

  it("flags a claim-named compare-and-set function and a helper caller", () => {
    expect(lockSignals("update t set x = 1 where x is null;", "claim_thing")).toEqual(["claim name"]);
    expect(lockSignals("perform public.release_report_locks(a, b, c);", "release_x")).toEqual(["calls lock helper"]);
  });

  it("a new locking function with no entry fails with an actionable message", () => {
    const live = scanLockFunctions([mig("0300_a.sql", fn("grab_it", "perform 1 from t for update;"))]);
    const problems = checkGuard({ live, registry: {}, baseline: {}, readProof: () => null });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(missingEntryMessage(live[0]));
    expect(problems[0]).toContain("scripts/<name>-concurrency-proof.ts");
    expect(problems[0]).toContain("_race_smoke.sql");
    expect(problems[0]).toContain('"grab_it": { proof:');
    expect(problems[0]).toContain("exempt");
  });

  it("a baseline function redefined in a newer migration needs a proof", () => {
    const live = scanLockFunctions([mig("0301_b.sql", fn("old_one", "perform 1 from t for update;"))]);
    const problems = checkGuard({ live, registry: {}, baseline: { old_one: "0200_old.sql" }, readProof: () => null });
    expect(problems.join()).toContain("redefined in 0301_b.sql");
    const frozen = checkGuard({ live, registry: {}, baseline: { old_one: "0301_b.sql" }, readProof: () => null });
    expect(frozen).toEqual([]);
  });

  it("flags stale entries and unusable proofs", () => {
    const live = scanLockFunctions([mig("0300_a.sql", fn("grab", "perform 1 from t for update;"))]);
    const base = { live, baseline: {} as Record<string, string> };
    expect(checkGuard({ ...base, registry: { gone: { exempt: "a perfectly good reason here" }, grab: { exempt: "a perfectly good reason here" } }, readProof: () => null }).join()).toContain("STALE REGISTRY: gone");
    expect(checkGuard({ ...base, registry: { grab: { proof: ["x.ts"] } }, readProof: () => null }).join()).toContain("does not exist");
    expect(checkGuard({ ...base, registry: { grab: { proof: ["x.ts"] } }, readProof: () => "race: other" }).join()).toContain('never mentions "grab"');
    expect(checkGuard({ ...base, registry: { grab: { proof: ["x.ts"] } }, readProof: () => "grab() sequential" }).join()).toContain("no race/concurrency marker");
    expect(checkGuard({ ...base, registry: { grab: { proof: ["x.ts"] } }, readProof: () => "two-connection race on grab()" })).toEqual([]);
    expect(checkGuard({ ...base, registry: { grab: { exempt: "short" } }, readProof: () => null }).join()).toContain("real reason");
    expect(checkGuard({ live: [], registry: {}, baseline: { ghost: "0100_x.sql" }, readProof: () => null }).join()).toContain("STALE BASELINE: ghost");
  });
});
