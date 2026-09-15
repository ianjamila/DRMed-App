import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One date format, enforced.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app rendered dates three different ways at once. `toLocaleDateString()`
 * with a `timeZone` but no `month`/`dateStyle` falls back to NUMERIC —
 * "9/11/2026" — which for a PH clinic is genuinely ambiguous (9 November or
 * 11 September?). 36 call sites did exactly that.
 *
 * It also shipped wrong in the other direction: `manilaDate` was briefly
 * written against `en-GB` ("11 Sept 2026") and **build, typecheck, lint and
 * the whole unit suite stayed green** — nothing asserted what reached the
 * screen. `manila-format.test.ts` now pins the literal output; this file
 * makes sure every surface actually goes through it.
 *
 * The named formatters, all in `src/lib/dates/manila.ts` unless noted:
 *
 *   manilaDate           "Sep 11, 2026"                  — the house default
 *   manilaDateTime       "Sep 11, 2026, 2:06 PM"
 *   manilaTime           "2:06 PM"
 *   manilaLongDate       "September 11, 2026"            — a date as a headline
 *   friendlyManilaDate   "Friday, September 11, 2026"    — day headers
 *   formatManilaDateTime "September 11, 2026 at 2:06 PM" — patient comms
 *                        (`src/lib/notifications/format-manila-datetime.ts`)
 *
 * TWO TIERS, AND WHY
 * ------------------
 * TIER 1 — a NUMERIC date render. This is the bug itself, it is now at zero,
 * and it has NO exemptions. `Intl` emits only the fields you ask for, so the
 * formatter that falls back to the numeric default is the one that asks for
 * NOTHING: empty options, or `timeZone` alone. A partial formatter (weekday
 * alone, year alone) is composed into a larger string and is not this bug.
 *
 * TIER 2 — building ANY date format inline rather than importing a formatter.
 * Every one of these renders correctly today; the problem is that the format
 * drifts each time someone copies a neighbouring page, which is how tier 1
 * happened. `INLINE_FORMAT_FILES` freezes the pre-existing ones so the set
 * can only SHRINK: a new file fails, and deleting an entry that no longer
 * applies also fails. Several of those formats are deliberately NOT the house
 * default (a 2-digit year in a dense table, a compact payroll period label,
 * a fixed-width date inside a lab PDF), so converting them would be a visual
 * regression, not a cleanup — they are exceptions on purpose.
 *
 * MACHINE-READABLE LOCALES ARE NOT DISPLAY FORMATS
 * ------------------------------------------------
 * `en-CA` and `sv-SE` both render `2026-09-11`, and that is why the app uses
 * them: to derive a Manila `YYYY-MM-DD` for an `<input type="date">`, a query
 * bound, or a CSV key. Swapping one to `manilaDate` silently breaks the input
 * or filter it feeds. They are exempt from both tiers. (`todayManilaISODate()`
 * is the preferred spelling for "today"; a local `en-CA` formatter is correct,
 * not a violation.)
 *
 * NUMBER formatting is out of scope entirely: `toLocaleString()` with no
 * options, or with only `minimumFractionDigits`/`maximumFractionDigits`/
 * `style: "currency"`, is how pesos and row counts are rendered, and
 * `Intl.NumberFormat` is never matched.
 *
 * FIXING A FAILURE
 * ----------------
 * Import the formatter that matches what you want to show. If none does, add
 * one to `manila.ts` with a test pinning its literal output — do not inline
 * `Intl` options in a page.
 */

const SRC = join(process.cwd(), "src");

/** The only two modules allowed to construct a date/time format. */
const FORMATTER_MODULES = [
  "src/lib/dates/manila.ts",
  "src/lib/notifications/format-manila-datetime.ts",
] as const;

/**
 * Files that still build a date format inline. FROZEN — this list may only
 * shrink. Each renders a spelled month today, so none is a tier-1 bug; the
 * grouping says why each has not been folded into a shared formatter.
 */
const INLINE_FORMAT_FILES: Record<string, string> = {
  // Payroll runs on its own compact period vocabulary ("Sep 1 – 15", "2026")
  // that no house formatter produces. Converting these would change what the
  // payroll screens say, not just how they say it.
  "src/lib/payroll/format.ts": "compact payroll period labels",
  "src/lib/payroll/compute.ts": "24-hour HH:mm for DTR arithmetic, not display",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/runs/runs-client.tsx": "payroll period labels",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/periods/periods-client.tsx": "payroll period labels",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/leaves/leaves-client.tsx": "payroll period labels",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/holidays/holidays-client.tsx":
    "weekday + date, so a holiday's day of week is visible",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/ot-slips/ot-slips-client.tsx": "payroll period labels",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/employees/employees-client.tsx": "payroll period labels",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/employees/[id]/employee-detail-client.tsx":
    "payroll period labels",
  "src/app/(staff)/staff/(dashboard)/admin/payroll/runs/[id]/dtr/dtr-upload-client.tsx":
    "DTR punch times",
  "src/app/(staff)/staff/payslips/payslips-client.tsx": "payslip period ranges; outside StaffShell",

  // Deliberately denser or longer than the house format.
  "src/app/(staff)/staff/(dashboard)/admin/gift-codes/page.tsx": "2-digit year — dense code table",
  "src/app/(staff)/staff/(dashboard)/admin/gift-codes/[id]/page.tsx": "gift-code lifecycle stamps",
  "src/app/(staff)/staff/(dashboard)/admin/gift-codes/sales/page.tsx": "no year — same-year sales list",
  "src/app/(staff)/staff/(dashboard)/inquiries/page.tsx": "no year — current inquiries only",
  "src/lib/results/pdf-document.tsx": "fixed-width date inside the rendered lab PDF",
  "src/lib/marketing/nap.ts": "opening hours: weekday + 24-hour clock",
  "src/app/(staff)/staff/(dashboard)/payments/eod/eod-client.tsx": "long date + weekday, EOD header",
  "src/app/(staff)/staff/(dashboard)/payments/eod/[closeId]/count-sheet/page.tsx":
    "long date on a printed count sheet",

  // Correct house format, built inline. These are the genuine cleanup backlog.
  "src/app/(staff)/staff/(dashboard)/_dashboards/_components/format.ts": "shared dashboard time helper",
  "src/app/(staff)/staff/(dashboard)/admin/prices/service-history-panel.tsx":
    "house date + time, built inline",
  "src/app/(staff)/staff/(dashboard)/services/[id]/edit/page.tsx":
    "house date + time, built inline",
  "src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx": "house date + time, built inline",
};

/** Option keys that make a call a date/time render rather than a number one. */
const DATE_TIME_OPTION =
  /\b(timeZone|dateStyle|timeStyle|weekday|era|year|month|day|hour|minute|second|timeZoneName|hour12|dayPeriod)\s*:/;

/** Locales whose output is a machine-readable ISO string, not a display date. */
const MACHINE_LOCALE = /["'](en-CA|sv-SE)["']/;

/**
 * Any requested field. `Intl` only emits the fields you ask for, so a
 * formatter that requests *nothing* (options empty, or `timeZone` alone) is
 * the one that falls back to the numeric default `9/11/2026`. A partial
 * formatter — weekday alone, year alone — is composed into a larger string
 * elsewhere and is not the bug.
 */
const REQUESTS_A_FIELD =
  /\b(dateStyle|timeStyle|weekday|era|year|month|day|hour|minute|second|dayPeriod|timeZoneName)\s*:/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Slice out the balanced argument list starting at `open` (the `(`). */
function argsAt(src: string, open: number): string {
  let i = open + 1;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  return src.slice(open + 1, i - 1);
}

interface Render {
  file: string;
  line: number;
  call: string;
  /** True when the options omit both `month` and `dateStyle` → "9/11/2026". */
  numeric: boolean;
}

const CALL =
  /\.(toLocaleDateString|toLocaleTimeString|toLocaleString)\s*\(|new Intl\.DateTimeFormat\s*\(/g;

function scanSource(rel: string, src: string): Render[] {
  const found: Render[] = [];
  const re = new RegExp(CALL.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const args = argsAt(src, src.indexOf("(", m.index));
    const method = m[1] ?? "Intl.DateTimeFormat";

    if (MACHINE_LOCALE.test(args)) continue;
    // A bare `toLocaleString`, or one with only number options, is money.
    if (method === "toLocaleString" && !DATE_TIME_OPTION.test(args)) continue;
    found.push({
      file: rel,
      line: src.slice(0, m.index).split("\n").length,
      call: `${method}(${args.replace(/\s+/g, " ").trim().slice(0, 96)})`,
      // `toLocaleTimeString` always emits a clock time, never a date.
      numeric: method !== "toLocaleTimeString" && !REQUESTS_A_FIELD.test(args),
    });
  }
  return found;
}

function scanFile(file: string): Render[] {
  return scanSource(relative(process.cwd(), file), readFileSync(file, "utf8"));
}

const FILES = walk(SRC);
const ALL = FILES.flatMap(scanFile);
const show = (rs: Render[]) =>
  "\n" + rs.map((r) => `  ${r.file}:${r.line}\n      ${r.call}`).join("\n") + "\n";

describe("date rendering goes through one of the named Manila formatters", () => {
  it("scans the whole source tree", () => {
    // Guards the guard: a broken walk would make everything below vacuous.
    expect(FILES.length).toBeGreaterThan(400);
    expect(ALL.length).toBeGreaterThan(20);
  });

  it("TIER 1 — nothing renders an ambiguous numeric date, anywhere", () => {
    const numeric = ALL.filter((r) => r.numeric);
    expect(
      numeric,
      `${show(numeric)}\nThese render "9/11/2026" — 9 November or 11 September? ` +
        `Use manilaDate / manilaDateTime instead. There is no exemption for this.\n`,
    ).toEqual([]);
  });

  it("TIER 2 — no NEW file builds a date format inline", () => {
    const allowed = new Set<string>([...FORMATTER_MODULES, ...Object.keys(INLINE_FORMAT_FILES)]);
    const rogue = ALL.filter((r) => !allowed.has(r.file));
    expect(
      rogue,
      `${show(rogue)}\nImport a formatter from @/lib/dates/manila instead of ` +
        `inlining Intl options. If you genuinely need a new format, add it there ` +
        `with a test pinning its literal output.\n`,
    ).toEqual([]);
  });

  it("TIER 2 — the allow-list may only shrink", () => {
    const withRenders = new Set(ALL.map((r) => r.file));
    const stale = Object.keys(INLINE_FORMAT_FILES).filter((f) => !withRenders.has(f));
    expect(
      stale,
      `\n  ${stale.join("\n  ")}\n\nThese no longer build a date format inline — ` +
        `delete them from INLINE_FORMAT_FILES.\n`,
    ).toEqual([]);
  });

  it("every allow-list entry carries a reason", () => {
    for (const [file, reason] of Object.entries(INLINE_FORMAT_FILES)) {
      expect(reason.length, file).toBeGreaterThan(8);
    }
  });
});

// The scanner is regex-based, so these pin that it actually FIRES. Without
// them a refactor could quietly turn the sweep above into a no-op.
describe("the scanner itself", () => {
  const scan = (src: string) => scanSource("src/app/probe/page.tsx", src);

  it("flags the numeric-date bug as tier 1", () => {
    const [hit, ...rest] = scan(
      `const d = new Date(x).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" });`,
    );
    expect(rest).toEqual([]);
    expect(hit.numeric).toBe(true);
  });

  it("flags the numeric bug in the constructor form too", () => {
    // This is the form the first sweep missed, in the patient portal.
    const [hit] = scan(`new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila" }).format(d)`);
    expect(hit.numeric).toBe(true);
  });

  it("flags an inline re-derivation as tier 2, not tier 1", () => {
    const [hit] = scan(
      `new Date(x).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })`,
    );
    expect(hit.numeric).toBe(false);
  });

  it("does not call a time-only render numeric", () => {
    expect(scan(`d.toLocaleTimeString("en-PH", { hour: "numeric" })`)[0].numeric).toBe(false);
    expect(
      scan(`new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit" })`)[0].numeric,
    ).toBe(false);
  });

  it("does not flag peso or count formatting", () => {
    expect(scan(`\`₱\${n.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\``)).toEqual([]);
    expect(scan(`count.toLocaleString()`)).toEqual([]);
    expect(scan(`new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" })`)).toEqual(
      [],
    );
  });

  it("does not flag the machine-readable ISO locales", () => {
    expect(scan(`new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" })`)).toEqual([]);
    expect(scan(`new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Manila" })`)).toEqual([]);
  });

  it("does not flag a call to a named formatter", () => {
    expect(scan(`<td>{manilaDateTime(r.created_at)}</td>`)).toEqual([]);
  });
});
