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
 * that is the naming registry's job, and the section names are still in flux.
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

    expect(offenders, "hand-written title suffixes").toEqual([]);
  });

  it("every staff page exports metadata, so none inherits the marketing title", () => {
    const untitled = files
      .filter((f) => f.endsWith(`${sep}page.tsx`))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          !/export\s+const\s+metadata\b/.test(src) &&
          !/export\s+(async\s+)?function\s+generateMetadata\b/.test(src)
        );
      })
      .map(rel);

    expect(untitled, "staff pages with no title of their own").toEqual([]);
  });

  it("exactly one staff layout owns the title template, and it is the group layout", () => {
    const owners = files
      .filter((f) => f.endsWith(`${sep}layout.tsx`))
      .filter((f) => /template:/.test(readFileSync(f, "utf8")))
      .map(rel);

    expect(owners).toEqual([GROUP_LAYOUT.split(sep).join("/")]);
  });
});
