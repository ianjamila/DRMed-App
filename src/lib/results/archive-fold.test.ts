import { describe, expect, it } from "vitest";
import { foldArchiveRows, type ArchiveResultLink, type ArchiveTestRow } from "./archive-fold";

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
