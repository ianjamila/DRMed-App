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
