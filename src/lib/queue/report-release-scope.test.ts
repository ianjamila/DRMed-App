import { describe, expect, it } from "vitest";
import {
  fullReportReleaseBlock,
  PANEL_UNREADABLE,
  panelReleaseScope as scope,
  reportReleaseBlock,
  REPORT_REFUSAL,
  type FullMember,
  visitReportBlocks,
} from "./report-release-scope";

describe("reportReleaseBlock", () => {
  const mem = (status: string, deleted = false) => ({ status, deleted });
  it("is null when every live member is ready or released", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("released")])).toBeNull();
  });
  it("refuses a deleted, unreleased member first", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("ready_for_release", true)])).toBe(REPORT_REFUSAL.deletedMember);
  });
  it("counts unfinished live members", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("result_uploaded"), mem("in_progress")]))
      .toBe(REPORT_REFUSAL.notFinished(2));
  });
  it("ignores a deleted member that was released", () => {
    expect(reportReleaseBlock([mem("ready_for_release"), mem("released", true)])).toBeNull();
  });
});

const VISIT = "v1";
const ctx = { visitId: VISIT, sections: ["chemistry"] as readonly string[] | null };
const full = (id: string, status: string, over: Partial<FullMember> = {}): FullMember => ({
  id, status, deleted: false, visitId: VISIT, section: "chemistry", isPackageHeader: false, isDoctor: false, ...over,
});

describe("fullReportReleaseBlock", () => {
  const ok = [full("a", "ready_for_release"), full("b", "ready_for_release")];
  it("is null for a finished report inside the role's sections", () => {
    expect(fullReportReleaseBlock(ok, ctx)).toBeNull();
    expect(fullReportReleaseBlock(ok, { ...ctx, sections: null })).toBeNull();
  });
  it("treats a single link as a plain row, whatever its state", () => {
    expect(fullReportReleaseBlock([full("a", "in_progress", { deleted: true, isDoctor: true })], ctx)).toBeNull();
  });
  it("refuses outside_sections, including a null section, only for a restricted role", () => {
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { section: "hematology" })], ctx))
      .toBe(REPORT_REFUSAL.outside_sections);
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { section: null })], ctx))
      .toBe(REPORT_REFUSAL.outside_sections);
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { section: "hematology" })], { ...ctx, sections: null }))
      .toBeNull();
  });
  it("refuses a package header", () => {
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { isPackageHeader: true })], ctx))
      .toBe(REPORT_REFUSAL.package_header);
  });
  it("refuses a member on another visit", () => {
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { visitId: "v2" })], ctx))
      .toBe(REPORT_REFUSAL.other_visit);
  });
  it("refuses a doctor member", () => {
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { isDoctor: true })], ctx))
      .toBe(REPORT_REFUSAL.doctorMember);
  });
  it("refuses a deleted, unreleased member, then counts unfinished live ones", () => {
    expect(fullReportReleaseBlock([...ok, full("c", "ready_for_release", { deleted: true })], ctx))
      .toBe(REPORT_REFUSAL.deletedMember);
    expect(fullReportReleaseBlock([...ok, full("c", "in_progress")], ctx)).toBe(REPORT_REFUSAL.notFinished(1));
    expect(fullReportReleaseBlock([...ok, full("c", "released", { deleted: true })], ctx)).toBeNull();
  });
  it("follows the RPC's precedence", () => {
    const everything = [
      full("a", "in_progress", { deleted: true }),
      full("b", "ready_for_release", { section: "hematology", isPackageHeader: true, visitId: "v2", isDoctor: true }),
    ];
    expect(fullReportReleaseBlock(everything, ctx)).toBe(REPORT_REFUSAL.outside_sections);
    expect(fullReportReleaseBlock(everything, { ...ctx, sections: null })).toBe(REPORT_REFUSAL.package_header);
    const noHeader = [everything[0], { ...everything[1], isPackageHeader: false }];
    expect(fullReportReleaseBlock(noHeader, { ...ctx, sections: null })).toBe(REPORT_REFUSAL.other_visit);
    const sameVisit = [everything[0], { ...noHeader[1], visitId: VISIT }];
    expect(fullReportReleaseBlock(sameVisit, { ...ctx, sections: null })).toBe(REPORT_REFUSAL.doctorMember);
    const noDoctor = [everything[0], { ...sameVisit[1], isDoctor: false }];
    expect(fullReportReleaseBlock(noDoctor, { ...ctx, sections: null })).toBe(REPORT_REFUSAL.deletedMember);
  });
});

describe("panelReleaseScope", () => {
  const m = (id: string, status: string, resultId: string | null) => ({ id, status, resultId });
  // Full membership = just the panel's own members (same group, same visit, live).
  const panelReleaseScope = (members: ReturnType<typeof m>[]) => {
    const reports = new Map<string, FullMember[]>();
    for (const x of members) {
      if (x.resultId === null) continue;
      reports.set(x.resultId, [...(reports.get(x.resultId) ?? []), full(x.id, x.status)]);
    }
    return scope(members, reports, ctx);
  };

  it("blocks a report whose other member sits in another group and is unfinished, but sends a finished sibling", () => {
    const members = [m("a1", "ready_for_release", "R1"), m("b1", "ready_for_release", "R2")];
    const reports = new Map<string, FullMember[]>([
      ["R1", [full("a1", "ready_for_release"), full("x9", "in_progress")]], // x9: other report group
      ["R2", [full("b1", "ready_for_release"), full("b2", "ready_for_release")]],
    ]);
    const out = scope(members, reports, ctx);
    expect(out.readyIds).toEqual(["b1"]);
    expect(out.reportBlock).toBeNull();
    const alone = scope([members[0]], new Map([["R1", reports.get("R1")!]]), ctx);
    expect(alone).toEqual({ readyIds: [], reportBlock: REPORT_REFUSAL.notFinished(1) });
  });

  it("blocks a report with a deleted, unreleased cross-group member", () => {
    const out = scope(
      [m("a1", "ready_for_release", "R1")],
      new Map([["R1", [full("a1", "ready_for_release"), full("x9", "ready_for_release", { deleted: true })]]]),
      ctx,
    );
    expect(out).toEqual({ readyIds: [], reportBlock: REPORT_REFUSAL.deletedMember });
  });

  it("treats a single-link report as a plain row", () => {
    const out = scope(
      [m("a1", "ready_for_release", "R1")],
      new Map([["R1", [full("a1", "ready_for_release")]]]),
      ctx,
    );
    expect(out).toEqual({ readyIds: ["a1"], reportBlock: null });
  });

  it("fails closed for a report missing from the map, still sending unlinked rows", () => {
    expect(scope([m("a1", "ready_for_release", "R1")], new Map(), ctx))
      .toEqual({ readyIds: [], reportBlock: PANEL_UNREADABLE });
    expect(scope([m("x", "ready_for_release", null), m("a1", "ready_for_release", "R1")], new Map(), ctx))
      .toEqual({ readyIds: ["x"], reportBlock: null });
  });

  it("releases the finished report while a sibling report on the panel waits", () => {
    const out = panelReleaseScope([
      m("a1", "ready_for_release", "R1"),
      m("a2", "ready_for_release", "R1"),
      m("b1", "ready_for_release", "R2"),
      m("b2", "in_progress", "R2"),
    ]);
    expect(out.readyIds).toEqual(["a1", "a2"]);
    expect(out.reportBlock).toBeNull();
  });

  it("the old whole-group judgement would have blocked R1 (regression)", () => {
    const members = [m("a1", "ready_for_release", "R1"), m("b1", "in_progress", "R2")];
    // Old behaviour: one block over every linked member.
    const wholeGroup = reportReleaseBlock(members.map((x) => ({ status: x.status, deleted: false })));
    expect(wholeGroup).not.toBeNull();
    const out = panelReleaseScope(members);
    expect(out.readyIds).toEqual(["a1"]);
    expect(out.reportBlock).toBeNull();
  });

  it("returns the first report's block when every report is blocked", () => {
    const out = panelReleaseScope([
      m("a1", "ready_for_release", "R1"),
      m("a2", "in_progress", "R1"),
      m("b1", "ready_for_release", "R2"),
      m("b2", "in_progress", "R2"),
      m("b3", "in_progress", "R2"),
    ]);
    expect(out.readyIds).toEqual([]);
    expect(out.reportBlock).toBe(REPORT_REFUSAL.notFinished(1));
  });

  it("includes a ready member that has no report", () => {
    const out = panelReleaseScope([m("x", "ready_for_release", null)]);
    expect(out).toEqual({ readyIds: ["x"], reportBlock: null });
  });

  it("keeps an unlinked ready member alongside a blocked report", () => {
    const out = panelReleaseScope([
      m("x", "ready_for_release", null),
      m("a1", "ready_for_release", "R1"),
      m("a2", "in_progress", "R1"),
    ]);
    expect(out.readyIds).toEqual(["x"]);
    expect(out.reportBlock).toBeNull();
  });

  it("treats a part-released report as releasable", () => {
    const out = panelReleaseScope([m("a1", "released", "R1"), m("a2", "ready_for_release", "R1")]);
    expect(out).toEqual({ readyIds: ["a2"], reportBlock: null });
  });

  it("a fully released report contributes nothing and blocks nothing", () => {
    const out = panelReleaseScope([
      m("a1", "released", "R1"),
      m("a2", "released", "R1"),
      m("b1", "ready_for_release", "R2"),
    ]);
    expect(out).toEqual({ readyIds: ["b1"], reportBlock: null });
    expect(panelReleaseScope([m("a1", "released", "R1")])).toEqual({ readyIds: [], reportBlock: null });
  });

  it("preserves the members' original order", () => {
    const out = panelReleaseScope([
      m("c", "ready_for_release", "R2"),
      m("a", "ready_for_release", "R1"),
      m("b", "ready_for_release", null),
    ]);
    expect(out.readyIds).toEqual(["c", "a", "b"]);
  });
});

describe("visitReportBlocks", () => {
  it("blocks a result with ONE local line whose second link is on another visit", () => {
    const out = visitReportBlocks(
      new Map([["R1", ["a"]]]),
      new Map([["R1", [full("a", "ready_for_release"), full("x", "ready_for_release", { visitId: "v2" })]]]),
      ctx,
    );
    expect(out.get("a")).toBe(REPORT_REFUSAL.other_visit);
  });
  it("blocks a one-local-line result whose other link is a deleted unreleased test", () => {
    const out = visitReportBlocks(
      new Map([["R1", ["a"]]]),
      new Map([["R1", [full("a", "ready_for_release"), full("x", "in_progress", { deleted: true })]]]),
      ctx,
    );
    expect(out.get("a")).toBe(REPORT_REFUSAL.deletedMember);
  });
  it("blocks every local member of a blocked report and leaves a plain row alone", () => {
    const out = visitReportBlocks(
      new Map([["R1", ["a", "b"]], ["R2", ["c"]]]),
      new Map([
        ["R1", [full("a", "ready_for_release"), full("b", "in_progress")]],
        ["R2", [full("c", "ready_for_release")]],
      ]),
      ctx,
    );
    expect([...out.keys()]).toEqual(["a", "b"]);
  });
  it("fails closed when the read failed or a result is missing", () => {
    expect(visitReportBlocks(new Map([["R1", ["a"]]]), null, ctx).get("a")).toBe(PANEL_UNREADABLE);
    expect(visitReportBlocks(new Map([["R1", ["a"]]]), new Map(), ctx).get("a")).toBe(PANEL_UNREADABLE);
  });
});
