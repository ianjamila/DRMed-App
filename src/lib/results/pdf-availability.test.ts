import { describe, expect, it } from "vitest";
import { newestLinkWithPdf, pdfStates, reportCardKey } from "./pdf-availability";

const link = (id: string, result: string, at: string, path: string | null) => ({
  test_request_id: id,
  result_id: result,
  created_at: at,
  results: { storage_path: path },
});
const sib = (result: string, status: string) => ({
  result_id: result,
  test_requests: { status },
});

describe("newestLinkWithPdf", () => {
  it("keeps a test whose only link has a stored file", () => {
    expect(newestLinkWithPdf([link("a", "r1", "2026-09-24T01:00:00+00:00", "a.pdf")])).toEqual(
      new Map([["a", "r1"]]),
    );
  });

  it("drops a test whose result has no file yet", () => {
    expect(newestLinkWithPdf([link("a", "r1", "2026-09-24T01:00:00+00:00", null)]).size).toBe(0);
  });

  it("judges by the NEWEST link, the one the PDF route streams", () => {
    // Older link had a file, newest does not: the route would 404.
    expect(
      newestLinkWithPdf([
        link("a", "r1", "2026-09-24T01:00:00+00:00", "old.pdf"),
        link("a", "r2", "2026-09-24T02:00:00+00:00", null),
      ]).has("a"),
    ).toBe(false);
    // And the other way round, in either input order — naming the new result.
    expect(
      newestLinkWithPdf([
        link("b", "r2", "2026-09-24T02:00:00+00:00", "new.pdf"),
        link("b", "r1", "2026-09-24T01:00:00+00:00", null),
      ]).get("b"),
    ).toBe("r2");
  });

  it("reads an embed PostgREST returns as an array", () => {
    expect(
      newestLinkWithPdf([
        { ...link("a", "r1", "2026-09-24T01:00:00+00:00", null), results: [{ storage_path: "a.pdf" }] },
      ]).has("a"),
    ).toBe(true);
  });
});

describe("pdfStates", () => {
  it("marks a single-test result released when its one line is", () => {
    expect(pdfStates(new Map([["a", "r1"]]), [sib("r1", "released")]).get("a")).toEqual({
      resultId: "r1",
      reportReleased: true,
    });
  });

  it("marks EVERY member of a shared report unreleased while one sibling is not released", () => {
    // Consolidated chemistry: FBS released, Creatinine undone back to ready.
    const states = pdfStates(new Map([["fbs", "r1"], ["crea", "r1"]]), [
      sib("r1", "released"),
      sib("r1", "ready_for_release"),
    ]);
    expect(states.get("fbs")?.reportReleased).toBe(false);
    expect(states.get("crea")?.reportReleased).toBe(false);
  });

  it("fails closed when no sibling statuses were read", () => {
    expect(pdfStates(new Map([["a", "r1"]]), []).get("a")?.reportReleased).toBe(false);
  });
});

describe("reportCardKey", () => {
  it("folds a panel into one card on the worklist tabs, whatever its files", () => {
    expect(reportCardKey("v1", "chem", "r1", false)).toBe(reportCardKey("v1", "chem", "r2", false));
  });

  it("gives each PDF of a split panel its own card on Released today", () => {
    expect(reportCardKey("v1", "chem", "r1", true)).not.toBe(reportCardKey("v1", "chem", "r2", true));
    expect(reportCardKey("v1", "chem", "r1", true)).toBe(reportCardKey("v1", "chem", "r1", true));
  });

  it("keeps tests with no file together, apart from any file", () => {
    expect(reportCardKey("v1", "chem", undefined, true)).toBe(reportCardKey("v1", "chem", undefined, true));
    expect(reportCardKey("v1", "chem", undefined, true)).not.toBe(reportCardKey("v1", "chem", "r1", true));
  });
});
