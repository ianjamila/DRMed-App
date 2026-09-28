import { describe, expect, it } from "vitest";
import { membersWithinSections, resultsMemberSections } from "./report-section-gate";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { canViewResultPdf } from "@/lib/visits/line-visibility";

describe("membersWithinSections — the every-member rule for a shared PDF", () => {
  const medtech = sectionsForRole("medtech");

  it("lets an unrestricted role (admin, pathologist) open any file", () => {
    expect(membersWithinSections(sectionsForRole("admin"), ["chemistry", "imaging_xray", null])).toBe(true);
    expect(membersWithinSections(null, [])).toBe(true);
  });

  it("needs EVERY member inside a lab role's sections", () => {
    expect(membersWithinSections(medtech, ["chemistry", "chemistry"])).toBe(true);
    expect(membersWithinSections(medtech, ["chemistry", "imaging_xray"])).toBe(false);
  });

  it("treats a NULL section as outside every list (SQL mirror)", () => {
    expect(membersWithinSections(medtech, ["chemistry", null])).toBe(false);
  });

  it("fails closed when no members were read back", () => {
    expect(membersWithinSections(medtech, [])).toBe(false);
  });

  it("denies a role with no lab sections", () => {
    expect(membersWithinSections(sectionsForRole("reception"), ["chemistry"])).toBe(false);
  });
});

describe("canViewResultPdf with memberSections", () => {
  const chemLine = { section: "chemistry", status: "ready_for_release", kind: "lab_test", reportReleased: false };

  it("keeps the old answer when no member list is passed", () => {
    expect(canViewResultPdf("medtech", chemLine)).toBe(true);
  });

  it("refuses a lab role a shared report with a member outside its sections", () => {
    expect(canViewResultPdf("medtech", { ...chemLine, memberSections: ["chemistry", "imaging_xray"] })).toBe(false);
    expect(canViewResultPdf("xray_technician", { ...chemLine, section: "imaging_xray", memberSections: ["imaging_xray", "chemistry"] })).toBe(false);
  });

  it("allows the lab role when it covers every member, at any finished or unfinished status", () => {
    expect(canViewResultPdf("medtech", { ...chemLine, memberSections: ["chemistry", "chemistry"] })).toBe(true);
    expect(canViewResultPdf("medtech", { ...chemLine, status: "in_progress", memberSections: ["chemistry"] })).toBe(true);
  });

  it("leaves reception's #221 rule alone: released lines of fully released files, any sections", () => {
    const released = { ...chemLine, status: "released", reportReleased: true, memberSections: ["chemistry", "imaging_xray"] };
    expect(canViewResultPdf("reception", released)).toBe(true);
    expect(canViewResultPdf("reception", { ...released, reportReleased: false })).toBe(false);
  });

  it("admin and pathologist are never narrowed", () => {
    expect(canViewResultPdf("admin", { ...chemLine, memberSections: ["chemistry", null] })).toBe(true);
    expect(canViewResultPdf("pathologist", { ...chemLine, memberSections: [] })).toBe(true);
  });
});

describe("resultsMemberSections — the batch reader", () => {
  // Same shape as resultMemberSections's embed, with result_id alongside it.
  function fakeDb(
    rows: { result_id: string; test_requests: { services: { section: string | null } } }[] | null,
    error: { message: string } | null = null,
  ) {
    return {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: rows, error }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("groups sections by result_id across many results in one read", async () => {
    const db = fakeDb([
      { result_id: "r1", test_requests: { services: { section: "chemistry" } } },
      { result_id: "r1", test_requests: { services: { section: "chemistry" } } },
      { result_id: "r2", test_requests: { services: { section: "imaging_xray" } } },
    ]);
    const out = await resultsMemberSections(db, ["r1", "r2"]);
    expect(out?.get("r1")).toEqual(["chemistry", "chemistry"]);
    expect(out?.get("r2")).toEqual(["imaging_xray"]);
  });

  it("returns null on a read error — callers must fail closed", async () => {
    const db = fakeDb(null, { message: "boom" });
    expect(await resultsMemberSections(db, ["r1"])).toBeNull();
  });

  it("a result with no rows read back is simply absent from the map (deny via membersWithinSections([]))", async () => {
    const db = fakeDb([]);
    const out = await resultsMemberSections(db, ["r1"]);
    expect(out?.has("r1")).toBe(false);
    expect(membersWithinSections(sectionsForRole("medtech"), out?.get("r1") ?? [])).toBe(false);
  });
});
