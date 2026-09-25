/**
 * Repo guard: no Manila calendar date is derived from a `Date` read in the
 * runtime's own timezone.
 *
 * WHY THIS EXISTS
 * ---------------
 * The clinic is in Manila (Asia/Manila, a fixed UTC+8 with no DST). Production
 * runs in UTC. So for the eight hours between Manila midnight and 08:00 —
 * which is most of a working morning in the Philippines — UTC is still on
 * YESTERDAY'S date. Any code that asks a `Date` object what day it is, instead
 * of asking `manila.ts`, silently answers with the wrong calendar day for that
 * whole window.
 *
 * The same defect has now been fixed four separate times:
 *
 *   #167  every date RENDER was routed through one named formatter, because
 *         `toLocaleDateString()` printed "9/11/2026" on an en-US runtime and
 *         "11 Sept 2026" on en-GB — for a PH clinic a numeric day/month order
 *         is genuinely ambiguous.
 *   #173  the financial-statement presets stamped `${today}T00:00:00+08:00`
 *         (correctly pinning Manila midnight) and then read `getUTCMonth()`
 *         back out. Manila midnight is 16:00 UTC the PREVIOUS day, so on the
 *         1st of any month "This month" returned last month — on exactly the
 *         day someone opens those presets to close the books.
 *   this   the rolling windows: `d.setDate(d.getDate() - 90)` then
 *          `.toISOString().slice(0, 10)`, which is a calendar date computed
 *          in UTC.
 *
 * Each fix was correct and each was invisible to the next author, because
 * nothing in the code says which `Date` methods are safe here. This test says
 * it. It is modelled on `src/lib/visits/query-surfaces.test.ts` and on
 * `scripts/lib/guard-coverage.test.ts`, whose header makes the argument
 * exactly: "a convention nobody checks is a convention that decays."
 *
 * WHAT IT BANS
 * ------------
 * Two shapes, both found by an AST pass so that a comment or a string cannot
 * trip it:
 *
 *   1. LOCAL-ZONE `Date` accessors — `getDate`, `getMonth`, `getFullYear`,
 *      `getDay`, `getHours`, and the matching setters. These read the
 *      *runtime's* zone, which is UTC on the server and the user's own zone in
 *      the browser, so the same code gives two answers.
 *
 *   2. UTC-TRUNCATION TO A CALENDAR DATE — `.toISOString().slice(0, 10)` and
 *      `.toISOString().split("T")[0]`. `toISOString()` itself is fine and is
 *      how you produce an instant; it is slicing the DATE half back out that
 *      re-introduces the bug, because that half is the UTC day.
 *
 * `getUTC*` accessors are banned too, for the #173 reason: they are only ever
 * correct on an instant that was built in UTC, never on one pinned to +08:00.
 *
 * WHAT IT DOES NOT BAN, AND WHO DOES
 * ----------------------------------
 * RENDERING is not this file's job. `date-render-surfaces.test.ts` (#167)
 * already owns it — which format reaches the screen, its two tiers, and the
 * `en-CA`/`sv-SE` exemption for machine-readable `YYYY-MM-DD`. The two guards
 * ask different questions about the same `Date`:
 *
 *   date-render-surfaces  how is this date DISPLAYED?
 *   this file             how was this calendar date COMPUTED?
 *
 * So `toLocaleDateString` / `toLocaleTimeString` are deliberately absent from
 * the list below; adding them here would double-report every render site and
 * put one convention under two owners. `toLocaleString` is absent for a second
 * reason as well: it is overwhelmingly NUMBER formatting in this codebase
 * (`REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")`), and telling a number
 * receiver from a Date one needs a type checker, not a syntax walk.
 *
 * A rolling window of N×24 HOURS compared against a `timestamptz` is also not
 * banned and needs no allowlist entry: `new Date(Date.now() - 7 * 86400000)
 * .toISOString()` is an instant, and comparing instants is
 * timezone-independent. Only truncating one back to a date is the bug.
 *
 * WHAT TO DO WHEN IT FAILS
 * ------------------------
 * Almost always: use a helper from `./manila`.
 *
 *   today, as a calendar date        → `todayManilaISODate()`
 *   N days before/after a date       → `shiftISODate(iso, ±n)`
 *   month/year arithmetic            → `isoDateParts` + `firstOfMonthISO` /
 *                                      `lastOfMonthISO` (string→string, never
 *                                      via a `Date`)
 *   a timestamptz filter for a range → `manilaRangeUtc(start, end)`
 *   rendering                        → `manilaDate` / `manilaDateTime` /
 *                                      `manilaLongDate` / `manilaTime`
 *
 * If the use really is correct, add the file to `ALLOWED` below with the
 * methods it may use and a `why` that says WHY IT IS CORRECT — not what it
 * does. A rolling window of N×24 hours compared against a `timestamptz` is
 * correct and needs no entry at all, because comparing instants is
 * timezone-independent; it is only truncating one to a date that is wrong.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const SRC_DIR = join(process.cwd(), "src");

/** Accessors that read or write in the runtime's own zone. */
const LOCAL_ACCESSORS = [
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMinutes",
  "getMonth",
  "setDate",
  "setFullYear",
  "setHours",
  "setMinutes",
  "setMonth",
] as const;

/** UTC accessors — correct only on an instant that was built in UTC (#173). */
const UTC_ACCESSORS = [
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCHours",
  "getUTCMonth",
  // The setters belong here for the same reason, and structurally rather than
  // incidentally: today every call site pairs a UTC setter with the matching
  // getter in one expression, so banning the getters alone happens to catch
  // them all. That is a coincidence of the current code, not a property of it.
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMinutes",
  "setUTCMonth",
] as const;

const BANNED_METHODS: readonly string[] = [...LOCAL_ACCESSORS, ...UTC_ACCESSORS];

/** The synthetic name reported for `.toISOString().slice(0, 10)` and friends. */
const ISO_TRUNCATION = "toISOString().slice(0,10)";

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------
// Keyed by path relative to `src/`. `methods` is exhaustive for that file: a
// file may use the methods it names and no others. `why` must say why the use
// is CORRECT, and is length-checked below so an empty gesture cannot pass.

interface Allowance {
  methods: readonly string[];
  why: string;
}

// THE ONE ARGUMENT that covers most of this list: a CLOSED UTC ROUND-TRIP.
// `Date.UTC(y, m, d)` (or `Date.parse("…T00:00:00Z")`) builds an instant that
// is UTC midnight BY CONSTRUCTION, and `getUTC*` / `toISOString()` reads the
// same zone back out. No local zone and no +08:00 is ever involved, so the
// components that come out are exactly the ones that went in — and JS folds
// out-of-range values for free, which is why it is also the right way to do
// calendar arithmetic. This is the shape #173 got WRONG: it stamped +08:00 in
// and read UTC out, which are different zones, so the round-trip was open.

// The year/month/day triple every closed round-trip reads back. Entries add
// `getUTCDay` / `getUTCHours` / `setUTCDate` only where the file really calls
// them — the "no allowlisted method that the file no longer calls" rule below
// keeps each allowance as narrow as the code, so a stale one cannot silently
// re-permit a method someone adds later for a different reason.
const UTC_YMD = ["getUTCDate", "getUTCFullYear", "getUTCMonth"];

const ALLOWED: Record<string, Allowance> = {
  // ---- The helper module itself -----------------------------------------
  "lib/dates/manila.ts": {
    methods: [ISO_TRUNCATION],
    why:
      "This IS the helper every other file is required to use. `shiftISODate` " +
      "parses `${date}T00:00:00Z` and reads it back with `toISOString()` — a " +
      "closed UTC round-trip on a value that was never an instant in any " +
      "other zone, which is the one place the truncation is exact.",
  },

  // ---- Closed UTC round-trips: calendar arithmetic with no zone in it ----
  "lib/validations/booking.ts": {
    methods: [...UTC_YMD, "getUTCDay", "getUTCHours"],
    why:
      "`manilaSlotFor` SHIFTS an instant by +8h and then reads UTC off the " +
      "shifted value — shift-then-read-UTC is the deliberate inverse of the " +
      "#173 mistake, and it is correct: the UTC components of (t + 8h) ARE " +
      "the Manila wall-clock components of t, because PH has no DST.",
  },
  "lib/payroll/compute.ts": {
    methods: [...UTC_YMD, "getUTCDay"],
    why:
      "Builds every instant with `Date.UTC(y, m - 1, d)` from a YYYY-MM-DD " +
      "and reads `getUTC*` straight back — a closed round-trip. The DTR day " +
      "list and `dayOfWeek` are pure calendar arithmetic over payroll period " +
      "strings; no 'now' and no zone enters the calculation.",
  },
  "lib/payroll/dtr-parser.ts": {
    methods: UTC_YMD,
    why:
      "`Date.UTC(y, m - 1, d)` in, `getUTC*` out, purely to reject an " +
      "impossible date like 2026-02-31 (JS folds it to March, so the " +
      "components no longer match what went in). A closed round-trip used as " +
      "a validity probe — there is no calendar date being derived at all.",
  },
  "lib/reports/statement-period.ts": {
    methods: UTC_YMD,
    why:
      "Identical validity probe to dtr-parser: `Date.UTC` in, `getUTC*` out, " +
      "to tell a real calendar date from a well-formed but impossible one " +
      "before it reaches a query bound. Closed round-trip, no zone involved.",
  },
  "lib/import/excel-date.ts": {
    methods: UTC_YMD,
    why:
      "An Excel serial is a count of DAYS with no time and no zone. It is " +
      "converted to UTC-epoch milliseconds and read back with `getUTC*` — a " +
      "closed round-trip. Reading local components here is what WOULD shift " +
      "the day; the file's own comment already says so.",
  },
  "lib/marketing/closures.ts": {
    methods: UTC_YMD,
    why:
      "`tomorrowManilaISO` / `addDaysISO` split a Manila YYYY-MM-DD into " +
      "integers, add days inside `Date.UTC(y, m - 1, d + n)` (which folds " +
      "month and year overflow) and read `getUTC*` back. Closed round-trip " +
      "on a calendar date that never becomes an instant in any other zone.",
  },
  "components/marketing/slot-picker.tsx": {
    methods: [...UTC_YMD, "getUTCDay", "setUTCDate"],
    why:
      "Walks 60 days of the booking grid from a Manila YYYY-MM-DD via " +
      "`Date.UTC` + `getUTC*`. Closed round-trip; the cursor is never 'now' " +
      "and is never read in the browser's zone, so the grid is identical for " +
      "a patient booking from any timezone.",
  },
  "app/(staff)/staff/(dashboard)/admin/accounting/periods/actions.ts": {
    methods: UTC_YMD,
    why:
      "`Date.UTC(year, endMonth, 0)` is the 'day zero of the next month' " +
      "trick for the last day of a quarter, read back with `getUTC*`. Closed " +
      "round-trip over two integers — the file's own comment names the drift " +
      "it is avoiding.",
  },
  "app/(staff)/staff/(dashboard)/admin/accounting/periods/page.tsx": {
    methods: UTC_YMD,
    why:
      "Same last-day-of-quarter trick as its actions file, plus " +
      "`new Date(posting_date).getUTCMonth()` — and `posting_date` is a " +
      "Postgres DATE, which PostgREST returns as a bare YYYY-MM-DD that JS " +
      "parses as UTC midnight by spec. UTC in, UTC out.",
  },
  "app/(staff)/staff/(dashboard)/admin/payroll/ot-slips/page.tsx": {
    methods: UTC_YMD,
    why:
      "Shifts a payroll-period YYYY-MM-DD by whole days through " +
      "`Date.UTC(...) + days * 86_400_000` and reads `getUTC*` back. Closed " +
      "round-trip; a day is exactly 86,400,000 ms in UTC, with no DST to " +
      "make that false.",
  },
  "app/(staff)/staff/(dashboard)/admin/payroll/periods/page.tsx": {
    methods: ["getUTCDate"],
    why:
      "`new Date(Date.UTC(year, month, 0)).getUTCDate()` is days-in-month " +
      "for the semi-monthly payroll period end. Two integers in, an integer " +
      "out, entirely inside UTC — it never represents a moment in time.",
  },
  "app/(staff)/staff/(dashboard)/admin/closures/page.tsx": {
    methods: ["getUTCDate", "setUTCDate"],
    why:
      "Builds the half-open Manila day bound by taking Manila midnight and " +
      "adding ONE UTC DAY to it. That is +24h, and Manila midnight + 24h is " +
      "the next Manila midnight because PH has no DST — so the +08:00 pin is " +
      "preserved, not undone. The result is used as an instant, never sliced " +
      "back to a date.",
  },
  "lib/operations/daily-report.ts": {
    methods: [ISO_TRUNCATION],
    why:
      "`enumerateDays` parses both ends with an explicit `T00:00:00Z` and " +
      "steps in whole UTC days, so `toISOString().slice(0, 10)` reads back " +
      "the same zone it wrote. A closed round-trip over a calendar range " +
      "that came in as two Manila YYYY-MM-DD strings and goes out as more.",
  },

  // ---- Closed LOCAL round-trip ------------------------------------------
  "app/(staff)/staff/(dashboard)/marketing/_components/ops-tracker.tsx": {
    methods: ["getDate", "getFullYear", "getMonth", "getUTCDate", "getUTCDay", "getUTCFullYear", "setUTCDate"],
    why:
      "`manilaPeriodKeys` starts from `todayManilaISODate()`, splits it to " +
      "integers and builds `new Date(y, m - 1, d)` — a LOCAL midnight — then " +
      "`isoWeek` reads `getFullYear/getMonth/getDate` back in that same " +
      "local zone. Construct-local/read-local cancels the zone out exactly, " +
      "so the ISO week is computed from the Manila date in any browser.",
  },

  // ---- Sample data and an uploaded-CSV grouping key ----------------------
  "app/(staff)/staff/(dashboard)/marketing/_components/ad-dashboard.tsx": {
    methods: ["getDate", "getFullYear", "getMonth", "setDate", ISO_TRUNCATION],
    why:
      "Two non-clinic uses. `new Date(2026, 5, 15)` is the base of a " +
      "FABRICATED 28-day demo series shown when no CSV is loaded — the dates " +
      "are invented, so there is no true value to be wrong about. The second " +
      "parses a textual date out of a Meta/Google CSV into a grouping key " +
      "for that upload only; it is local-parse/local-read, and nothing is " +
      "written to the database from this page.",
  },

  // ---- Import parsers: a date TOKEN, not an instant ----------------------
  "lib/import/parse-mastersheet.ts": {
    methods: [ISO_TRUNCATION],
    why:
      "The `Date` here comes from the xlsx reader, which emits date cells as " +
      "UTC instants with no time-of-day (its sibling branch converts the raw " +
      "serial through `excelSerialToISODate`, same convention). Reading UTC " +
      "back off a UTC-constructed, midnight-valued instant is exact.",
  },
  "lib/validations/patient-import.ts": {
    methods: [ISO_TRUNCATION],
    why:
      "A last-resort branch reached only when the explicit ISO and " +
      "MM/DD/YYYY patterns above it have both failed, over a date-only token " +
      "from an uploaded file — which JS parses as UTC midnight by spec, " +
      "making the round-trip exact. The import flow is server-side (UTC) and " +
      "shows every parsed birthdate in a preview before writing.",
  },
  "app/(staff)/staff/(dashboard)/admin/accounting/bank-rec/actions.ts": {
    methods: [ISO_TRUNCATION],
    why:
      "Identical last-resort branch to patient-import, in a `use server` " +
      "module: a bank statement's date cell, reached only after the explicit " +
      "ISO and MM/DD/YYYY patterns fail, over a date-only token that parses " +
      "as UTC midnight. Every parsed line is shown for review before it is " +
      "matched against a bill.",
  },
};

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const isCheckable = (p: string) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}

const rel = (full: string) => relative(SRC_DIR, full).split(sep).join("/");

interface Hit {
  file: string;
  line: number;
  method: string;
  text: string;
}

/**
 * Split out from the walk so the negative cases at the bottom can feed it real
 * TypeScript. The distinction that matters most lives here: a Date method is
 * always a PROPERTY ACCESS (`d.setDate(…)`), whereas React's `setDate` state
 * setter is a bare identifier call (`setDate(e.target.value)`). Matching on
 * text alone reports every date-picker in the app.
 */
export function scanSource(text: string, full: string): Hit[] {
  const src = ts.createSourceFile(
    full,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const file = rel(full);
  const hits: Hit[] = [];

  const lineOf = (node: ts.Node) =>
    src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

  const snippet = (node: ts.Node) =>
    node.getText(src).replace(/\s+/g, " ").slice(0, 120);

  /**
   * `expr.toISOString().slice(0, 10)` / `.split("T")[0]`. Reported against the
   * `.toISOString()` call so the message points at the truncation, not at the
   * whole enclosing statement.
   */
  const isIsoTruncation = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const name = callee.name.text;

    if (name === "slice") {
      const inner = callee.expression;
      return (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === "toISOString"
      );
    }

    if (name === "split") {
      const inner = callee.expression;
      const arg = node.arguments[0];
      return (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === "toISOString" &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg) &&
        arg.text === "T"
      );
    }

    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (isIsoTruncation(node)) {
        hits.push({
          file,
          line: lineOf(node),
          method: ISO_TRUNCATION,
          text: snippet(node),
        });
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if (BANNED_METHODS.includes(name)) {
          hits.push({ file, line: lineOf(node), method: name, text: snippet(node) });
        }
      }
    }
    node.forEachChild(visit);
  };

  visit(src);
  return hits;
}

const scanFile = (full: string): Hit[] => scanSource(readFileSync(full, "utf8"), full);

const allHits = walkFiles(SRC_DIR).flatMap(scanFile);

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const FIX_HINT =
  "Use a helper from src/lib/dates/manila.ts: todayManilaISODate() for " +
  "today, shiftISODate(iso, ±n) for a rolling window, isoDateParts + " +
  "firstOfMonthISO/lastOfMonthISO for month arithmetic, manilaRangeUtc() for " +
  "a timestamptz filter, manilaDate()/manilaDateTime() to render. If the use " +
  "really is correct, add the file to ALLOWED with a 'why' that says why.";

describe("Manila dates are never read out of a Date in the runtime's zone", () => {
  it("finds date call sites to scan (guard against a bad walk)", () => {
    // If a refactor breaks the walk this test would go green while checking
    // nothing, which is the failure mode a static guard cannot afford.
    expect(walkFiles(SRC_DIR).length).toBeGreaterThan(400);
    expect(allHits.length).toBeGreaterThan(0);
  });

  it("has no unallowlisted local-timezone date reads", () => {
    const offenders = allHits
      .filter((h) => !ALLOWED[h.file]?.methods.includes(h.method))
      .map((h) => `${h.file}:${h.line}  ${h.method}  —  ${h.text}`);

    expect(offenders.sort(), FIX_HINT).toEqual([]);
  });

  it("gives every allowlisted file a stated reason", () => {
    const unexplained = Object.entries(ALLOWED)
      .filter(([, a]) => a.why.trim().length < 80)
      .map(([f]) => f);

    expect(
      unexplained.sort(),
      "An ALLOWED entry's 'why' has to argue that the use is CORRECT — which " +
        "instant it holds and which zone that instant was built in — not " +
        "describe what the code does. A reviewer has to be able to check it.",
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const seen = new Set(allHits.map((h) => h.file));
    const stale = Object.keys(ALLOWED).filter((f) => !seen.has(f));

    expect(
      stale.sort(),
      "These ALLOWED entries no longer contain a banned call — delete them " +
        "so the list stays a true map of the exceptions that exist.",
    ).toEqual([]);
  });

  it("has no allowlisted method that the file no longer calls", () => {
    const byFile = new Map<string, Set<string>>();
    for (const h of allHits) {
      if (!byFile.has(h.file)) byFile.set(h.file, new Set());
      byFile.get(h.file)!.add(h.method);
    }

    const stale = Object.entries(ALLOWED).flatMap(([f, a]) =>
      a.methods
        .filter((m) => !byFile.get(f)?.has(m))
        .map((m) => `${f}: ${m}`),
    );

    expect(
      stale.sort(),
      "An allowance names a method the file no longer calls. Narrow the " +
        "entry — a stale method silently re-permits the bug if someone adds " +
        "that call back for a different reason.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The scanner's own behaviour
// ---------------------------------------------------------------------------
// The walk is where this kind of guard actually goes wrong, so the shapes it
// must and must not catch are pinned here rather than assumed.

describe("the scanner tells a Date method from a state setter", () => {
  const scan = (text: string, name = "sample.tsx") =>
    scanSource(text, join(SRC_DIR, name)).map((h) => h.method);

  it("catches a local-zone accessor on a Date", () => {
    expect(scan("const d = new Date(); d.setDate(d.getDate() - 90);")).toEqual([
      "setDate",
      "getDate",
    ]);
  });

  it("ignores a React state setter of the same name", () => {
    // Every date-picker in the app is `onChange={(e) => setDate(e.target.value)}`.
    // Matching on text alone reports all of them and the guard gets deleted.
    expect(scan("<input onChange={(e) => setDate(e.target.value)} />")).toEqual([]);
  });

  it("catches truncating an instant back to a UTC calendar date", () => {
    expect(scan('const t = new Date().toISOString().slice(0, 10);')).toEqual([
      ISO_TRUNCATION,
    ]);
    expect(scan('const t = new Date().toISOString().split("T")[0];')).toEqual([
      ISO_TRUNCATION,
    ]);
  });

  it("leaves a bare toISOString() alone — an instant is timezone-independent", () => {
    expect(scan("const since = new Date(Date.now() - 7 * 86400000).toISOString();")).toEqual(
      [],
    );
  });

  it("catches the getUTC-off-a-+08:00-instant shape (#173)", () => {
    expect(
      scan('const d = new Date(`${today}T00:00:00+08:00`); const m = d.getUTCMonth();'),
    ).toEqual(["getUTCMonth"]);
  });

  it("does not read a method name out of a comment or a string", () => {
    expect(scan('// d.getDate() used to be here\nconst s = "d.getDate()";')).toEqual([]);
  });
});
