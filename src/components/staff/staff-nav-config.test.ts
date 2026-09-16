import { describe, expect, it } from "vitest";
import {
  isItemActive,
  isSectionActive,
  isSubgroupActive,
  visibleNavFor,
  STAFF_NAV,
  type StaffNavItem,
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

function allItems(sections: StaffNavSection[]): StaffNavItem[] {
  return sections.flatMap((s) => [
    ...(s.items ?? []),
    ...(s.subgroups ?? []).flatMap((g) => g.items),
  ]);
}

function itemByHref(href: string): StaffNavItem {
  const item = allItems(STAFF_NAV).find((i) => i.href === href);
  if (!item) throw new Error(`no nav item for ${href}`);
  return item;
}

// The sidebar items that light up for a given path, across the whole config.
// Every path must light AT MOST one item — a double highlight tells the user
// they are in two places at once.
function activeHrefs(pathname: string): string[] {
  return allItems(STAFF_NAV)
    .filter((i) => isItemActive(i, pathname))
    .map((i) => i.href);
}

describe("My Payslips is reachable by every role", () => {
  // Partner revision item 8 makes "Hidden Tabs" admin-only. Payslips are
  // self-service for ALL staff, so the item must live in a role-visible
  // section (Personal) — not in the parked one.
  it.each(ALL_ROLES)("%s sees My Payslips under Personal", (role) => {
    const personal = section(visibleNavFor(role), "Personal");
    expect(hrefsIn(personal)).toContain("/staff/payslips");
  });

  it("no longer parks My Payslips under Hidden Tabs", () => {
    const hidden = STAFF_NAV.find((s) => s.heading === "Hidden Tabs");
    expect(hrefsIn(hidden)).not.toContain("/staff/payslips");
  });
});

describe("Hidden Tabs is admin-only", () => {
  it("is declared admin-only and collapsible in the config", () => {
    const hidden = STAFF_NAV.find((s) => s.heading === "Hidden Tabs");
    expect(hidden?.adminOnly).toBe(true);
    expect(hidden?.collapsible).toBe(true);
  });

  it.each(ALL_ROLES.filter((r) => r !== "admin"))(
    "%s does not see the Hidden Tabs section",
    (role) => {
      expect(section(visibleNavFor(role), "Hidden Tabs")).toBeUndefined();
    },
  );

  it("admin still sees Hidden Tabs, flagged collapsible", () => {
    const hidden = section(visibleNavFor("admin"), "Hidden Tabs");
    expect(hidden).toBeDefined();
    expect(hidden?.collapsible).toBe(true);
    expect(hrefsIn(hidden)).toEqual([
      "/staff/gift-codes/sell",
      "/staff/gift-codes/refund",
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

// ---------------------------------------------------------------------------
// Sidebar cleanup (2026-09-15, Fable + Codex review, owner approved).
// ---------------------------------------------------------------------------

describe("Front Desk is ordered by the daily flow", () => {
  it("lists Reception Queue, then Patients, then the Inquiries & Bookings subgroup", () => {
    const front = section(visibleNavFor("reception"), "Front Desk");
    expect(front?.items?.map((i) => i.href)).toEqual([
      "/staff/visits/queue",
      "/staff/patients",
    ]);
    expect(front?.subgroups?.map((g) => g.heading)).toEqual([
      "Inquiries & Bookings",
    ]);
    expect(front?.subgroups?.[0].items.map((i) => i.href)).toEqual([
      "/staff/appointments",
      "/staff/inquiries",
    ]);
  });

  it("has no New patient registration item — the form is reached from Patients", () => {
    expect(allHrefs(STAFF_NAV)).not.toContain("/staff/patients/new");
  });

  it("names the Patients page's + New patient button in the tooltip", () => {
    expect(itemByHref("/staff/patients").description).toMatch(/\+ New patient/);
  });

  it("opens the Inquiries & Bookings subgroup on either of its pages", () => {
    const group = section(visibleNavFor("reception"), "Front Desk")!
      .subgroups![0];
    expect(isSubgroupActive(group, "/staff/appointments")).toBe(true);
    expect(isSubgroupActive(group, "/staff/inquiries/abc")).toBe(true);
    expect(isSubgroupActive(group, "/staff/patients")).toBe(false);
  });
});

describe("Patients highlighting", () => {
  it("lights on the list, a patient detail, and the New patient form", () => {
    expect(activeHrefs("/staff/patients")).toEqual(["/staff/patients"]);
    expect(activeHrefs("/staff/patients/some-uuid")).toEqual(["/staff/patients"]);
    expect(activeHrefs("/staff/patients/new")).toEqual(["/staff/patients"]);
  });
});

describe("Cash Drawer owns all three cash routes", () => {
  it("is one Billing item landing on the drawer tab, with no Petty Cash sibling", () => {
    const billing = section(visibleNavFor("reception"), "Billing");
    expect(hrefsIn(billing)).toContain("/staff/payments/cash-drawer");
    expect(hrefsIn(billing)).not.toContain("/staff/payments/petty-cash");
    expect(itemByHref("/staff/payments/cash-drawer").label).toBe("Cash Drawer");
  });

  it.each([
    "/staff/payments/cash-drawer",
    "/staff/payments/petty-cash",
    "/staff/payments/eod",
    "/staff/payments/eod/close-id/count-sheet",
  ])("lights Cash Drawer, and only Cash Drawer, on %s", (path) => {
    expect(activeHrefs(path)).toEqual(["/staff/payments/cash-drawer"]);
  });

  it("does NOT light on Record payment (/staff/payments/new)", () => {
    expect(activeHrefs("/staff/payments/new")).toEqual([]);
  });

  it("mentions all three tabs in the merged tooltip", () => {
    const d = itemByHref("/staff/payments/cash-drawer").description ?? "";
    expect(d).toMatch(/Petty Cash/);
    expect(d).toMatch(/End of Day/);
  });
});

describe("Visit Records highlighting", () => {
  it("is the Billing item's label", () => {
    expect(itemByHref("/staff/visits").label).toBe("Visit Records");
  });

  it("lights on the archive and a visit detail / receipt", () => {
    expect(activeHrefs("/staff/visits")).toEqual(["/staff/visits"]);
    expect(activeHrefs("/staff/visits/some-uuid")).toEqual(["/staff/visits"]);
    expect(activeHrefs("/staff/visits/some-uuid/receipt")).toEqual(["/staff/visits"]);
  });

  it("stays dark on New visit — no sidebar item owns that form", () => {
    expect(activeHrefs("/staff/visits/new")).toEqual([]);
  });

  it("yields the queue route to Reception Queue alone", () => {
    expect(activeHrefs("/staff/visits/queue")).toEqual(["/staff/visits/queue"]);
  });
});

describe("Outside-Lab Costs vs Outside-Lab Performance", () => {
  it("lights only Outside-Lab Performance on the vendor-performance route", () => {
    expect(
      activeHrefs("/staff/admin/accounting/cogs/send-outs/vendor-performance"),
    ).toEqual(["/staff/admin/accounting/cogs/send-outs/vendor-performance"]);
  });

  it("lights only Outside-Lab Costs on the send-outs tabs", () => {
    expect(activeHrefs("/staff/admin/accounting/cogs/send-outs")).toEqual([
      "/staff/admin/accounting/cogs/send-outs",
    ]);
    expect(activeHrefs("/staff/admin/accounting/cogs/send-outs/true-ups")).toEqual([
      "/staff/admin/accounting/cogs/send-outs",
    ]);
  });
});

describe("activePrefixes", () => {
  it("keeps Expenses lit across every AP tab and dark on unrelated admin routes", () => {
    const expenses = itemByHref("/staff/admin/accounting/ap");
    expect(isItemActive(expenses, "/staff/admin/accounting/ap/bills/123")).toBe(true);
    expect(isItemActive(expenses, "/staff/admin/accounting/ap")).toBe(true);
    expect(isItemActive(expenses, "/staff/admin/accounting/journal")).toBe(false);
  });

  it("is honoured only when the path is not excluded", () => {
    const item: StaffNavItem = {
      href: "/x/a",
      label: "X",
      activePrefixes: ["/x/b"],
      excludePrefixes: ["/x/b/skip"],
      roles: ["admin"],
    };
    expect(isItemActive(item, "/x/b")).toBe(true);
    expect(isItemActive(item, "/x/b/skip")).toBe(false);
  });
});

describe("Title Case labels", () => {
  // Owner decision 2026-09-15: every sidebar / subgroup label is Title Case
  // ("Reception Queue" is the model). Acronyms and brand names stay as-is.
  // The check: every whitespace-separated word that starts with a letter
  // starts with a capital, except a short list of joining words.
  const SMALL = new Set(["of", "vs", "and", "the", "a", "an", "in", "on", "to", "for", "&", "this"]);
  function isTitleCase(label: string): boolean {
    return label
      .replace(/[()]/g, "")
      .split(/\s+/)
      .every((w) => {
        const bare = w.replace(/^[^A-Za-z]+/, "");
        if (bare === "" || SMALL.has(bare.toLowerCase())) return true;
        return /^[A-Z]/.test(bare);
      });
  }

  it.each(allItems(STAFF_NAV).map((i) => i.label))("%s", (label) => {
    expect(isTitleCase(label)).toBe(true);
  });

  it.each(STAFF_NAV.flatMap((s) => [s.heading, ...(s.subgroups ?? []).map((g) => g.heading)]))(
    "section / subgroup heading: %s",
    (heading) => {
      expect(isTitleCase(heading)).toBe(true);
    },
  );

  it("pins the renamed labels", () => {
    expect(itemByHref("/staff/quote").label).toBe("Quick Quote");
    expect(itemByHref("/staff/critical-alerts").label).toBe("Critical Alerts");
    expect(itemByHref("/staff/admin/accounting/hmo-claims").label).toBe("HMO Claims");
    expect(itemByHref("/staff/admin/payroll/runs").label).toBe("Run Payroll");
    expect(itemByHref("/staff/admin/seo").label).toBe("Search Engines (IndexNow)");
    expect(STAFF_NAV.map((s) => s.heading)).toEqual([
      "Overview",
      "Front Desk",
      "Billing",
      "Lab & Imaging",
      "Admin",
      "Personal",
      "Hidden Tabs",
    ]);
  });
});

describe("visible hrefs per role", () => {
  it("reception", () => {
    expect(allHrefs(visibleNavFor("reception"))).toEqual([
      "/staff",
      "/staff/visits/queue",
      "/staff/patients",
      "/staff/appointments",
      "/staff/inquiries",
      "/staff/visits",
      "/staff/quote",
      "/staff/payments/cash-drawer",
      "/staff/profile",
      "/staff/payslips",
    ]);
  });

  it("medtech still sees Quick Quote (lab dashboard + Cmd+K rely on it)", () => {
    expect(allHrefs(visibleNavFor("medtech"))).toEqual([
      "/staff",
      "/staff/quote",
      "/staff/queue",
      "/staff/results",
      "/staff/admin/inventory",
      "/staff/profile",
      "/staff/payslips",
    ]);
  });

  it("xray_technician", () => {
    expect(allHrefs(visibleNavFor("xray_technician"))).toEqual([
      "/staff",
      "/staff/queue",
      "/staff/results",
      "/staff/admin/inventory",
      "/staff/profile",
      "/staff/payslips",
    ]);
  });

  it("pathologist", () => {
    expect(allHrefs(visibleNavFor("pathologist"))).toEqual([
      "/staff",
      "/staff/queue",
      "/staff/critical-alerts",
      "/staff/results",
      "/staff/profile",
      "/staff/payslips",
    ]);
  });

  it("admin sees everything, with no duplicate hrefs", () => {
    const hrefs = allHrefs(visibleNavFor("admin"));
    expect(hrefs).toEqual(allHrefs(STAFF_NAV));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("medtech and xray see Lab & Imaging but no Front Desk or Billing beyond Quick Quote", () => {
    for (const role of ["medtech", "xray_technician"] as const) {
      const headings = visibleNavFor(role).map((s) => s.heading);
      expect(headings).toContain("Lab & Imaging");
      expect(headings).not.toContain("Front Desk");
    }
  });
});

describe("isSectionActive", () => {
  const hidden = section(visibleNavFor("admin"), "Hidden Tabs")!;

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
