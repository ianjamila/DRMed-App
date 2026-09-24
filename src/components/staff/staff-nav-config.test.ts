import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { describe, expect, it } from "vitest";
import { QUICK_QUOTE_ROLES, canUseQuickQuote } from "@/lib/staff/quote-access";
import {
  quickLinksFor,
  quickLinkGroupsFor,
  isItemActive,
  isSectionActive,
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

describe("Payroll is grouped pay cycle | staff records | setup", () => {
  it("orders the items into three runs, with a divider opening the second and third", () => {
    const payroll = section(visibleNavFor("admin"), "Admin")!.subgroups!.find((g) => g.heading === "Payroll")!;
    expect(payroll.items.map((i) => [i.href, Boolean(i.dividerBefore)])).toEqual([
      ["/staff/admin/payroll/runs", false],
      ["/staff/admin/payroll/periods", false],
      ["/staff/admin/payroll/employees", true],
      ["/staff/admin/payroll/ot-slips", false],
      ["/staff/admin/payroll/leaves", false],
      ["/staff/admin/reports/staff-advances", false],
      ["/staff/admin/payroll/holidays", true],
      ["/staff/admin/payroll/rates", false],
      ["/staff/admin/payroll/settings", false],
    ]);
  });
});

describe("Lab & Imaging order (owner request 2026-09-24)", () => {
  it("lists Queue, then Results, then Critical Alerts", () => {
    expect(hrefsIn(section(STAFF_NAV, "Lab & Imaging"))).toEqual([
      "/staff/queue",
      "/staff/results",
      "/staff/critical-alerts",
    ]);
  });
});

describe("Front Desk is ordered by the daily flow", () => {
  it("lists Patients, Reception Queue, then the former Billing items, with no subgroups", () => {
    const front = section(visibleNavFor("reception"), "Front Desk");
    expect(front?.items?.map((i) => i.href)).toEqual([
      "/staff/patients",
      "/staff/visits/queue",
      "/staff/visits",
      "/staff/payments/cash-drawer",
    ]);
    expect(front?.subgroups).toBeUndefined();
  });

  it("splits the daily-flow items from the money items with one divider, above Visit Records", () => {
    const front = section(STAFF_NAV, "Front Desk");
    expect(front?.items?.filter((i) => i.dividerBefore).map((i) => i.href)).toEqual(["/staff/visits"]);
  });

  it("pins every divider in the sidebar, and none sits on a list's first item", () => {
    const flagged = allItems(STAFF_NAV).filter((i) => i.dividerBefore).map((i) => i.href);
    expect(flagged).toEqual([
      "/staff/visits",
      "/staff/admin/payroll/employees",
      "/staff/admin/payroll/holidays",
      "/staff/admin/operations",
      "/staff/admin/gift-codes",
      "/staff/admin/accounting/chart-of-accounts",
      "/staff/admin/settings/dashboard-cards",
      "/staff/admin/import-patients",
    ]);
    const lists = STAFF_NAV.flatMap((s) => [s.items ?? [], ...(s.subgroups ?? []).map((g) => g.items)]);
    for (const list of lists) expect(list[0]?.dividerBefore ?? false).toBe(false);
  });

  it("has no Billing section any more (folded into Front Desk 2026-09-24)", () => {
    expect(STAFF_NAV.map((s) => s.heading)).not.toContain("Billing");
  });

  it("has no New patient registration item — the form is reached from Patients", () => {
    expect(allHrefs(STAFF_NAV)).not.toContain("/staff/patients/new");
  });

  it("names the Patients page's + New patient button in the tooltip", () => {
    expect(itemByHref("/staff/patients").description).toMatch(/\+ New patient/);
  });

});

describe("Messages & Bookings sits above Front Desk", () => {
  it("is its own plain section directly before Front Desk", () => {
    const headings = visibleNavFor("reception").map((s) => s.heading);
    expect(headings.indexOf("Messages & Bookings")).toBe(headings.indexOf("Front Desk") - 1);
    const group = section(visibleNavFor("reception"), "Messages & Bookings");
    expect(group?.collapsible).toBeFalsy();
    expect(group?.subgroups).toBeUndefined();
    expect(hrefsIn(group)).toEqual(["/staff/appointments", "/staff/messages", "/staff/quote"]);
  });

  it("is active on either of its pages", () => {
    const group = section(visibleNavFor("reception"), "Messages & Bookings")!;
    expect(isSectionActive(group, "/staff/appointments")).toBe(true);
    expect(isSectionActive(group, "/staff/messages/abc")).toBe(true);
    expect(isSectionActive(group, "/staff/patients")).toBe(false);
  });

  it("is not shown to lab roles", () => {
    for (const role of ["medtech", "xray_technician", "pathologist"] as const) {
      expect(section(visibleNavFor(role), "Messages & Bookings")).toBeUndefined();
    }
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
  it("is one Front Desk item landing on the drawer tab, with no Petty Cash sibling", () => {
    const front = section(visibleNavFor("reception"), "Front Desk");
    expect(hrefsIn(front)).toContain("/staff/payments/cash-drawer");
    expect(hrefsIn(front)).not.toContain("/staff/payments/petty-cash");
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
      "Messages & Bookings",
      "Front Desk",
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
      "/staff/appointments",
      "/staff/messages",
      "/staff/quote",
      "/staff/patients",
      "/staff/visits/queue",
      "/staff/visits",
      "/staff/payments/cash-drawer",
      "/staff/profile",
      "/staff/payslips",
    ]);
  });

  it("medtech no longer sees Quick Quote (owner decision 2026-09-24)", () => {
    expect(allHrefs(visibleNavFor("medtech"))).toEqual([
      "/staff",
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
      "/staff/results",
      "/staff/critical-alerts",
      "/staff/profile",
      "/staff/payslips",
    ]);
  });

  it("admin sees everything, with no duplicate hrefs", () => {
    const hrefs = allHrefs(visibleNavFor("admin"));
    expect(hrefs).toEqual(allHrefs(STAFF_NAV));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("medtech and xray see Lab & Imaging but no Front Desk", () => {
    for (const role of ["medtech", "xray_technician"] as const) {
      const headings = visibleNavFor(role).map((s) => s.heading);
      expect(headings).toContain("Lab & Imaging");
      expect(headings).not.toContain("Front Desk");
    }
  });

  it("Quick Quote is reception + admin only", () => {
    expect(itemByHref("/staff/quote").roles).toEqual(["reception", "admin"]);
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

// Naming ownership complements staff-page-titles.test.ts (metadata presence and
// suffixes). This guard checks navigation DATA, never guesses rendered headings
// from page source. In particular client headings, error branches, EOD's date,
// and queueTitleForRole are not a text-scanning problem.
const NAV_FILE = "src/components/staff/staff-nav-config.ts";
const DASHBOARD_DIR = "src/app/(staff)/staff/(dashboard)";
const REGISTRY_MODULE = "@/lib/staff/route-names";

type NameException = { file: string; href: string; label: string; why: string };
const NAME_EXCEPTIONS: NameException[] = [
  ...[
    ["/staff/admin/accounting/ap", "Expenses"],
    ["/staff/admin/operations", "Daily Monitoring"],
    ["/staff/admin/accounting/financial-statements", "Financial Statements"],
    ["/staff/marketing", "Marketing"],
    ["/staff/payments/cash-drawer", "Cash Drawer"],
  ].map(([href, label]) => ({
    file: NAV_FILE, href, label,
    why: "An umbrella opens a section containing several views; naming it after its first tab would conceal the other views.",
  })),
  {
    file: `${DASHBOARD_DIR}/admin/accounting/ap/_components/bills-tabs.tsx`,
    href: "/staff/admin/accounting/ap", label: "Overview",
    why: "Inside Expenses the Overview tab can omit the section prefix; the standalone page and dashboard link say Expenses Overview.",
  },
  ...[NAV_FILE].map((file) => ({
    file, href: "/staff/queue", label: "Queue",
    why: "Queue is a shared role-neutral entry point: queueTitleForRole correctly renders Imaging queue for x-ray staff and Lab queue for medtechs.",
  })),
];

// Metric-card labels describe the measured subset, not the destination route.
// Keep these exclusions explicit and file-scoped; preferences use card_id.
const METRIC_EXCEPTIONS = ["admin", "reception", "lab"].map((role) => ({
  file: `${DASHBOARD_DIR}/_dashboards/${role}-dashboard.tsx`,
  component: "StatCard",
  why: "A metric label names a count or amount (often a filtered subset); changing it to the route name would misdescribe the number. Card IDs remain stable.",
}));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Bind identifiers through the TS symbol table, so a shadowing local named
 * ROUTE_NAME or an unused import cannot satisfy the guard. Follow local aliases
 * and verify the import's module AND exported name, including renamed imports.
 */
function navigationNames(file: string, text: string, sectionHref?: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => name === file ? sf : undefined;
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const visit = (node: ts.Node, fn: (node: ts.Node) => void) => {
    fn(node);
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  function resolve(node: ts.Expression, seen = new Set<ts.Node>()): ts.Expression {
    if (seen.has(node)) return node;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return resolve(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return resolve(declaration.initializer, seen);
      }
    }
    return node;
  }
  function stringValue(input: ts.Expression): string | undefined {
    const node = resolve(input);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = stringValue(span.expression);
        if (value === undefined) return;
        result += value + span.literal.text;
      }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringValue(node.left), right = stringValue(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
  }
  function registryRead(input: ts.Expression, exportName: string, href: string): boolean {
    const node = resolve(input);
    if (!ts.isElementAccessExpression(node) || stringValue(node.argumentExpression) !== href) return false;
    const receiver = resolve(node.expression);
    const declarations = checker.getSymbolAtLocation(receiver)?.declarations ?? [];
    return declarations.some((d) => {
      if (!ts.isImportSpecifier(d) || (d.propertyName ?? d.name).text !== exportName) return false;
      const imp = d.parent.parent.parent;
      return ts.isImportDeclaration(imp) && ts.isStringLiteral(imp.moduleSpecifier) &&
        imp.moduleSpecifier.text === REGISTRY_MODULE;
    });
  }
  const entries: { href: string; label?: string; routeRead: boolean; sectionRead: boolean }[] = [];
  const metrics: string[] = [];
  let derivedQuicklinks = false;
  const eyebrows: boolean[] = [];
  const handRolledHeaders: string[] = [];
  visit(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const decl = checker.getSymbolAtLocation(node.expression)?.declarations?.[0];
      if (decl && ts.isImportSpecifier(decl) && ["quickLinksFor", "quickLinkGroupsFor"].includes((decl.propertyName ?? decl.name).text)) {
        const imp = decl.parent.parent.parent;
        derivedQuicklinks ||= ts.isImportDeclaration(imp) && ts.isStringLiteral(imp.moduleSpecifier) && imp.moduleSpecifier.text === "@/components/staff/staff-nav-config";
      }
    }
    if (sectionHref && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) {
      const tag = node.tagName.getText(sf);
      if (tag === "PageHeader") {
        const prop = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "eyebrow");
        const value = prop && ts.isJsxAttribute(prop) ? prop.initializer : undefined;
        eyebrows.push(!!value && ts.isJsxExpression(value) && !!value.expression && registryRead(value.expression, "SECTION_NAME", sectionHref));
      }
      if (tag === "h1" || (tag === "p" && /uppercase.*tracking-wider/.test(node.getText(sf)))) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        handRolledHeaders.push(`${tag}:${owner && ts.isFunctionDeclaration(owner) ? owner.name?.text : ""}`);
      }
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === "StatCard") metrics.push("StatCard");
    if (!ts.isObjectLiteralExpression(node)) return;
    const props = new Map(node.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(sf), p.initializer]));
    const hrefNode = props.get("href"), label = props.get("label");
    if (!hrefNode || !label) return;
    const href = stringValue(hrefNode) ?? "<unresolved href>";
    entries.push({ href, label: stringValue(label), routeRead: registryRead(label, "ROUTE_NAME", href), sectionRead: registryRead(label, "SECTION_NAME", href) });
  });
  return { entries, metrics, eyebrows, handRolledHeaders, derivedQuicklinks };
}

const namingFiles = [NAV_FILE, ...sourceFiles(DASHBOARD_DIR).filter((file) =>
  file.endsWith("-tabs.tsx") || /\/_dashboards\/[^/]+-dashboard\.tsx$/.test(file),
)];

describe("route name registry ownership", () => {
  it.each(namingFiles)("%s reads registry names at every navigation leaf", (file) => {
    const { entries, metrics, derivedQuicklinks } = navigationNames(file, readFileSync(file, "utf8"));
    if (file.includes("/_dashboards/")) {
      expect(derivedQuicklinks, "dashboard quicklinks must derive from STAFF_NAV").toBe(true);
      expect(entries, "dashboard must not keep a separate quicklink list").toEqual([]);
    } else {
      expect(entries.length, "a migrated surface must not silently stop being inspected").toBeGreaterThan(0);
    }
    for (const entry of entries) {
      const exception = NAME_EXCEPTIONS.find((e) => e.file === file && e.href === entry.href);
      if (exception) {
        expect(exception.why.length).toBeGreaterThan(50);
        expect(entry.sectionRead ? SECTION_NAME[entry.href] : entry.label).toBe(exception.label);
      } else {
        expect(entry.routeRead, `${file}: ${entry.href} must read ROUTE_NAME for its own href`).toBe(true);
        expect(ROUTE_NAME[entry.href], `missing registry entry: ${entry.href}`).toBeTruthy();
      }
    }
    for (const component of metrics) {
      expect(METRIC_EXCEPTIONS.find((e) => e.file === file && e.component === component)?.why.length).toBeGreaterThan(50);
    }
  });

  it("keeps exceptions specific, justified and live", () => {
    for (const exception of NAME_EXCEPTIONS) {
      expect(namingFiles).toContain(exception.file);
      expect(exception.why.length).toBeGreaterThan(50);
      expect(navigationNames(exception.file, readFileSync(exception.file, "utf8")).entries.some((e) => e.href === exception.href)).toBe(true);
    }
    for (const exception of METRIC_EXCEPTIONS) {
      expect(navigationNames(exception.file, readFileSync(exception.file, "utf8")).metrics).toContain(exception.component);
    }
  });

  it("keeps the imported registry dependency-free", () => {
    const sf = ts.createSourceFile("route-names.ts", readFileSync("src/lib/staff/route-names.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const dependencies: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier) || ts.isCallExpression(node)) {
        dependencies.push(node.getText(sf));
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    expect(dependencies).toEqual([]);
  });

  it.each([
    ['import { ROUTE_NAME } from "@/lib/staff/route-names";', '"Cash Drawer"'],
    ['import { ROUTE_NAME } from "@/lib/staff/route-names";', 'ROUTE_NAME["/wrong"]'],
    ['import { ROUTE_NAME } from "./fake";', 'ROUTE_NAME["/staff/payments/cash-drawer"]'],
    ['const ROUTE_NAME = {"/staff/payments/cash-drawer": "Cash Drawer"};', 'ROUTE_NAME["/staff/payments/cash-drawer"]'],
  ])("rejects inline names, wrong keys and false registry imports", (prefix, label) => {
    const source = `${prefix}\nconst tabs = [{href: "/staff/payments/cash-drawer", label: ${label}}];`;
    expect(navigationNames("fixture.tsx", source).entries[0].routeRead).toBe(false);
  });

  it("follows renamed imports, local aliases and template hrefs", () => {
    const source = `import { ROUTE_NAME as names } from "@/lib/staff/route-names";
      const BASE = "/staff/payments";
      const label = names[BASE + "/cash-drawer"];
      const tabs = [{href: \`\${BASE}/cash-drawer\`, label: label}];`;
    expect(navigationNames("fixture.tsx", source).entries[0].routeRead).toBe(true);
  });
});

// The adopted families use one header API, with no duplicated layout kicker.
// An exception must identify a file and argue why separate section wording is
// correct (not merely that it predates this guard). Metric captions are separate.
const EYEBROW_EXCEPTIONS: Record<string, { nodes: string[]; why: string }> = {
  [`${DASHBOARD_DIR}/admin/accounting/financial-statements/cash-flow/page.tsx`]: {
    nodes: ["p:SummaryTile"],
    why: "SummaryTile labels a cash metric inside an article; it is not the page section eyebrow and must describe its own value.",
  },
  [`${DASHBOARD_DIR}/payments/eod/[closeId]/count-sheet/page.tsx`]: {
    nodes: ["h1:CashCountSheetPage"],
    why: "The printed count sheet is a signed paper record under the clinic letterhead; its heading names that document, not the on-screen Cash Drawer section.",
  },
};
const HEADER_FAMILIES: [dir: string, sectionHref: string][] = [
  ...["admin/accounting/ap", "admin/accounting/financial-statements", "marketing"]
    .map((family): [string, string] => [family, `/staff/${family}`]),
  // Daily Monitoring's six views sit in a route group so its tab-bar layout
  // wraps only them; Cron Health, beside the group, is not part of the section.
  ["admin/operations/(daily-monitoring)", "/staff/admin/operations"],
  // Cash Drawer's three tabs are sibling folders under payments/, beside
  // Record payment (payments/new), which is not part of the section.
  ...["cash-drawer", "petty-cash", "eod"]
    .map((tab): [string, string] => [`payments/${tab}`, "/staff/payments/cash-drawer"]),
];

describe("PageHeader section ownership", () => {
  it.each(HEADER_FAMILIES)("%s reads its eyebrow from SECTION_NAME", (family, sectionHref) => {
    let headers = 0;
    for (const file of sourceFiles(`${DASHBOARD_DIR}/${family}`)) {
      if (file.includes(".test.")) continue;
      const exception = EYEBROW_EXCEPTIONS[file];
      if (exception) expect(exception.why.length).toBeGreaterThan(50);
      const result = navigationNames(file, readFileSync(file, "utf8"), sectionHref);
      expect(result.handRolledHeaders, file).toEqual(exception?.nodes ?? []);
      expect(result.eyebrows.every(Boolean), file).toBe(true);
      headers += result.eyebrows.length;
    }
    expect(headers).toBeGreaterThan(0);
  });

  it.each(['"Expenses"', '{"Expenses"}', '{ROUTE_NAME["/staff/admin/accounting/ap"]}'])("rejects an eyebrow bypass: %s", (eyebrow) => {
    const text = `import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
      const header = <PageHeader title="Example" eyebrow=${eyebrow} />;`;
    expect(navigationNames("fixture.tsx", text, "/staff/admin/accounting/ap").eyebrows).toEqual([false]);
  });
});

describe("derived dashboard shortcuts preserve the visible set", () => {
  it("preserves reception groups, labels and order, including parked/action links", () => {
    expect(quickLinkGroupsFor("reception", "reception").map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Messages & Bookings", ["Appointments", "Website Messages", "Quick Quote"]],
      ["Front Desk", ["Patients", "New Patient", "Reception Queue", "Visit Records", "Cash Drawer", "Petty Cash", "Sell Gift Code"]],
    ]);
    expect(quickLinksFor("reception", "reception").map((i) => i.href)).toEqual([
      "/staff/appointments", "/staff/messages", "/staff/quote", "/staff/patients", "/staff/patients/new", "/staff/visits/queue", "/staff/visits", "/staff/payments/cash-drawer", "/staff/payments/petty-cash", "/staff/gift-codes/sell",
    ]);
  });
  it("preserves all ten admin shortcuts", () => {
    expect(quickLinksFor("admin", "admin").map((i) => [i.href, i.label])).toEqual([
      ["/staff/admin/accounting/periods", "Monthly Periods"],
      ["/staff/admin/accounting/financial-statements", "Financial Statements"],
      ["/staff/admin/operations", "Daily Monitoring"],
      ["/staff/admin/accounting/pf-payouts", "Pay Doctors"],
      ["/staff/admin/accounting/journal", "Journal Entries"],
      ["/staff/admin/operations/cash", "Cash & Cards"],
      ["/staff/admin/operations/daily-revenue", "Daily Revenue"],
      ["/staff/admin/accounting/ap", "Expenses Overview"],
      ["/staff/admin/accounting/hmo-claims", "HMO Claims"],
      ["/staff/admin/payroll/runs", "Run Payroll"],
    ]);
  });
  it.each([
    ["medtech", ["Queue"]],
    ["xray_technician", ["Queue"]],
    ["pathologist", ["Queue"]],
    ["admin", ["Queue", "Quick Quote", "Result Templates"]],
  ] as const)("preserves lab shortcuts for %s", (role, labels) => {
    expect(quickLinksFor(role, "lab").map((i) => i.label)).toEqual(labels);
  });
  it("does not expose admin shortcuts to reception", () => {
    expect(quickLinksFor("reception", "admin")).toEqual([]);
  });
});

describe("Daily Revenue belongs to Daily Monitoring", () => {
  it("has no duplicate sidebar row and lights only its section", () => {
    expect(allHrefs(STAFF_NAV)).not.toContain("/staff/admin/operations/daily-revenue");
    expect(allHrefs(STAFF_NAV)).not.toContain("/staff/admin/reports/daily-revenue");
    expect(activeHrefs("/staff/admin/operations/daily-revenue")).toEqual(["/staff/admin/operations"]);
  });
});

describe("Cron Health navigation", () => {
  const href = "/staff/admin/operations/cron-health";
  it("lives in the admin Operations subgroup", () => {
    const admin = section(visibleNavFor("admin"), "Admin");
    expect(admin?.subgroups?.find((g) => g.heading === "Operations")?.items.map((i) => i.href)).toContain(href);
  });
  it.each(ALL_ROLES.filter((role) => role !== "admin"))("is hidden from %s", (role) => {
    expect(allHrefs(visibleNavFor(role))).not.toContain(href);
  });
  it("lights only Cron Health, leaving Daily Monitoring active on its own views", () => {
    expect(activeHrefs(href)).toEqual([href]);
    expect(activeHrefs("/staff/admin/operations/cash")).toEqual(["/staff/admin/operations"]);
  });
  it("renders outside the Daily Monitoring tab bar", () => {
    // A layout directly under operations/ would wrap Cron Health in the six
    // financial-period tabs again, with none of them highlighted.
    expect(existsSync(`${DASHBOARD_DIR}/admin/operations/layout.tsx`)).toBe(false);
    expect(existsSync(`${DASHBOARD_DIR}/admin/operations/(daily-monitoring)/layout.tsx`)).toBe(true);
    expect(existsSync(`${DASHBOARD_DIR}/admin/operations/cron-health/page.tsx`)).toBe(true);
  });
});

describe("Quick Quote access has one source of truth", () => {
  it("the sidebar item uses QUICK_QUOTE_ROLES", () => {
    expect(itemByHref("/staff/quote").roles).toBe(QUICK_QUOTE_ROLES);
  });

  it.each([
    ["reception", true],
    ["admin", true],
    ["medtech", false],
    ["xray_technician", false],
    ["pathologist", false],
  ] as const)("canUseQuickQuote(%s) is %s", (role, expected) => {
    expect(canUseQuickQuote(role)).toBe(expected);
  });
});
