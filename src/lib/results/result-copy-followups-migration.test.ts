import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EDIT_COMMIT_0179_HUNKS,
  applyHunks,
  extractFunction,
} from "./edit-commit-0179-hunks";

const read = (f: string) => readFileSync(`supabase/migrations/${f}`, "utf8");
const M0176 = read("0176_result_patient_download_and_remarks.sql");
const M0179 = () => read("0179_result_copy_followups.sql");

describe("0179 result_edit_commit = 0176 + the marked hunks", () => {
  it("every hunk matches 0176's function exactly once", () => {
    expect(() =>
      applyHunks(extractFunction(M0176, "result_edit_commit"), EDIT_COMMIT_0179_HUNKS),
    ).not.toThrow();
  });

  it("0179 redefines the function as exactly the hunked 0176 text", () => {
    const expected = applyHunks(
      extractFunction(M0176, "result_edit_commit"),
      EDIT_COMMIT_0179_HUNKS,
    );
    expect(extractFunction(M0179(), "result_edit_commit")).toBe(expected);
  });

  it("0179 no longer deletes critical alerts in the edit", () => {
    const fn = extractFunction(M0179(), "result_edit_commit");
    expect(fn).not.toMatch(/delete\s+from\s+public\.critical_alerts/i);
    expect(fn).toMatch(/withdrawn_by_amendment\s*=\s*v_amend_id/);
  });
});

const SERVICE_ONLY = [
  "result_copy_states_internal",
  "result_claim_patient_notify",
  "result_record_patient_notify",
];
const STAFF_CALLABLE = [
  "result_copy_state",
  "result_outdated_copies",
  "result_mark_copy_contacted",
];

describe("0179 function ACLs", () => {
  const sql = () => M0179();
  it.each(SERVICE_ONLY)("%s is service_role only", (fn) => {
    expect(sql()).toMatch(
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated;`),
    );
    expect(sql()).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role;`));
    expect(sql()).not.toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to [^;]*authenticated`));
  });
  it.each(STAFF_CALLABLE)("%s is callable by signed-in staff only", (fn) => {
    expect(sql()).toMatch(
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon;`),
    );
    expect(sql()).toMatch(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to authenticated, service_role;`),
    );
  });
  it("reception/admin-only functions check the role and raise 42501", () => {
    for (const fn of ["result_outdated_copies", "result_mark_copy_contacted"]) {
      const body = extractFunction(sql(), fn);
      expect(body).toMatch(/v_role not in \('reception', 'admin'\)/);
      expect(body).toMatch(/errcode = '42501'/);
    }
  });
  it("the list never selects a reason, a value snapshot or the notify error text", () => {
    const body = extractFunction(sql(), "result_outdated_copies");
    expect(body).not.toMatch(/\breason\b|prior_values|notify_error\s*[,)]/);
  });
});
