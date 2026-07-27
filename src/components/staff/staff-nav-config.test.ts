import { describe, expect, it } from "vitest";
import {
  isSectionActive,
  visibleNavFor,
  STAFF_NAV,
  type StaffNavSection,
  type StaffRole,
} from "./staff-nav-config";

const ALL_ROLES: StaffRole[] = [
  "reception",
  "medtech",
  "pathologist",
  "admin",
  "xray_technician",
];

function section(sections: StaffNavSection[], heading: string) {
  return sections.find((s) => s.heading === heading);
}

function hrefsIn(section: StaffNavSection | undefined): string[] {
  if (!section) return [];
  return [
    ...(section.items ?? []).map((i) => i.href),
    ...(section.subgroups ?? []).flatMap((g) => g.items.map((i) => i.href)),
  ];
}

function allHrefs(sections: StaffNavSection[]): string[] {
  return sections.flatMap((s) => hrefsIn(s));
}

describe("My payslips is reachable by every role", () => {
  // Partner revision item 8 makes "Hidden tabs" admin-only. Payslips are
  // self-service for ALL staff, so the item must live in a role-visible
  // section (Personal) — not in the parked one.
  it.each(ALL_ROLES)("%s sees My payslips under Personal", (role) => {
    const personal = section(visibleNavFor(role), "Personal");
    expect(hrefsIn(personal)).toContain("/staff/payslips");
  });

  it("no longer parks My payslips under Hidden tabs", () => {
    const hidden = STAFF_NAV.find((s) => s.heading === "Hidden tabs");
    expect(hrefsIn(hidden)).not.toContain("/staff/payslips");
  });
});

describe("Hidden tabs is admin-only", () => {
  it("is declared admin-only and collapsible in the config", () => {
    const hidden = STAFF_NAV.find((s) => s.heading === "Hidden tabs");
    expect(hidden?.adminOnly).toBe(true);
    expect(hidden?.collapsible).toBe(true);
  });

  it.each(ALL_ROLES.filter((r) => r !== "admin"))(
    "%s does not see the Hidden tabs section",
    (role) => {
      expect(section(visibleNavFor(role), "Hidden tabs")).toBeUndefined();
    },
  );

  it("admin still sees Hidden tabs, flagged collapsible", () => {
    const hidden = section(visibleNavFor("admin"), "Hidden tabs");
    expect(hidden).toBeDefined();
    expect(hidden?.collapsible).toBe(true);
    expect(hrefsIn(hidden)).toEqual([
      "/staff/gift-codes/sell",
      "/staff/registration",
      "/staff/signoff",
      "/staff/admin/accounting/patient-ar",
    ]);
  });

  it("drops parked items from reception's nav entirely", () => {
    const hrefs = allHrefs(visibleNavFor("reception"));
    expect(hrefs).not.toContain("/staff/gift-codes/sell");
    expect(hrefs).not.toContain("/staff/registration");
  });

  it("drops Sign-off from the pathologist's nav", () => {
    expect(allHrefs(visibleNavFor("pathologist"))).not.toContain(
      "/staff/signoff",
    );
  });

  it("keeps reception's everyday sections intact", () => {
    const hrefs = allHrefs(visibleNavFor("reception"));
    expect(hrefs).toContain("/staff/payments/cash-drawer");
    expect(hrefs).toContain("/staff/visits/queue");
    expect(hrefs).toContain("/staff/profile");
  });
});

describe("isSectionActive", () => {
  const hidden = section(visibleNavFor("admin"), "Hidden tabs")!;

  it("is true when the current path is one of the section's items", () => {
    expect(isSectionActive(hidden, "/staff/registration")).toBe(true);
  });

  it("is true for a nested route under an item", () => {
    expect(isSectionActive(hidden, "/staff/signoff/abc-123")).toBe(true);
  });

  it("is false elsewhere", () => {
    expect(isSectionActive(hidden, "/staff/visits/queue")).toBe(false);
  });

  it("also matches items nested in subgroups", () => {
    const admin = section(visibleNavFor("admin"), "Admin")!;
    expect(isSectionActive(admin, "/staff/admin/payroll/runs")).toBe(true);
    expect(isSectionActive(admin, "/staff/patients")).toBe(false);
  });
});
