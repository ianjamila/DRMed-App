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

// 0188 drops and re-creates result_outdated_copies to add notify_problem. It
// must be 0179's function with exactly that column and its CASE added — the
// security definer, the reception/admin 42501 gate, the 0167 active-patient
// join and the "no error text" rule all carry over — and restate 0179's ACL.
describe("0188 result_outdated_copies = 0179's + notify_problem", () => {
  const M0188 = read("0188_result_followups_notify_problem.sql");
  const body0188 = () => {
    const start = M0188.indexOf("create function public.result_outdated_copies(");
    expect(start).toBeGreaterThan(-1);
    return M0188.slice(start, M0188.indexOf("\n$$;", start) + "\n$$;".length);
  };

  it("differs from 0179's body only by the new column and its CASE", () => {
    const expected = applyHunks(extractFunction(M0179(), "result_outdated_copies"), [
      { label: "create (after the drop)", from: "create or replace function public.result_outdated_copies(", to: "create function public.result_outdated_copies(" },
      { label: "notify_problem OUT column", from: "  notify_failed       boolean\n)", to: "  notify_failed       boolean,\n  notify_problem      text\n)" },
      {
        label: "notify_problem CASE",
        from: "           (s.notify_error is not null)\n",
        to: [
          "           (s.notify_error is not null),",
          "           -- 0188: a coarse category, never the raw text (which can carry",
          "           -- provider messages). notify-corrected.ts writes these prefixes.",
          "           case",
          "             when s.notify_error is null then null",
          "             when s.notify_error like 'notices not set up%' then 'not_set_up'",
          "             when s.notify_error = 'no contact on file' then 'no_contact'",
          "             else 'send_error'",
          "           end",
          "",
        ].join("\n"),
      },
    ]);
    expect(body0188()).toBe(expected);
  });

  it("drops the old signature first and restates 0179's ACL", () => {
    expect(M0188).toMatch(/drop function public\.result_outdated_copies\(boolean\);/);
    expect(M0188).toMatch(/revoke all on function public\.result_outdated_copies\(boolean\) from public, anon;/);
    expect(M0188).toMatch(/grant execute on function public\.result_outdated_copies\(boolean\) to authenticated, service_role;/);
  });

  it("still never returns the raw notify error text", () => {
    expect(body0188()).not.toMatch(/\breason\b|prior_values|notify_error\s*[,)]/);
  });
});

// 0188's retry claim re-opens a send slot, so every condition that keeps a
// retry from double-sending — or from retrying what a retry can't fix — is
// pinned, along with its service_role-only ACL.
describe("0188 result_retry_patient_notify", () => {
  const M0188 = read("0188_result_followups_notify_problem.sql");
  const fn = () => {
    const start = M0188.indexOf("create function public.result_retry_patient_notify(");
    expect(start).toBeGreaterThan(-1);
    return M0188.slice(start, M0188.indexOf("\n$$;", start));
  };
  it.each([
    ["the latest correction only", "ra.amendment_seq = (select r.amendment_count from public.results r where r.id = ra.result_id)"],
    ["nobody contacted yet", "ra.patient_contacted_at is null"],
    ["an attempt was made", "ra.patient_notified_at is not null"],
    ["it reached no channel", "coalesce(cardinality(ra.patient_notified_channels), 0) = 0"],
    ["it failed", "ra.patient_notify_error is not null"],
    ["not because notices aren't set up", "ra.patient_notify_error not like 'notices not set up%'"],
    ["not because there's no contact", "ra.patient_notify_error <> 'no contact on file'"],
  ])("only re-opens %s", (_label, clause) => {
    expect(fn()).toContain(clause);
  });
  it("claims by clearing the outcome in the same UPDATE (a second click matches nothing)", () => {
    expect(fn()).toMatch(/set patient_notified_at\s+= now\(\),\s+patient_notified_channels = null,\s+patient_notify_error\s+= null/);
  });
  it("is service_role only", () => {
    expect(M0188).toMatch(/revoke all on function public\.result_retry_patient_notify\(uuid\) from public, anon, authenticated;/);
    expect(M0188).toMatch(/grant execute on function public\.result_retry_patient_notify\(uuid\) to service_role;/);
    expect(M0188).not.toMatch(/grant execute on function public\.result_retry_patient_notify\(uuid\) to [^;]*authenticated/);
  });
});
