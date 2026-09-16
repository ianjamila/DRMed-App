import ts from "typescript";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One title per staff route, one suffix for the whole staff shell.
 *
 * WHY THIS EXISTS
 * ---------------
 * The root layout sets `title.template: "%s — drmed.ph"`
 * (`src/app/layout.tsx`) and, until `src/app/(staff)/layout.tsx` was added, no
 * staff layout overrode it. So every staff page that hand-wrote its own suffix
 * rendered the suffix TWICE in the browser tab:
 *
 *     "Accounts Payable — DRMed — drmed.ph"
 *     "End of day — staff — drmed.ph"
 *
 * Nothing caught it because a page title is not type-checked, not linted, and
 * not asserted anywhere — it only shows up in a tab nobody reads closely. By
 * the time it was found, the hand-written halves had drifted into FOUR
 * conventions across 140 pages (`— staff`, `— DRMed`, `— AP — DRMed`,
 * `— payroll admin`), because each new page was copied from a neighbour.
 *
 * `(staff)/layout.tsx` now owns the suffix for the whole staff surface, and a
 * page's `metadata.title` is just the route's own name. This test is what
 * keeps it that way: the next page copied from a neighbour fails here rather
 * than shipping a doubled tab title.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. NO HAND-WRITTEN SUFFIX — no `metadata.title` under `src/app/(staff)`
 *      re-states the site or the section. The template adds it.
 *
 *   2. EVERY PAGE IS TITLED — every `page.tsx` under `src/app/(staff)` exports
 *      `metadata` or `generateMetadata`. Seven did not, and inherited the
 *      MARKETING site's title instead: the five Operations routes, plus
 *      patient-merge/candidates and patients/[id]/consent/print.
 *
 *   3. ONE TEMPLATE OWNER — exactly one layout under `src/app/(staff)` sets a
 *      `title.template`, and it is the group layout at the top. A second one
 *      further down would silently re-suffix the subtree beneath it, which is
 *      the original bug in a new place. This is also what pins the layout's
 *      PLACEMENT: `staff/(dashboard)/layout.tsx` is the tempting spot and the
 *      wrong one — it does not cover `/staff/login`, `/staff/mfa` or
 *      `/staff/payslips`, which sit outside that route group.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not police the WORDING of a title against the route's tab label —
 * navigation registry references are checked by staff-nav-config.test.ts.
 * Client headings and branch-dependent titles cannot be inferred from text.
 * It only enforces the shape: a bare route name, exactly once, on every page.
 */

const STAFF_DIR = join(process.cwd(), "src", "app", "(staff)");
const GROUP_LAYOUT = join("src", "app", "(staff)", "layout.tsx");

/**
 * A suffix is the site or a section re-stated after an em dash. Matched on the
 * separator plus a known suffix word rather than on any em dash at all: a
 * title like "Bacolod — coming soon" names the route's own STATE and is fine,
 * and so is a patient or vendor name carried into a detail-page title.
 */
const SUFFIX_RE =
  /[—–-]\s*(staff|drmed(\.ph)?|ap\b|payroll admin|accounts payable|admin)\s*(["'`}]|$)/i;

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = walkFiles(STAFF_DIR);
const rel = (f: string) => relative(process.cwd(), f).split(sep).join("/");

/** Inspect exports, not comments or rendered headings. Both Next metadata APIs
 * are valid, but exporting both on one route is not. */
function metadataExports(source: string): string[] {
  const sf = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names: string[] = [];
  const isMetadata = (name: string) => name === "metadata" || name === "generateMetadata";
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) {
        if (isMetadata(item.name.text)) names.push(item.name.text);
      }
    }
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "generateMetadata" && statement.body) names.push("generateMetadata");
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isMetadata(declaration.name.text)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

describe("staff page titles", () => {
  it("no page re-states the site or section suffix — the template adds it", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Every string literal assigned to a `title:` key, whether in a
      // `metadata` object or returned from `generateMetadata`.
      for (const m of src.matchAll(/title:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
        const value = m[2];
        if (SUFFIX_RE.test(value)) offenders.push(`${rel(file)} — "${value}"`);
      }
    }

    for (const [href, title] of Object.entries(ROUTE_NAME)) {
      if (SUFFIX_RE.test(title)) offenders.push(`${href} — "${title}"`);
    }
    expect(offenders, "hand-written title suffixes").toEqual([]);
  });

  it("record pages across the ten detail families export dynamic metadata", () => {
    const routes = [
      "payslips/[id]/page.tsx",
      "(dashboard)/patients/[id]/page.tsx",
      "(dashboard)/patients/[id]/edit/page.tsx",
      "(dashboard)/patients/[id]/consent/print/page.tsx",
      "(dashboard)/visits/group/[groupId]/receipt/page.tsx",
      "(dashboard)/visits/[id]/page.tsx",
      "(dashboard)/visits/[id]/receipt/page.tsx",
      "(dashboard)/admin/accounting/hmo-claims/batches/[batchId]/page.tsx",
      "(dashboard)/admin/accounting/hmo-claims/[providerId]/page.tsx",
      "(dashboard)/admin/accounting/hmo-claims/[providerId]/historic/[claimId]/page.tsx",
      "(dashboard)/admin/accounting/pf-payouts/[id]/page.tsx",
      "(dashboard)/admin/accounting/pf-payouts/[id]/slip/page.tsx",
      "(dashboard)/admin/accounting/bank-rec/[id]/page.tsx",
      "(dashboard)/admin/hmo-providers/[id]/edit/page.tsx",
      "(dashboard)/admin/gift-codes/[id]/page.tsx",
      "(dashboard)/admin/inventory/[id]/page.tsx",
      "(dashboard)/admin/inventory/[id]/edit/page.tsx",
      "(dashboard)/admin/payroll/runs/[id]/page.tsx",
      "(dashboard)/admin/payroll/runs/[id]/dtr/page.tsx",
      "(dashboard)/admin/payroll/employees/[id]/page.tsx",
      "(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx",
      "(dashboard)/queue/[id]/page.tsx"
];
    for (const route of routes) {
      const source = readFileSync(join(STAFF_DIR, "staff", route), "utf8");
      expect(metadataExports(source), route).toEqual(["generateMetadata"]);
    }
  });

  it("every staff page exports metadata, so none inherits the marketing title", () => {
    const untitled = files
      .filter((f) => f.endsWith(`${sep}page.tsx`))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return metadataExports(src).length !== 1;
      })
      .map(rel);

    expect(untitled, "staff pages must export exactly one metadata API").toEqual([]);
  });

  it("exactly one staff layout owns the title template, and it is the group layout", () => {
    const owners = files
      .filter((f) => f.endsWith(`${sep}layout.tsx`))
      .filter((f) => /template:/.test(readFileSync(f, "utf8")))
      .map(rel);

    expect(owners).toEqual([GROUP_LAYOUT.split(sep).join("/")]);
  });
});

// These are the agreed route names, not assertions about rendered page source.
describe("audited route names", () => {
  it.each([
    ["/staff/admin/accounting/ap", "Expenses Overview"],
    ["/staff/admin/accounting/ap/quick-expense", "Quick Expense"],
    ["/staff/admin/accounting/ap/bills", "Vendor Bills"],
    ["/staff/admin/accounting/ap/payments", "Bill Payments"],
    ["/staff/admin/accounting/ap/vendors", "Vendors"],
    ["/staff/admin/accounting/ap/recurring", "Recurring Bills"],
    ["/staff/admin/operations", "Daily Sheet"],
    ["/staff/admin/operations/cash", "Cash & Cards"],
    ["/staff/admin/operations/expenses", "Expenses & P&L"],
    ["/staff/admin/operations/hmo", "HMO Receivables"],
    ["/staff/admin/operations/trends", "Monthly Trends"],
    ["/staff/admin/accounting/financial-statements", "Income Statement"],
    ["/staff/admin/accounting/financial-statements/balance-sheet", "Balance Sheet"],
    ["/staff/admin/accounting/financial-statements/cash-flow", "Cash Flow"],
    ["/staff/payments/eod", "End of Day"],
    ["/staff/marketing", "Ad Performance"],
    ["/staff/marketing/ops", "Ops Tracker"],
    ["/staff/admin/accounting/periods", "Monthly Periods"],
    ["/staff/admin/payroll/runs", "Run Payroll"],
  ])("%s is %s", (href, title) => {
    expect(ROUTE_NAME[href]).toBe(title);
  });
});

describe("metadata export detection", () => {
  it.each([
    'export const metadata = { title: "Bill" };',
    'export async function generateMetadata() { return { title: "Bill · Vendor" }; }',
    'export const generateMetadata = async () => ({ title: "Bill" });',
    'const titleForPage = async () => ({ title: "Bill" }); export { titleForPage as generateMetadata };',
  ])("accepts a real metadata export: %s", (source) => {
    expect(metadataExports(source)).toHaveLength(1);
  });
  it("does not accept a comment or a non-exported function", () => {
    expect(metadataExports('// export const metadata = {}\nfunction generateMetadata() { return { title: "Bill" }; }')).toEqual([]);
  });
  it("detects both APIs on one route", () => {
    expect(metadataExports('export const metadata = {}; export async function generateMetadata() { return {}; }')).toHaveLength(2);
  });
});
