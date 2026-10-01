import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { racedStructuredDraftOutcome, sharedReportVerdict } from "./create-linked";

const draft = { generation_kind: "structured", finalised_at: null, report_group_id: null };

// Pure branch logic behind prepareStructured's P0066 handling (0184): after
// losing the race to result_create_linked, is the winner's row something this
// caller can safely continue against?
describe("racedStructuredDraftOutcome", () => {
  it("continues onto an open single-test structured draft", () => {
    expect(racedStructuredDraftOutcome(draft, 1)).toBe("continue");
  });

  it("sends the user to the combined report when the winner started a consolidated draft", () => {
    expect(racedStructuredDraftOutcome({ ...draft, report_group_id: "rg-chem" }, 1)).toBe("combined_report");
    expect(racedStructuredDraftOutcome({ ...draft, report_group_id: "rg-chem" }, 5)).toBe("combined_report");
  });

  it("treats a draft linked to more than one test as a combined report even without a report group", () => {
    expect(racedStructuredDraftOutcome(draft, 2)).toBe("combined_report");
  });

  it("names the combined report even when it is already finalised", () => {
    expect(
      racedStructuredDraftOutcome({ ...draft, report_group_id: "rg-chem", finalised_at: "2026-09-28T00:00:00+00:00" }, 5),
    ).toBe("combined_report");
  });

  it("refuses when the winner uploaded a PDF instead", () => {
    expect(racedStructuredDraftOutcome({ ...draft, generation_kind: "uploaded" }, 1)).toBe("refuse");
  });

  it("refuses when the winner's structured result is already finalised", () => {
    expect(racedStructuredDraftOutcome({ ...draft, finalised_at: "2026-09-28T00:00:00+00:00" }, 1)).toBe("refuse");
  });

  it("refuses when no link was found at all (e.g. the race was on a test that no longer exists)", () => {
    expect(racedStructuredDraftOutcome(null, 0)).toBe("refuse");
    expect(racedStructuredDraftOutcome(undefined, 0)).toBe("refuse");
  });

  // Codex review of #268: a failed membership count used to read as 0 and let
  // the single-test path write over a shared report.
  it("asks for a retry when the membership count could not be read, or is not a verified one", () => {
    expect(racedStructuredDraftOutcome(draft, null)).toBe("retry");
    expect(racedStructuredDraftOutcome(draft, 0)).toBe("retry");
  });

  it("still names the combined report when the group is known, whatever the count read did", () => {
    expect(racedStructuredDraftOutcome({ ...draft, report_group_id: "rg-chem" }, null)).toBe("combined_report");
  });
});

describe("sharedReportVerdict", () => {
  it("is single only on a verified count of exactly one", () => {
    expect(sharedReportVerdict(false, 1)).toBe("single");
    expect(sharedReportVerdict(false, 0)).toBe("unknown");
    expect(sharedReportVerdict(false, null)).toBe("unknown");
  });

  it("is shared for a report group or more than one linked test", () => {
    expect(sharedReportVerdict(true, null)).toBe("shared");
    expect(sharedReportVerdict(true, 1)).toBe("shared");
    expect(sharedReportVerdict(false, 2)).toBe("shared");
  });
});
