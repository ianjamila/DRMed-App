import { describe, expect, it } from "vitest";
import { classifyFinaliseRelease } from "./finalise-release-outcome";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import type { VisitReleaseOutcome } from "@/lib/actions/visits/release-reports";

const ids = ["a", "b", "c"];
const out = (o: Partial<VisitReleaseOutcome>): VisitReleaseOutcome => ({
  changedIds: [],
  alsoReleasedIds: [],
  skipped: [],
  warnings: [],
  announced: [],
  ...o,
});
const skipAll = (reason: string) => ids.map((id) => ({ id, reason }));

describe("classifyFinaliseRelease", () => {
  it("a whole release is not deferred and carries no note", () => {
    expect(classifyFinaliseRelease(out({ changedIds: ids }), ids)).toEqual({
      releaseDeferred: false,
      deferredReason: null,
      releaseNote: null,
    });
  });

  it("counts pulled-in members as released", () => {
    expect(classifyFinaliseRelease(out({ changedIds: ["a"], alsoReleasedIds: ["b", "c"] }), ids).releaseDeferred).toBe(false);
  });

  it("a whole release the patient was not told about keeps the warning as a note", () => {
    const r = classifyFinaliseRelease(out({ changedIds: ids, warnings: ["couldn't confirm"] }), ids);
    expect(r).toEqual({ releaseDeferred: false, deferredReason: null, releaseNote: "couldn't confirm" });
  });

  it("the payment gate defers as payment", () => {
    expect(classifyFinaliseRelease(out({ skipped: skipAll(RELEASE_BLOCKED_UNPAID) }), ids).deferredReason).toBe("payment");
  });

  it("the consent gate defers as consent", () => {
    expect(classifyFinaliseRelease(out({ skipped: skipAll(RELEASE_BLOCKED_CONSENT) }), ids).deferredReason).toBe("consent");
  });

  it("a member still waiting on sign-off defers the WHOLE report as signoff", () => {
    const r = classifyFinaliseRelease(out({ skipped: skipAll(REPORT_REFUSAL.notFinished(1)) }), ids);
    expect(r).toEqual({ releaseDeferred: true, deferredReason: "signoff", releaseNote: null });
  });

  it("any other refusal defers with its reason as the note", () => {
    const r = classifyFinaliseRelease(out({ skipped: skipAll(REPORT_REFUSAL.deletedMember) }), ids);
    expect(r).toEqual({ releaseDeferred: true, deferredReason: "other", releaseNote: REPORT_REFUSAL.deletedMember });
  });

  it("nothing released and no reason given still defers, never claims success", () => {
    const r = classifyFinaliseRelease(out({}), ids);
    expect(r.releaseDeferred).toBe(true);
    expect(r.deferredReason).toBe("other");
    expect(r.releaseNote).toBeTruthy();
  });

  it("a part-released report (a race) is deferred with the report-changed reason", () => {
    const r = classifyFinaliseRelease(
      out({ changedIds: ["a"], skipped: [{ id: "b", reason: "report changed" }, { id: "c", reason: "raced" }] }),
      ids,
    );
    expect(r).toEqual({ releaseDeferred: true, deferredReason: "other", releaseNote: "report changed" });
  });

  it("prefers a warning over a skip reason for a part release", () => {
    const r = classifyFinaliseRelease(
      out({ changedIds: ["a", "b"], skipped: [{ id: "c", reason: "raced" }], warnings: ["report changed"] }),
      ids,
    );
    expect(r.releaseNote).toBe("report changed");
  });

  it("counts duplicate requested ids once", () => {
    expect(classifyFinaliseRelease(out({ changedIds: ["a", "b"] }), ["a", "b", "a"]).releaseDeferred).toBe(false);
  });
});
