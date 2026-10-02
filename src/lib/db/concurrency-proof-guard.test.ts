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
 *   compare-and-set UPDATE with no explicit lock at all. Comments are
 *   stripped first; string literals are NOT, so dynamic SQL
 *   (`execute format('… for update')`) counts.
 *
 * KNOWN LIMITS
 *   - A compare-and-set claim whose name has no `claim` segment takes no
 *     explicit lock and is not detected. Name claims claim_*.
 *   - Overloads are tracked by signature, but REGISTRY/BASELINE keys are bare
 *     names, so one entry covers every overload of that name.
 *
 * WHAT COUNTS AS A PROOF
 * ----------------------
 * A REGISTRY proof path must carry a comment line
 * `concurrency-proof: <fn>` in or next to the scenario that actually races
 * <fn>. A name mentioned in a comment, or "race" somewhere else in the file,
 * does not pass. Annotate only functions the file genuinely races.
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
  claim_panel_members: {
    proof: ["scripts/panel-claim-concurrency-proof.ts", "scripts/report-release-concurrency-proof.ts"],
  },
  unclaim_panel_members: {
    proof: ["scripts/panel-claim-concurrency-proof.ts", "scripts/report-release-concurrency-proof.ts"],
  },
  recompute_clinic_fee_for_unreleased: { proof: ["scripts/plan-order-lockers-proof.ts"] },
  delete_test_request_lines: { proof: ["scripts/plan-order-lockers-proof.ts"] },
  restore_test_request_lines: { proof: ["scripts/plan-order-lockers-proof.ts"] },
  claim_release_notice: { proof: ["scripts/release-notice-concurrency-proof.ts"] },
  finish_release_notice: { proof: ["scripts/release-notice-concurrency-proof.ts"] },
  reclaim_panel_members: { proof: ["scripts/panel-undo-concurrency-proof.ts"] },
  restore_panel_members: { proof: ["scripts/panel-undo-concurrency-proof.ts", "scripts/plan-order-lockers-proof.ts"] },
  release_visit_results: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  undo_visit_release: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  release_report_locks: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  correct_payment: { proof: ["scripts/report-release-concurrency-proof.ts"] },
  _ps_digest_claim: { proof: ["scripts/ps-digest-claim-concurrency-proof.ts"] },
  waive_visit_balance: { proof: ["scripts/waiver-concurrency-proof.ts"] },
  waiver_unrecognise_line: { proof: ["scripts/waiver-concurrency-proof.ts"] },
  waiver_post_allocation: {
    exempt:
      "callee-only: runs inside waive_visit_balance's transaction under its visit + line locks; its own lock is on a row the same transaction inserted, so no contention is possible",
  },
  guard_payment_on_waived_visit: { proof: ["scripts/waiver-concurrency-proof.ts"] },
  fn_undo_release_bridge: { proof: ["scripts/waiver-concurrency-proof.ts"] },
  lifecycle_lock: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  lifecycle_lock_and_assert: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  appointments_insert_slot_guarded: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  delete_patient: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  resolve_patient_guarded: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  record_hmo_settlement: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  reschedule_closure_appointments: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  result_edit_commit: { proof: ["scripts/smoke-lifecycle-locks.ts"] },
  sheet_review_resolve: { proof: ["scripts/sheet-sync-db-proof.ts"] },
  _sheet_sync_fence: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_sync_acquire: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_sync_apply_customer_ops: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_sync_revert_run: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_sync_upsert_review: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_sync_release_undo: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_resort_apply: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  sheet_alias_apply: { proof: ["scripts/sheet-sync-concurrency-proof.ts"] },
  merge_patients_guarded: { proof: ["scripts/merge-concurrency-proof.ts"] },
  undo_patient_merge_guarded: { proof: ["scripts/merge-concurrency-proof.ts"] },
  view_as_transition: { proof: ["scripts/view-as-restore-concurrency-proof.ts"] },
  view_as_expire: { proof: ["scripts/view-as-restore-concurrency-proof.ts"] },
  view_as_end_for: { proof: ["scripts/view-as-restore-concurrency-proof.ts"] },
  restore_patient: { proof: ["scripts/view-as-restore-concurrency-proof.ts"] },
  bridge_payment_delete: { proof: ["scripts/view-as-restore-concurrency-proof.ts"] },
  claim_statement_email: { proof: ["scripts/notice-claims-concurrency-proof.ts"] },
  result_claim_patient_notify: { proof: ["scripts/notice-claims-concurrency-proof.ts"] },
  result_mark_copy_contacted: { proof: ["scripts/notice-claims-concurrency-proof.ts"] },
  ap_create_bill_payment_with_allocations: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_post_recurring_template: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_recompute_bill_paid_and_status: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_reallocate_bill_payment: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_reverse_je_for_source: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_update_bill_draft: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_void_bill_payment_cascade: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  ap_void_bill_with_guard: { proof: ["scripts/ap-subledger-concurrency-proof.ts"] },
  bridge_cash_adjustment_insert: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_cash_adjustment_void: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_hmo_claim_resolution_insert: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_hmo_claim_resolution_void: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_payment_insert: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_payment_void: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_test_request_cancelled: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  bridge_test_request_released: { proof: ["scripts/gl-bridge-concurrency-proof.ts"] },
  lifecycle_lock_results: { proof: ["scripts/result-lifecycle-concurrency-proof.ts"] },
  result_create_linked: { proof: ["scripts/result-lifecycle-concurrency-proof.ts"] },
  result_finalise_commit: { proof: ["scripts/result-lifecycle-concurrency-proof.ts"] },
  result_save_draft: { proof: ["scripts/result-lifecycle-concurrency-proof.ts"] },
  queue_claim_remarks: {
    exempt:
      "false positive on the name: a read-only SECURITY DEFINER reader over audit_log that takes no lock and claims nothing",
  },
};

/** FROZEN pre-guard functions with no proof. May only shrink. Name -> definition file. */
const BASELINE: Record<string, string> = {
  create_visit_encounter: "0184_patient_lifecycle_locks.sql",
  enforce_patient_activity: "0184_patient_lifecycle_locks.sql",
  guard_test_request_on_waived_visit: "0183_waived_balance_gl.sql",
  lock_hmo_batch_before_items: "0184_patient_lifecycle_locks.sql",
  recalc_visit_payment: "0111_payment_void_recalc.sql",
  recompute_hmo_batch_status: "0184_patient_lifecycle_locks.sql",
  test_requests_claim_holder_guard: "0190_claim_holder_guard_and_view_as_end_for.sql",
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
    // checkGuard already asserts existence and the per-function annotation;
    // this pins only a floor (non-trivial), so parallel proof PRs do not conflict on an exact count.
    const proofs = Object.values(REGISTRY).filter((e) => "proof" in e);
    expect(proofs.length).toBeGreaterThanOrEqual(65);
  });
});

describe("lock detector (synthetic SQL)", () => {
  const mig = (file: string, sql: string): MigrationFile => ({ file, sql });
  const fn = (name: string, body: string, tag = "$$", args = "p uuid") =>
    `create or replace function public.${name}(${args}) returns void language plpgsql as ${tag}\nbegin\n${body}\nend;\n${tag};\n`;
  const names = (r: { name: string }[]) => r.map((f) => f.name);

  it("catches for update inside a dollar-quoted body", () => {
    const r = scanLockFunctions([mig("0300_a.sql", fn("grab", "perform 1 from t where id = p for update;"))]);
    expect(r.map((f) => [f.name, f.signals])).toEqual([["grab", ["for update"]]]);
  });

  it("catches advisory locks, skip locked and lock table", () => {
    expect(lockSignals("perform pg_advisory_xact_lock(1);")).toEqual(["advisory lock"]);
    expect(lockSignals("select 1 from t for update skip locked;")).toEqual(["for update", "skip locked"]);
    expect(lockSignals("lock table public.t in share row exclusive mode;")).toEqual(["lock table"]);
  });

  it("ignores for update in a line comment and a block comment", () => {
    const body = "-- for update\n/* for share */\nperform 1;";
    expect(scanLockFunctions([mig("0300_a.sql", fn("calm", body))])).toEqual([]);
  });

  it("matches a lock inside a string literal (dynamic SQL)", () => {
    const body = "execute format('select 1 from %s where id = $1 for update', 't') using p;";
    expect(names(scanLockFunctions([mig("0300_a.sql", fn("dyn", body))]))).toEqual(["dyn"]);
  });

  it("handles nested dollar tags", () => {
    const r = scanLockFunctions([mig("0300_a.sql", fn("dyn", "execute $q$ select 1 from t for update $q$;", "$fn$"))]);
    expect(names(r)).toEqual(["dyn"]);
    // a tag-shaped comment inside a body does not end it early
    expect(scanLockFunctions([mig("0300_a.sql", fn("calm", "-- $fn$ for update\nperform 1;", "$fn$"))])).toEqual([]);
  });

  it("a later create or replace without locks un-flags the function; a drop removes it", () => {
    const first = mig("0300_a.sql", fn("grab", "perform 1 from t for update;"));
    const second = mig("0301_b.sql", fn("grab", "perform 1;"));
    expect(scanLockFunctions([first, second])).toEqual([]);
    expect(names(scanLockFunctions([first]))).toEqual(["grab"]);
    expect(scanLockFunctions([first, mig("0302_c.sql", "drop function if exists public.grab(uuid);")])).toEqual([]);
  });

  it("replays migrations in filename order, whatever order they are passed in", () => {
    const first = mig("0300_a.sql", fn("grab", "perform 1 from t for update;"));
    const second = mig("0301_b.sql", fn("grab", "perform 1;"));
    expect(scanLockFunctions([second, first])).toEqual([]);
  });

  it("flags a claim-named compare-and-set function and a helper caller", () => {
    expect(lockSignals("update t set x = 1 where x is null;", "claim_thing")).toEqual(["claim name"]);
    expect(lockSignals("perform public.release_report_locks(a, b, c);", "release_x")).toEqual(["calls lock helper"]);
  });

  describe("body search stays inside the function", () => {
    const locker = fn("locker", "perform 1 from t for update;");
    it("a single-quoted body is read, with '' unescaped", () => {
      const sql = "create function public.q() returns int language sql as 'select 1 from t where a = ''x'' for update';";
      expect(names(scanLockFunctions([mig("0300_a.sql", sql)]))).toEqual(["q"]);
    });
    it("a tag-less single-quoted function does not steal the next function's body", () => {
      const calm = "create function public.calm() returns int language sql as 'select 1';\n";
      expect(names(scanLockFunctions([mig("0300_a.sql", calm + locker)]))).toEqual(["locker"]);
    });
    it("a begin atomic body is read, and does not steal the next function's body", () => {
      const atomicLock =
        "create function public.al() returns int language sql\nbegin atomic\n  select 1 from t for update;\nend;\n";
      const atomicCalm = "create function public.ac() returns int language sql\nbegin atomic\n  select 1;\nend;\n";
      expect(names(scanLockFunctions([mig("0300_a.sql", atomicLock)]))).toEqual(["al"]);
      expect(names(scanLockFunctions([mig("0300_a.sql", atomicCalm + locker)]))).toEqual(["locker"]);
    });
    it("a body-less function (language c) does not steal the next function's body", () => {
      const c = "create function public.cfn() returns int language c as 'lib', 'sym';\n";
      // "as 'lib', 'sym'" is its (single-quoted) body: no lock, and locker stays its own
      expect(names(scanLockFunctions([mig("0300_a.sql", c + locker)]))).toEqual(["locker"]);
      const none = "create function public.nb() returns int language internal;\n";
      expect(names(scanLockFunctions([mig("0300_a.sql", none + locker)]))).toEqual(["locker"]);
    });
    it("an E-string body honours backslash-escaped quotes", () => {
      const sql = String.raw`create function public.es() returns int language sql as E'select \'x\' from t for update';`;
      expect(names(scanLockFunctions([mig("0300_a.sql", sql)]))).toEqual(["es"]);
    });
    it("an E-string containing -- does not swallow the rest of the file", () => {
      const comment = String.raw`comment on function public.x() is E'it\'s -- not a comment';`;
      expect(names(scanLockFunctions([mig("0300_a.sql", comment + " " + locker)]))).toEqual(["locker"]);
    });
  });

  describe("overloads", () => {
    const ov = (args: string, body: string) => fn("ov", body, "$$", args);
    const both = [
      mig("0300_a.sql", ov("p int", "perform 1 from t for update;")),
      mig("0301_b.sql", ov("p text", "perform 1;")),
    ];
    it("are separate functions: a lock-free overload does not un-flag a locking one", () => {
      const r = scanLockFunctions(both);
      expect(r.map((f) => [f.name, f.signature])).toEqual([["ov", "integer"]]);
    });
    it("a signature drop removes only that overload", () => {
      const lockText = mig("0300_a.sql", ov("p int", "perform 1 from t for update;") + ov("p text", "perform 1 from t for update;"));
      const r = scanLockFunctions([lockText, mig("0301_b.sql", "drop function public.ov(int);")]);
      expect(r.map((f) => f.signature)).toEqual(["text"]);
    });
    it("a drop without an argument list removes every overload", () => {
      const lockText = mig("0300_a.sql", ov("p int", "perform 1 from t for update;") + ov("p text", "perform 1 from t for update;"));
      expect(scanLockFunctions([lockText, mig("0301_b.sql", "drop function if exists public.ov;")])).toEqual([]);
    });
    it("a multi-name drop removes each named function", () => {
      const sql = fn("a", "perform 1 from t for update;") + fn("b", "perform 1 from t for update;") + fn("c", "perform 1 from t for update;");
      const r = scanLockFunctions([mig("0300_a.sql", sql), mig("0301_b.sql", "drop function public.a(uuid), public.b(uuid) cascade;")]);
      expect(names(r)).toEqual(["c"]);
    });
    it("argument names, modes, defaults and type aliases normalise to one signature", () => {
      const a = fn("sig", "perform 1 from t for update;", "$$", "in p_a int4 default 3, p_b timestamptz, p_c double precision, p_d uuid[]");
      expect(scanLockFunctions([mig("0300_a.sql", a)])[0].signature).toBe(
        "integer, timestamp with time zone, double precision, uuid[]",
      );
    });
  });

  describe("checkGuard", () => {
    const grab = () => scanLockFunctions([mig("0300_a.sql", fn("grab", "perform 1 from t for update;"))]);
    const ok = { exempt: "a perfectly good reason here" };

    it("a new locking function with no entry fails with an actionable message", () => {
      const live = grab();
      const problems = checkGuard({ live, registry: {}, baseline: {}, readProof: () => null });
      expect(problems).toEqual([missingEntryMessage(live[0])]);
      for (const part of ["scripts/<name>-concurrency-proof.ts", "_race_smoke.sql", '"grab": { proof:', "exempt", "concurrency-proof: grab"]) {
        expect(problems[0]).toContain(part);
      }
    });

    it("a baseline function redefined in a newer migration needs a proof", () => {
      const live = scanLockFunctions([mig("0301_b.sql", fn("old_one", "perform 1 from t for update;"))]);
      const redefined = checkGuard({ live, registry: {}, baseline: { old_one: "0200_old.sql" }, readProof: () => null });
      expect(redefined.join()).toContain("redefined in 0301_b.sql");
      expect(checkGuard({ live, registry: {}, baseline: { old_one: "0301_b.sql" }, readProof: () => null })).toEqual([]);
    });

    it("a name in both REGISTRY and BASELINE fails", () => {
      const problems = checkGuard({ live: grab(), registry: { grab: ok }, baseline: { grab: "0300_a.sql" }, readProof: () => null });
      expect(problems.join()).toContain("in both REGISTRY and BASELINE");
    });

    it("an empty proof list fails", () => {
      expect(checkGuard({ live: grab(), registry: { grab: { proof: [] } }, baseline: {}, readProof: () => null }).join()).toContain(
        "proof list is empty",
      );
    });

    it("stale entries fail", () => {
      expect(checkGuard({ live: grab(), registry: { grab: ok, gone: ok }, baseline: {}, readProof: () => null }).join()).toContain("STALE REGISTRY: gone");
      expect(checkGuard({ live: [], registry: {}, baseline: { ghost: "0100_x.sql" }, readProof: () => null }).join()).toContain("STALE BASELINE: ghost");
    });

    it("a proof must exist and carry a per-function annotation", () => {
      const run = (text: string | null) =>
        checkGuard({ live: grab(), registry: { grab: { proof: ["x.ts"] } }, baseline: {}, readProof: () => text });
      expect(run(null).join()).toContain("does not exist");
      // a mention plus a race elsewhere in the file is NOT a proof
      expect(run("// grab() is called here\n// two-connection race on other_fn\n").join()).toContain('no "concurrency-proof: grab" annotation');
      // an annotation for a different function is not a proof of this one
      expect(run("// concurrency-proof: other_fn\n").join()).toContain("annotation");
      expect(run("// concurrency-proof: other_fn, grab (scenario 3)\n")).toEqual([]);
      expect(run("-- concurrency-proof: grab\n")).toEqual([]);
    });

    it("an exemption needs a real reason", () => {
      expect(checkGuard({ live: grab(), registry: { grab: { exempt: "short" } }, baseline: {}, readProof: () => null }).join()).toContain("real reason");
      expect(checkGuard({ live: grab(), registry: { grab: ok }, baseline: {}, readProof: () => null })).toEqual([]);
    });

    it("one bare-name entry covers every overload", () => {
      const live = scanLockFunctions([
        mig("0300_a.sql", fn("ov", "perform 1 from t for update;", "$$", "p int") + fn("ov", "perform 1 from t for update;", "$$", "p text")),
      ]);
      expect(live).toHaveLength(2);
      expect(checkGuard({ live, registry: { ov: ok }, baseline: {}, readProof: () => null })).toEqual([]);
    });
  });
});
