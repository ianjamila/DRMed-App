/**
 * Every migration function takes the patient lifecycle lock BEFORE it row-locks
 * a visit or a line, or writes a patient-owned row.
 *
 * WHY THIS EXISTS
 * ---------------
 * DRMed's global lock order is: patient lifecycle advisory lock (shared for
 * writers, `lifecycle_lock_and_assert(ids, false)`) → visit row → lines ORDER
 * BY id → write. merge_patients_guarded / undo_patient_merge_guarded (0196)
 * take the patient lock EXCLUSIVE first and then UPDATE visits (delete_patient
 * / restore_patient take it exclusive too, but touch only the patients row). A function that grabs the visit (or a line) first
 * and only reaches the patient lock later — its own lifecycle_lock call, or
 * the a_lifecycle_guard trigger its write fires — closes a cycle with them:
 * 40P01. 3a's review found it in recompute_clinic_fee_for_unreleased (fixed by
 * 0215); 0216 fixed delete/restore; this guard's first run found it in
 * waive_visit_balance (fixed by 0220).
 *
 * HOW (src/lib/db/lifecycle-lock-order.ts, no database)
 *   Replay the migrations to the live function bodies; walk each body's
 *   statements in text order; report the first statement that row-locks
 *   visits/test_requests (FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE, `OF`
 *   honoured) or inserts/updates/deletes a table carrying a_lifecycle_guard,
 *   unless a patient lifecycle lock came first — a call to lifecycle_lock /
 *   lifecycle_lock_and_assert, the raw `patient_lifecycle` advisory key, or a
 *   call to a function that itself starts with one (release_report_locks).
 *   Trigger functions are skipped when every attachment runs under the guard
 *   (on a guarded table, AFTER, or BEFORE with a name sorting after
 *   a_lifecycle_guard): the guard already holds the patient lock for the row.
 *
 * KNOWN LIMITS (none has a live instance today — checked when this was written)
 *   - Text order, not control flow: a lock taken in one branch counts for the
 *     whole body, and a lock call in the SAME statement as a row lock (a
 *     `for r in select … for update loop perform lifecycle_lock(…)`) counts as
 *     first. Statements inside called (non-lifecycle-first) functions are not
 *     followed.
 *   - Comma joins (`from a, visits v … for update`), `merge into` and
 *     `lock table` are not recognised; writes through dynamic SQL are seen only
 *     when the table name is literal. String literals are not blanked, so a
 *     message mentioning `update payments` can be a false positive.
 *   - "Runs under the guard" assumes a_lifecycle_guard took the patient lock;
 *     it takes none for its exempt writes (a results INSERT, appointment
 *     cancel / no-show, PIN counters, alert acknowledgement, the 0179 notice
 *     columns, no-op updates), so a trigger on those runs unlocked.
 *
 * THE ALLOW-LIST
 *   Functions that take a row lock first ON PURPOSE, each with the reason no
 *   cycle exists and the migration file that was reviewed. A redefinition in
 *   another file must be reviewed again (the test fails until the entry's file
 *   is updated). Do not add a new function here to get past the test — take
 *   the patient lock first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanLiveFunctions, type MigrationFile } from "./migration-lock-scan";
import {
  checkLockOrder,
  firstUnorderedStatement,
  guardedTables,
  lifecycleFirstFunctions,
  rowLockedTables,
  scanLockOrder,
  scanTriggers,
  statements,
  type LockOrderExemption,
} from "./lifecycle-lock-order";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

const LINES_ONLY =
  "locks test_requests lines only (id order) and reaches the shared patient lock through a_lifecycle_guard on its UPDATE. " +
  "Nothing that takes the patient lock EXCLUSIVE ever waits on a line: merge / undo-merge (0196) write visits, patients, " +
  "consents, appointments, attachments and alerts — never lines — and delete_patient / restore_patient lock only the " +
  "patients row; shared holders never block each other. Against release / undo (visit → lines by id) both sides lock " +
  "lines in id order (0211 proof L2x/L3x).";

const NOTICE_COLUMNS =
  "writes only the 0179 patient-notice columns of result_amendments (patient_notified_at / _channels / notify_error / " +
  "contacted_at / _by), an UPDATE a_lifecycle_guard exempts without taking any patient lock, so there is no lock to order.";

/** Functions that take a row lock / write before the patient lock ON PURPOSE. Name -> reviewed file + why. */
const ALLOW: Record<string, LockOrderExemption> = {
  claim_panel_members: { file: "0211_claim_unclaim_lock_order.sql", why: LINES_ONLY },
  unclaim_panel_members: { file: "0211_claim_unclaim_lock_order.sql", why: LINES_ONLY },
  reclaim_panel_members: { file: "0200_panel_undo_all_or_nothing.sql", why: LINES_ONLY },
  result_claim_patient_notify: { file: "0179_result_copy_followups.sql", why: NOTICE_COLUMNS },
  result_mark_copy_contacted: { file: "0179_result_copy_followups.sql", why: NOTICE_COLUMNS },
  result_record_patient_notify: { file: "0179_result_copy_followups.sql", why: NOTICE_COLUMNS },
  result_retry_patient_notify: { file: "0188_result_followups_notify_problem.sql", why: NOTICE_COLUMNS },
  result_note_patient_download: {
    file: "0176_result_patient_download_and_remarks.sql",
    why:
      "updates results.patient_last_downloaded_at (row lock, then the shared patient lock via a_lifecycle_guard). " +
      "No exclusive patient-lock holder ever waits on a results row — merge / undo-merge never write results, " +
      "delete_patient / restore_patient lock only the patients row — and result_edit_commit / finalise take the " +
      "patient lock SHARED before the results row, which this shared request never blocks.",
  },
  recompute_hmo_item_paid_amount: {
    file: "0034_hmo_ar_subledger.sql",
    why:
      "callee-only: called solely from tg_hmo_item_paid_amount_recompute, an AFTER trigger on hmo_payment_allocations " +
      "(a guarded table), so a_lifecycle_guard on the triggering row already holds the shared patient lock when it " +
      "updates the item; merge never writes hmo_claim_items.",
  },
  recompute_hmo_item_resolution_amounts: {
    file: "0034_hmo_ar_subledger.sql",
    why:
      "callee-only: called solely from tg_hmo_item_resolution_amounts_recompute, an AFTER trigger on " +
      "hmo_claim_resolutions (a guarded table), so the shared patient lock is already held; merge never writes hmo_claim_items.",
  },
  tg_hmo_batch_voided_propagate: {
    file: "0034_hmo_ar_subledger.sql",
    why:
      "AFTER UPDATE trigger on hmo_claim_batches (not patient-owned): voiding a batch flags its items, each item row " +
      "then its patient's SHARED lock. Merge / undo-merge never write hmo_claim_items and delete / restore lock only " +
      "the patients row, so no exclusive holder waits on an item; shared requests never block each other.",
  },
};

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));
}

describe("lifecycle lock order (real migrations)", () => {
  const files = loadMigrations();
  const live = scanLiveFunctions(files);
  const triggers = scanTriggers(files);

  it("reads the patient-owned tables from the a_lifecycle_guard attachments (the detector is not blind)", () => {
    const guarded = guardedTables(triggers);
    for (const t of ["visits", "test_requests", "payments", "results", "result_test_requests", "doctor_pf_entries"]) {
      expect(guarded, `${t} should carry a_lifecycle_guard`).toContain(t);
    }
  });

  it("recognises the functions that already take the patient lock first", () => {
    const first = lifecycleFirstFunctions(live, guardedTables(triggers));
    for (const name of [
      "recompute_clinic_fee_for_unreleased",
      "delete_test_request_lines",
      "restore_test_request_lines",
      "restore_panel_members",
      "release_report_locks",
      "release_visit_results", // through release_report_locks
      "merge_patients_guarded", // raw patient_lifecycle advisory key
      "waive_visit_balance", // 0220
    ]) {
      expect([...first], `${name} should take the patient lock first`).toContain(name);
    }
  });

  it("every function takes the patient lifecycle lock before its first row lock or patient-owned write", () => {
    const problems = checkLockOrder(scanLockOrder(live, triggers), ALLOW);
    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  describe("mutation check: the guard bites on the real migrations", () => {
    /** Re-run the scan with one migration's text edited; the edit must actually apply. */
    const scanWith = (file: string, from: string, to: string) => {
      // A missing file would make the mutation a no-op and the assertion vacuous.
      expect(files.map((f) => f.file), `${file} should exist`).toContain(file);
      const mutated = files.map((f) => {
        if (f.file !== file) return f;
        expect(f.sql, `${file} should contain the text the mutation removes`).toContain(from);
        return { ...f, sql: f.sql.split(from).join(to) };
      });
      return checkLockOrder(scanLockOrder(scanLiveFunctions(mutated), scanTriggers(mutated)), ALLOW).join("\n");
    };

    it("0220 without its patient lock is flagged again (the 0183 order)", () => {
      const out = scanWith(
        "0220_waive_visit_balance_lock_order.sql",
        "perform public.lifecycle_lock_and_assert(array[v_patient], false);",
        "",
      );
      expect(out).toContain("LOCK ORDER: waive_visit_balance");
      expect(out).toContain("row-locks visits");
    });

    it("0215 recompute without its patient lock is flagged", () => {
      const sql = files.find((f) => f.file === "0215_recompute_clinic_fee_lock_order.sql")!.sql;
      const call = /perform\s+public\.lifecycle_lock(?:_and_assert)?\([^;]*\);/.exec(sql)?.[0];
      expect(call, "0215 should call a lifecycle lock").toBeTruthy();
      expect(scanWith("0215_recompute_clinic_fee_lock_order.sql", call!, "")).toContain(
        "LOCK ORDER: recompute_clinic_fee_for_unreleased",
      );
    });

    it("0216 delete without its patient lock is flagged", () => {
      expect(
        scanWith(
          "0216_delete_restore_lock_order.sql",
          "perform public.lifecycle_lock_and_assert(array[v_patient], false);",
          "",
        ),
      ).toContain("LOCK ORDER: delete_test_request_lines");
    });

    it("a redefinition of an allow-listed function must be reviewed again", () => {
      const extra: MigrationFile = {
        file: "9999_redefine.sql",
        sql: files.find((f) => f.file === "0200_panel_undo_all_or_nothing.sql")!.sql,
      };
      const all = [...files, extra];
      const out = checkLockOrder(scanLockOrder(scanLiveFunctions(all), scanTriggers(all)), ALLOW).join("\n");
      expect(out).toContain("reclaim_panel_members is allow-listed for 0200_panel_undo_all_or_nothing.sql but was redefined in 9999_redefine.sql");
    });
  });
});

describe("lock-order detector (synthetic SQL)", () => {
  const GUARDED = ["visits", "test_requests", "payments"];
  const none = new Set<string>();

  it("splits statements on top-level semicolons only", () => {
    expect(statements("a; execute 'x; y'; b $q$ c; d $q$; e")).toEqual(["a", "execute 'x; y'", "b $q$ c; d $q$", "e"]);
  });

  it("row locks: FOR UPDATE / NO KEY UPDATE / SHARE on visits or lines, OF honoured", () => {
    expect(rowLockedTables("select * from public.visits where id = p for update")).toEqual(["visits"]);
    expect(rowLockedTables("perform 1 from test_requests t where t.visit_id = p order by t.id for no key update")).toEqual(["test_requests"]);
    expect(rowLockedTables("select 1 from visits v join test_requests t on t.visit_id = v.id for share")).toEqual(["test_requests", "visits"]);
    expect(rowLockedTables("select 1 from test_requests t join services s on s.id = t.service_id for update of s")).toEqual([]);
    expect(rowLockedTables("select 1 from test_requests t join services s on s.id = t.service_id for update of t")).toEqual(["test_requests"]);
    expect(rowLockedTables("select 1 from journal_entries for update")).toEqual([]);
  });

  it("flags a visit lock before the patient lock, and passes once the patient lock comes first", () => {
    const bad = "select * into v from public.visits where id = p for update; perform public.lifecycle_lock_and_assert(array[x], false);";
    expect(firstUnorderedStatement(bad, GUARDED, none)?.kind).toBe("row-lock");
    const good = "perform public.lifecycle_lock_and_assert(array[x], false); select * into v from public.visits where id = p for update;";
    expect(firstUnorderedStatement(good, GUARDED, none)).toBeNull();
  });

  it("flags a guarded write before the patient lock, not an unguarded one", () => {
    expect(firstUnorderedStatement("update public.payments set x = 1 where id = p;", GUARDED, none)).toMatchObject({
      kind: "write",
      tables: ["payments"],
    });
    expect(firstUnorderedStatement("insert into public.audit_log (a) values (1);", GUARDED, none)).toBeNull();
    // `on conflict do update` and `for update` are not writes to a table named after them
    expect(firstUnorderedStatement("insert into public.audit_log (a) values (1) on conflict (a) do update set a = 2;", GUARDED, none)).toBeNull();
  });

  it("accepts the raw patient_lifecycle advisory key and a lifecycle-first callee", () => {
    const raw = "perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p::text)); update public.visits set x = 1;";
    expect(firstUnorderedStatement(raw, GUARDED, none)).toBeNull();
    const viaHelper = "perform public.my_locks(p); update public.visits set x = 1;";
    expect(firstUnorderedStatement(viaHelper, GUARDED, none)).not.toBeNull();
    expect(firstUnorderedStatement(viaHelper, GUARDED, new Set(["my_locks"]))).toBeNull();
  });

  it("ignores locks and writes in comments", () => {
    const body = "-- select 1 from visits for update\n/* update public.visits set x = 1; */ perform 1;";
    const fnSql = `create function public.calm() returns void language plpgsql as $$ begin ${body} end; $$;`;
    const live = scanLiveFunctions([{ file: "0300_a.sql", sql: fnSql }]);
    expect(scanLockOrder(live, [])).toEqual([]);
  });

  describe("trigger functions", () => {
    const fn = (name: string, body: string) =>
      `create or replace function public.${name}() returns trigger language plpgsql as $$ begin ${body}; return new; end; $$;\n`;
    const guard = "create trigger a_lifecycle_guard before insert or update or delete on public.visits for each row execute function public.enforce_patient_activity();\n";
    const scan = (sql: string) => {
      const files = [{ file: "0300_a.sql", sql: fn("enforce_patient_activity", "perform 1") + guard + sql }];
      return scanLockOrder(scanLiveFunctions(files), scanTriggers(files)).map((v) => v.name);
    };
    const body = "update public.visits set x = 1 where id = new.visit_id";

    it("skips one that runs under the guard (AFTER, or BEFORE sorting after a_lifecycle_guard)", () => {
      expect(scan(fn("t_after", body) + "create trigger t_after after update on public.visits for each row execute function public.t_after();")).toEqual([]);
      expect(scan(fn("t_late", body) + "create trigger trg_late before update on public.visits for each row execute function public.t_late();")).toEqual([]);
    });

    it("flags one that fires BEFORE the guard, or on a table without it", () => {
      expect(scan(fn("t_early", body) + "create trigger _early before update on public.visits for each row execute function public.t_early();")).toEqual(["t_early"]);
      expect(scan(fn("t_other", body) + "create trigger t_other after update on public.services for each row execute function public.t_other();")).toEqual(["t_other"]);
    });

    it("a dropped attachment no longer counts", () => {
      const sql =
        fn("t_gone", body) +
        "create trigger t_gone after update on public.visits for each row execute function public.t_gone();\n" +
        "drop trigger if exists t_gone on public.visits;\n" +
        "create trigger t_gone after update on public.services for each row execute function public.t_gone();";
      expect(scan(sql)).toEqual(["t_gone"]);
    });
  });

  describe("checkLockOrder", () => {
    const v = { name: "grab", signature: "uuid", file: "0300_a.sql", finding: { kind: "row-lock" as const, tables: ["visits"], statement: "select …" } };
    const ok = { file: "0300_a.sql", why: "a perfectly good, long enough reason that explains why no cycle exists" };

    it("an unlisted violation fails with an actionable message", () => {
      const out = checkLockOrder([v], {}).join();
      expect(out).toContain("LOCK ORDER: grab(uuid) in 0300_a.sql row-locks visits");
      expect(out).toContain("lifecycle_lock_and_assert");
    });
    it("an allow-listed violation passes; a short reason, a moved file and a stale entry fail", () => {
      expect(checkLockOrder([v], { grab: ok })).toEqual([]);
      expect(checkLockOrder([v], { grab: { ...ok, why: "short" } }).join()).toContain("not a real reason");
      expect(checkLockOrder([v], { grab: { ...ok, file: "0200_b.sql" } }).join()).toContain("redefined in 0300_a.sql");
      expect(checkLockOrder([], { grab: ok }).join()).toContain("STALE LOCK-ORDER ALLOW-LIST: grab");
    });
  });
});
