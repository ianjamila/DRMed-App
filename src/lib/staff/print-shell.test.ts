// Pins the three shell-level print fixes from PR #212 (receipts printing whole).
//
// Each one is a single class or CSS rule far away from the receipt it protects,
// so a tidy-up of the staff shell can silently undo it and nobody notices until
// a clinic printout comes out clipped or two pages long:
//
//   1. <main> in the staff shell is a horizontal scroll box (overflow-x-auto).
//      On paper that scroll box clipped every printout at the viewport edge.
//      print:overflow-visible lets the page flow onto the sheet.
//   2. sonner's <Toaster> leaves an empty live region in flow after the shell —
//      enough to push a blank last page onto a printed receipt or slip.
//   3. Browsers repeat <tfoot> on every printed page, so a two-page receipt
//      showed its grand total under a partial list on page 1.
//
// Source-level on purpose: the real check is `npm run smoke:print` in real
// Chrome, which needs a dev server and local data. These run in `npm test`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("staff print shell", () => {
  it("lets the staff shell <main> overflow onto paper", () => {
    const shell = read("components/staff/staff-shell.tsx");
    const main = shell.match(/<main\b[^>]*className="([^"]*)"/);
    expect(main, "staff-shell.tsx has no <main className=...>").not.toBeNull();
    expect(main![1].split(/\s+/)).toContain("print:overflow-visible");
  });

  it("keeps the dashboard <Toaster> off the printed page", () => {
    const layout = read("app/(staff)/staff/(dashboard)/layout.tsx");
    expect(layout).toMatch(
      /<div className="print:hidden">\s*<Toaster\b[^>]*\/>\s*<\/div>/,
    );
  });

  it("prints table footers once, at the end", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(
      /@media print\s*{\s*tfoot\s*{\s*display:\s*table-row-group;\s*}\s*}/,
    );
  });
});
