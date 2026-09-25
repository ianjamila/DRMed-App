import { describe, expect, it } from "vitest";
import {
  foldArchiveRows,
  reportMembershipOnPage,
  type ArchiveResultLink,
  type ArchiveTestRow,
} from "./archive-fold";

const CHEM = "grp-chem";

function row(
  id: string,
  visitId: string,
  opts: Partial<ArchiveTestRow> = {},
): ArchiveTestRow {
  return {
    id,
    status: "released",
    requestedAt: "2026-09-24T08:00:00Z",
    completedAt: null,
    releasedAt: null,
    code: id.toUpperCase(),
    name: id.toUpperCase(),
    reportGroupId: null,
    reportGroupName: null,
    visit: { id: visitId, visitNumber: visitId, patient: null },
    ...opts,
  };
}
const chem = (id: string, visitId: string, opts: Partial<ArchiveTestRow> = {}) =>
  row(id, visitId, { reportGroupId: CHEM, reportGroupName: "Chemistry", ...opts });

const link = (resultId: string, hasPdf = true, amendmentCount = 0): ArchiveResultLink => ({
  resultId,
  hasPdf,
  amendedAt: amendmentCount > 0 ? "2026-09-24T09:00:00Z" : null,
  amendmentCount,
});

describe("foldArchiveRows", () => {
  it("folds a chemistry panel sharing one PDF into ONE item with one PDF", () => {
    const rows = ["bun", "fbs", "chol"].map((id) => chem(id, "v1"));
    const links = new Map(rows.map((r) => [r.id, link("r1")]));
    const [v] = foldArchiveRows(rows, links, () => null);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({
      kind: "report",
      label: "Chemistry",
      resultId: "r1",
      pdfTestRequestId: "bun",
    });
    expect(v.items[0].tests.map((t) => t.id)).toEqual(["bun", "fbs", "chol"]);
    expect(v.statuses).toHaveLength(3);
  });

  it("keeps single tests as their own items, in query order around the report", () => {
    const rows = [row("cbc", "v1"), chem("bun", "v1"), row("ua", "v1"), chem("fbs", "v1")];
    const links = new Map<string, ArchiveResultLink>([
      ["cbc", link("rc")],
      ["bun", link("r1")],
      ["fbs", link("r1")],
    ]);
    const [v] = foldArchiveRows(rows, links, () => null);
    expect(v.items.map((i) => i.key)).toEqual(["cbc", "result:r1", "ua"]);
    expect(v.items[2].pdfTestRequestId).toBeNull();
  });

  it("keeps two finished reports for one visit + group separate", () => {
    const rows = [chem("a", "v1"), chem("b", "v1"), chem("late", "v1")];
    const links = new Map<string, ArchiveResultLink>([
      ["a", link("r1")],
      ["b", link("r1")],
      ["late", link("r2")],
    ]);
    const [v] = foldArchiveRows(rows, links, () => null);
    expect(v.items.map((i) => i.resultId)).toEqual(["r1", "r2"]);
  });

  it("groups unfinished chemistry into one pending item with no PDF", () => {
    const rows = [chem("a", "v1", { status: "requested" }), chem("b", "v1", { status: "in_progress" })];
    const [v] = foldArchiveRows(rows, new Map(), () => null);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ key: `group:${CHEM}`, resultId: null, pdfTestRequestId: null });
  });

  it("carries the amendment marker on the report, not per test", () => {
    const rows = [chem("a", "v1"), chem("b", "v1")];
    const links = new Map(rows.map((r) => [r.id, link("r1", true, 2)]));
    const [v] = foldArchiveRows(rows, links, () => null);
    expect(v.items[0].amendmentCount).toBe(2);
    expect(v.items[0].amendedAt).not.toBeNull();
  });

  it("preserves visit order and folds timestamps across the visit", () => {
    const rows = [
      row("x", "v2", { requestedAt: "2026-09-24T10:00:00Z", releasedAt: "2026-09-24T11:00:00Z" }),
      row("y", "v1"),
      row("z", "v2", { requestedAt: "2026-09-24T09:00:00Z", releasedAt: "2026-09-24T12:00:00Z" }),
    ];
    const out = foldArchiveRows(rows, new Map(), (r) => r.visit.id);
    expect(out.map((v) => v.visitId)).toEqual(["v2", "v1"]);
    expect(out[0].requestedAt).toBe("2026-09-24T09:00:00Z");
    expect(out[0].releasedAt).toBe("2026-09-24T12:00:00Z");
    expect(out[0].extra).toBe("v2");
  });
});

describe("reportMembershipOnPage", () => {
  it("says the plain count when every live member is on this page", () => {
    expect(reportMembershipOnPage({ shown: 8, full: 8 })).toEqual({
      text: "8 tests",
      partial: false,
    });
  });

  it("says '<shown> of <full> tests shown' and flags partial when members are missing", () => {
    expect(reportMembershipOnPage({ shown: 3, full: 8 })).toEqual({
      text: "3 of 8 tests shown",
      partial: true,
    });
  });

  it("handles two reports independently — one full, one partial", () => {
    expect(reportMembershipOnPage({ shown: 2, full: 2 }).partial).toBe(false);
    expect(reportMembershipOnPage({ shown: 1, full: 2 }).partial).toBe(true);
  });

  it("says just the shown count with no 'of N' for an unfinished grouped report (no result yet)", () => {
    expect(reportMembershipOnPage({ shown: 2, full: null })).toEqual({
      text: "2 tests",
      partial: false,
    });
  });

  it("singularises a lone test either way", () => {
    expect(reportMembershipOnPage({ shown: 1, full: 1 }).text).toBe("1 test");
    expect(reportMembershipOnPage({ shown: 1, full: null }).text).toBe("1 test");
  });

  it("fails closed (not partial) rather than reading backward when shown somehow exceeds full", () => {
    expect(reportMembershipOnPage({ shown: 5, full: 3 })).toEqual({
      text: "5 tests",
      partial: false,
    });
  });
});
