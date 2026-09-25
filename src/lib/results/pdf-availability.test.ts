import { describe, expect, it } from "vitest";
import {
  newestLinkWithPdf,
  pdfStates,
  printAllFiles,
  reportCardKey,
  type PdfState,
} from "./pdf-availability";

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
      version: 0,
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

  it("carries the file's amendment version, 0 when unknown", () => {
    const states = pdfStates(new Map([["a", "r1"], ["b", "r2"]]), [sib("r1", "released"), sib("r2", "released")], new Map([["r1", 2]]));
    expect(states.get("a")?.version).toBe(2);
    expect(states.get("b")?.version).toBe(0);
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

describe("printAllFiles", () => {
  const line = (id: string, over: Partial<{ section: string | null; status: string; kind: string | null; deleted: boolean }> = {}) => ({
    id,
    section: "chemistry",
    status: "released",
    kind: "lab_test",
    deleted: false,
    ...over,
  });
  const state = (resultId: string, reportReleased = true): PdfState => ({ resultId, version: 0, reportReleased });

  it("combines each released file once, in line order, with its lines", () => {
    const files = printAllFiles(
      "reception",
      [line("fbs"), line("cbc", { section: "hematology" }), line("crea")],
      new Map([["fbs", state("chem")], ["cbc", state("cbc")], ["crea", state("chem")]]),
    );
    expect(files).toEqual([
      { resultId: "chem", testIds: ["fbs", "crea"] },
      { resultId: "cbc", testIds: ["cbc"] },
    ]);
  });

  it("leaves out a shared file with an unreleased member, for lab roles too", () => {
    const states = new Map([["fbs", state("chem", false)]]);
    expect(printAllFiles("reception", [line("fbs")], states)).toEqual([]);
    expect(printAllFiles("admin", [line("fbs")], states)).toEqual([]);
  });

  it("skips unreleased, deleted, fileless and doctor lines", () => {
    const files = printAllFiles(
      "reception",
      [
        line("bench", { status: "ready_for_release" }),
        line("gone", { deleted: true }),
        line("nofile"),
        line("consult", { section: null, kind: "doctor_consultation" }),
      ],
      new Map([["bench", state("r1")], ["gone", state("r2")], ["consult", state("r3")]]),
    );
    expect(files).toEqual([]);
  });

  it("keeps a medtech to the sections it may open", () => {
    const states = new Map([["xr", state("r1")]]);
    expect(printAllFiles("medtech", [line("xr", { section: "imaging_xray" })], states)).toEqual([]);
    expect(printAllFiles("admin", [line("xr", { section: "imaging_xray" })], states)).toHaveLength(1);
  });
});
