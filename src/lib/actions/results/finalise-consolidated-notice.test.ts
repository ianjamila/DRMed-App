import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// finalise-consolidated.ts renders a PDF and can't run under vitest, so its
// result.released audit is pinned by source (as money-settled.test.ts pins
// SQL): patient_notified must come from the REAL notice outcome
// (noticeAuditMeta, tested in release-notice-outcome.test.ts), never from
// "something was announced" — that said true for a sample visit, a patient
// with no contact details, an inactive recipient and a failed send.
const src = readFileSync(
  join(process.cwd(), "src/lib/actions/results/finalise-consolidated.ts"),
  "utf8",
);

describe("finalise-consolidated result.released audit", () => {
  it("records the real notice outcome", () => {
    const at = src.indexOf('action: "result.released"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("});", at));
    expect(block).toContain("...noticeAuditMeta(releaseOut?.notice)");
  });

  it("never derives patient_notified from what was announced", () => {
    expect(src).not.toMatch(/patient_notified:\s*\(?\s*releaseOut\?\.announced/);
  });
});
