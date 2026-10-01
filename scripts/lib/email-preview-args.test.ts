import { describe, expect, it } from "vitest";
import { EXIT_USAGE, parseEmailPreviewArgs, previewFileBase } from "./email-preview-args";

describe("parseEmailPreviewArgs", () => {
  it("defaults to the weekly Patient Sources email for the real today", () => {
    expect(parseEmailPreviewArgs(["patient-sources"])).toEqual({ ok: true, email: "patient-sources", kind: "week", today: null });
  });
  it("--month picks the monthly email; --today overrides the date (both = and space forms)", () => {
    expect(parseEmailPreviewArgs(["patient-sources", "--month", "--today", "2026-10-01"])).toEqual({
      ok: true, email: "patient-sources", kind: "month", today: "2026-10-01",
    });
    expect(parseEmailPreviewArgs(["patient-sources", "--today=2026-10-05"])).toMatchObject({ ok: true, today: "2026-10-05" });
  });
  it("ignores the runner flags env-guard owns (--prod, --yes)", () => {
    expect(parseEmailPreviewArgs(["patient-sources", "--prod", "--yes"])).toMatchObject({ ok: true, kind: "week" });
  });
  it("refuses a missing or unknown email name, extra words, unknown flags and bad dates", () => {
    expect(parseEmailPreviewArgs([])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["receipts"])).toMatchObject({ ok: false, errors: [expect.stringMatching(/patient-sources/)] });
    expect(parseEmailPreviewArgs(["patient-sources", "extra"])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["patient-sources", "--send"])).toMatchObject({ ok: false, errors: [expect.stringMatching(/--send/)] });
    expect(parseEmailPreviewArgs(["patient-sources", "--today"])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["patient-sources", "--today", "2026-02-31"])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["patient-sources", "--today", "tomorrow"])).toMatchObject({ ok: false });
  });
  it("names the output files by period", () => {
    expect(previewFileBase("week", "2026-09-28")).toBe("patient-sources-week-2026-09-28");
    expect(previewFileBase("month", "2026-09-01")).toBe("patient-sources-month-2026-09-01");
    expect(EXIT_USAGE).toBe(64);
  });
});
