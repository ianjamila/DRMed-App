// Guard for the kit rule "never sticky inside the staff shell": the shell's
// <main> is overflow-x-auto (staff-shell.tsx), which makes it the scroll
// container a sticky element resolves against — and <main> never scrolls, so
// a `sticky bottom-0` bar just sits under the content. Bottom bars use
// FixedBottomBar instead. Horizontal sticky (`sticky left-0` table columns)
// and sticky headers inside their own scroll container (modals, drawers) are
// fine and are not matched / are allowlisted.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src/app/(staff)", "src/components/staff"];
const ALLOW: Record<string, string> = {
  // Inside the drawer's own overflow-y-auto panel, not the shell's <main>.
  "src/app/(staff)/staff/(dashboard)/admin/payroll/runs/[id]/_components/earning-deduction-drawer.tsx":
    "drawer is its own scroll container",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("staff shell bottom bars", () => {
  it("never use sticky bottom positioning", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = relative(process.cwd(), file);
        if (ALLOW[rel]) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const hasStickyThenBottom = /\bsticky\b[^"'`]*\bbottom-/.test(line);
            const hasBottomThenSticky = /\bbottom-[^"'`]*\bsticky\b/.test(line);
            if (hasStickyThenBottom || hasBottomThenSticky) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
