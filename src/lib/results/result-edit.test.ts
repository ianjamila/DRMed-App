import { describe, expect, it } from "vitest";
import {
  EDITABLE_STATUSES,
  isEditableStatus,
  validateEditReason,
  editVersionPath,
  versionBase,
  classifyCommitError,
  countValueChanges,
  type ComparableValue,
} from "./result-edit";

describe("EDITABLE_STATUSES / isEditableStatus", () => {
  it("lists exactly the three post-bench statuses", () => {
    expect(EDITABLE_STATUSES).toEqual(["result_uploaded", "ready_for_release", "released"]);
  });

  it("is true for each editable status", () => {
    for (const s of EDITABLE_STATUSES) {
      expect(isEditableStatus(s)).toBe(true);
    }
  });

  it("is false for a status before or outside the finished set", () => {
    for (const s of ["requested", "in_progress", "cancelled", "", "RELEASED"]) {
      expect(isEditableStatus(s)).toBe(false);
    }
  });
});

describe("validateEditReason", () => {
  it("accepts a reason within bounds and returns it trimmed", () => {
    const got = validateEditReason("  wrong reference range applied  ");
    expect(got).toEqual({ ok: true, reason: "wrong reference range applied" });
  });

  it("rejects a reason shorter than 5 characters", () => {
    const got = validateEditReason("abcd");
    expect(got).toEqual({
      ok: false,
      error: "Please describe the reason for the edit (5+ characters).",
    });
  });

  it("accepts exactly 5 characters", () => {
    expect(validateEditReason("abcde")).toEqual({ ok: true, reason: "abcde" });
  });

  it("rejects based on the TRIMMED length, not the raw length", () => {
    // Raw is 9 characters but only 2 survive trim() — must fail the min bound.
    const got = validateEditReason("  ab  ");
    expect(got).toEqual({
      ok: false,
      error: "Please describe the reason for the edit (5+ characters).",
    });
  });

  it("accepts exactly 2000 characters", () => {
    const reason = "a".repeat(2000);
    expect(validateEditReason(reason)).toEqual({ ok: true, reason });
  });

  it("rejects 2001 characters", () => {
    const reason = "a".repeat(2001);
    expect(validateEditReason(reason)).toEqual({
      ok: false,
      error: "Reason is too long (2000 characters max).",
    });
  });

  it("treats a non-string input as an empty reason", () => {
    for (const raw of [undefined, null, 42, {}, [], true]) {
      expect(validateEditReason(raw)).toEqual({
        ok: false,
        error: "Please describe the reason for the edit (5+ characters).",
      });
    }
  });
});

describe("editVersionPath", () => {
  const attemptId = "3f9a2b71-1111-2222-3333-444455556666";

  it("appends .v<next>.<8-hex-token>.<ext> with the default pdf extension", () => {
    expect(editVersionPath("patient/visit/tr", 2, attemptId)).toBe(
      "patient/visit/tr.v2.3f9a2b71.pdf",
    );
  });

  it("uses the first 8 hex characters of the attempt id with dashes stripped", () => {
    // attemptId with dashes removed is "3f9a2b71111122223333444455556666";
    // the first 8 characters of THAT string are "3f9a2b71".
    const token = attemptId.replace(/-/g, "").slice(0, 8);
    expect(token).toBe("3f9a2b71");
    expect(editVersionPath("base", 3, attemptId)).toContain(`.${token}.`);
  });

  it("honours a custom extension", () => {
    expect(editVersionPath("patient/visit/img", 5, attemptId, "jpg")).toBe(
      "patient/visit/img.v5.3f9a2b71.jpg",
    );
  });
});

describe("versionBase", () => {
  it("strips a bare .pdf extension", () => {
    expect(versionBase("3f9a2b71-1111-2222-3333-444455556666.pdf")).toBe(
      "3f9a2b71-1111-2222-3333-444455556666",
    );
  });

  it("strips .vN.pdf", () => {
    expect(versionBase("patient/visit/tr.v3.pdf")).toBe("patient/visit/tr");
  });

  it("strips .vN.<8-hex-token>.pdf", () => {
    expect(versionBase("patient/visit/tr.v3.abcdef12.pdf")).toBe("patient/visit/tr");
  });

  it("leaves a base with no extension and no version alone", () => {
    expect(versionBase("patient/visit/tr")).toBe("patient/visit/tr");
  });

  it("handles the consolidated combined-report path (<uuid>.pdf)", () => {
    const uuid = "3f9a2b71-1111-2222-3333-444455556666";
    expect(versionBase(`${uuid}.pdf`)).toBe(uuid);
    expect(versionBase(`${uuid}.v4.deadbeef.pdf`)).toBe(uuid);
  });

  it("handles the single-test path (<patient>/<visit>/<tr>.v2.pdf)", () => {
    expect(versionBase("patientId/visitId/trId.v2.pdf")).toBe("patientId/visitId/trId");
  });
});

describe("classifyCommitError", () => {
  it("classifies a P0065 stale-edit code as rejected", () => {
    expect(classifyCommitError({ code: "P0065" })).toBe("rejected");
  });

  it("classifies a Postgres SQLSTATE (23505) as rejected", () => {
    expect(classifyCommitError({ code: "23505" })).toBe("rejected");
  });

  it("classifies a PostgREST code (PGRST116) as rejected", () => {
    expect(classifyCommitError({ code: "PGRST116" })).toBe("rejected");
  });

  it("classifies undefined/null as unknown", () => {
    expect(classifyCommitError(undefined)).toBe("unknown");
    expect(classifyCommitError(null)).toBe("unknown");
  });

  it("classifies an empty object and an empty code as unknown", () => {
    expect(classifyCommitError({})).toBe("unknown");
    expect(classifyCommitError({ code: "" })).toBe("unknown");
  });

  it("classifies a thrown network error (no real Postgres/PostgREST code) as unknown", () => {
    expect(classifyCommitError({ code: "ECONNRESET" })).toBe("unknown");
    expect(classifyCommitError({ code: "fetch failed" })).toBe("unknown");
  });
});

describe("countValueChanges", () => {
  function v(overrides: Partial<ComparableValue> = {}): ComparableValue {
    return {
      numeric_value_si: 1,
      numeric_value_conv: null,
      text_value: null,
      select_value: null,
      is_blank: false,
      ...overrides,
    };
  }

  it("counts zero when nothing changed", () => {
    const prior = new Map([["p1", v()]]);
    const next = new Map([["p1", v()]]);
    expect(countValueChanges(prior, next)).toBe(0);
  });

  it("counts a parameter added in next", () => {
    const prior = new Map<string, ComparableValue>();
    const next = new Map([["p1", v()]]);
    expect(countValueChanges(prior, next)).toBe(1);
  });

  it("counts a parameter removed (present in prior, absent from next)", () => {
    const prior = new Map([["p1", v()]]);
    const next = new Map<string, ComparableValue>();
    expect(countValueChanges(prior, next)).toBe(1);
  });

  it("counts a parameter whose value changed on a single field", () => {
    const prior = new Map([["p1", v({ numeric_value_si: 1 })]]);
    const next = new Map([["p1", v({ numeric_value_si: 2 })]]);
    expect(countValueChanges(prior, next)).toBe(1);
  });

  it("counts each field independently able to trigger a change", () => {
    const base = v();
    expect(
      countValueChanges(
        new Map([["p1", base]]),
        new Map([["p1", { ...base, numeric_value_conv: 5 }]]),
      ),
    ).toBe(1);
    expect(
      countValueChanges(
        new Map([["p1", base]]),
        new Map([["p1", { ...base, text_value: "changed" }]]),
      ),
    ).toBe(1);
    expect(
      countValueChanges(
        new Map([["p1", base]]),
        new Map([["p1", { ...base, select_value: "high" }]]),
      ),
    ).toBe(1);
    expect(
      countValueChanges(
        new Map([["p1", base]]),
        new Map([["p1", { ...base, is_blank: true }]]),
      ),
    ).toBe(1);
  });

  it("sums independent adds, removes and changes in one pass", () => {
    const prior = new Map([
      ["kept-same", v()],
      ["kept-changed", v({ numeric_value_si: 1 })],
      ["removed", v()],
    ]);
    const next = new Map([
      ["kept-same", v()],
      ["kept-changed", v({ numeric_value_si: 2 })],
      ["added", v()],
    ]);
    expect(countValueChanges(prior, next)).toBe(3);
  });
});
