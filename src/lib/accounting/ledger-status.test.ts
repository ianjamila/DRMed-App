/**
 * Guard: every posted-only read of journal data in `src/` is either a ledger
 * TOTAL that counts posted + reversed, or a named LOOKUP on the allowlist
 * below, with a one-line reason.
 *
 * WHY THIS EXISTS
 * ----------------
 * Reversing an entry marks the ORIGINAL `status = 'reversed'` and inserts a
 * mirror `status = 'posted'` entry with debit/credit swapped (see
 * `reverseJournalEntryBySource` in journal-entry.ts). A report that filters
 * `journal_entries.status = 'posted'` therefore keeps the mirror and drops
 * the original — a reversal subtracts the amount twice instead of netting to
 * zero. That shipped: June 2026 showed −₱418,319 of expenses, Cash on Hand
 * was overstated by ₱417,959, and a September undo-release showed −₱360
 * revenue (#222, 0173).
 *
 * The first version of this test pinned four named report files. That caught
 * a regression in those four and nothing else — the NEXT report, written by
 * someone who never saw #222, would copy `.eq("journal_entries.status",
 * "posted")` from a bank-rec query and pass. So this sweeps all of `src/`, in
 * the style of `src/lib/visits/query-surfaces.test.ts`.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. Every read of `journal_entries` / `journal_lines` that pins the entry
 *      status to 'posted' alone sits in a function named in `LOOKUPS`.
 *      Anything else is a total and must use `.in(…, LEDGER_TOTAL_STATUSES)`.
 *      "Posted alone" is `.eq(…, "posted")`, `.in(…, ["posted"])`,
 *      `.filter(…, "eq"|"in", …)`, `.match({ status: "posted" })`,
 *      `.or("….status.eq.posted")`, and the negative spellings
 *      (`.neq(…, "reversed")`, `.not(…, "eq", "reversed")`) that drop the
 *      reversed original just the same. The column is `status` on a
 *      `.from("journal_entries")` chain — or a variable holding one, for a
 *      filter added in a later statement — and `journal_entries.status`
 *      (aliased or nested embeds included) anywhere else. Hoisted string
 *      constants are resolved.
 *   2. Nobody spells the pair inline (`.in(…, ["posted", "reversed"])`): the
 *      constant is the one place the rule is written down, and the thing a
 *      reader greps for.
 *   3. No raw SQL string that names a journal table filters
 *      `status = 'posted'` / `status in ('posted')` outside `LOOKUPS`
 *      (`set status = 'posted'` is a write and is not a read).
 *   4. `LOOKUPS` has no stale entries — each still makes a posted-only read.
 *
 * Writes (`insert`/`update`/`delete`/`upsert`) are skipped: the restore-to-
 * posted on a failed reversal (journal-entry.ts, pf-disbursement-void.ts,
 * hmo-claims actions.ts) writes the status, it doesn't read by it.
 *
 * NOT covered: SQL functions and views in `supabase/migrations` (the
 * `bridge_*` / `ap_*` lookups, the `v_ops_daily_*` totals fixed in 0173), and
 * a status value that only arrives at runtime (a variable parameter).
 *
 * FIXING A FAILURE
 * ----------------
 *   - It sums or presents money over a period → it is a TOTAL:
 *       import { LEDGER_TOTAL_STATUSES } from "@/lib/accounting/ledger-status";
 *       .in("journal_entries.status", LEDGER_TOTAL_STATUSES)
 *   - It finds "the live entry" to match, link, reverse or audit → add
 *     `"<file> › <function>"` to `LOOKUPS` with why posted-only is right.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LEDGER_TOTAL_STATUSES } from "./ledger-status";

const SRC_DIR = join(process.cwd(), "src");

const JOURNAL_TABLES = new Set(["journal_entries", "journal_lines"]);

/**
 * Posted-only reads that are LOOKUPS of the live entry, keyed
 * `"<path under src/> › <nearest named function>"`. A reversed entry is no
 * longer the live record to act on, so these must NOT count it.
 */
const LOOKUPS: Record<string, string> = {
  "app/(staff)/staff/(dashboard)/admin/accounting/bank-rec/actions.ts › runAutoMatch":
    "Auto-match candidates: a bank line can only be matched to a live journal line; a reversed one (and its mirror) never hit the bank.",
  "app/(staff)/staff/(dashboard)/admin/accounting/bank-rec/[id]/page.tsx › BankStatementDetailPage":
    "The manual-match picker offers the same live candidates as runAutoMatch.",
  "app/(staff)/staff/(dashboard)/payments/cash-drawer/actions.ts › recordCashAdjustmentAction":
    "Reads back the JE the insert trigger just posted for this adjustment, for the audit row.",
  "app/(staff)/staff/(dashboard)/payments/cash-drawer/actions.ts › closeEodAction":
    "Reads back the JE the EOD close just posted, for the audit row.",
  "lib/actions/accounting/post-till-cash-expense.ts › postTillCashExpense":
    "Reads back the JE the insert trigger just posted for this till expense, for the audit row.",
  "lib/accounting/journal-entry.ts › reverseJournalEntryBySource":
    "Finds the live entry to reverse; an already-reversed one must not be reversed twice.",
  "lib/accounting/period-counts.ts › postedCountsByMonth":
    "Period-close page: how many entries are posted in each month — a count of live entries, not a money total.",
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

const WRITE_METHODS = new Set(["insert", "update", "delete", "upsert"]);

type Kind = "posted-only" | "inline-pair";

interface Finding {
  file: string;
  line: number;
  /** `"<file> › <function>"` — the LOOKUPS key this read would need. */
  key: string;
  kind: Kind;
}

const isFunctionLike = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

/**
 * The nearest NAMED function around `node`. Anonymous arrows are skipped, so a
 * read inside `fetchCompleteRows((from, to) => …)` is attributed to the
 * function that owns it, not to "(anonymous)".
 */
function scopeName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (
      (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) &&
      cur.name &&
      ts.isIdentifier(cur.name)
    ) {
      return cur.name.text;
    }
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
  }
  return "(module)";
}

/** Nearest enclosing function-like node (or the file). */
function enclosingScope(node: ts.Node, src: ts.SourceFile): ts.Node {
  for (let cur = node.parent; cur; cur = cur.parent) if (isFunctionLike(cur)) return cur;
  return src;
}

/** `<x>.from("journal_entries" | "journal_lines")`. */
function isJournalFrom(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "from") return false;
  const [arg] = node.arguments;
  return !!arg && ts.isStringLiteralLike(arg) && JOURNAL_TABLES.has(arg.text);
}

/** The `.a().b().c()` calls hung off `start`, in order (start included). */
function collectChain(start: ts.CallExpression): ts.CallExpression[] {
  const calls = [start];
  let current: ts.Node = start;
  for (;;) {
    const access = current.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== current) break;
    const call = access.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
    calls.push(call);
    current = call;
  }
  return calls;
}

/** The identifier a chain hangs off: `q` in `q.eq(…).gte(…)`. */
function chainRoot(node: ts.Node): ts.Identifier | null {
  let cur: ts.Node = node;
  for (;;) {
    if (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur : null;
}

const methodOf = (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";

/** `const X = "…"` anywhere in the file, so `.eq("status", POSTED)` still reads as "posted". */
function stringConstants(src: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      out.set(node.name.text, node.initializer.text);
    }
    node.forEachChild(visit);
  };
  visit(src);
  return out;
}

/**
 * `status = 'posted'` / `status in ('posted')` in raw SQL, optionally
 * qualified (`je.status`). The `set` form is a write and is skipped below.
 */
const RAW_POSTED_SQL = /\b(?:\w+\.)?status\s*(?:=\s*'posted'|in\s*\(\s*'posted'\s*\))/gi;

function scanSource(text: string, full: string): Finding[] {
  if (!/journal_(entries|lines)/.test(text)) return [];

  const src = ts.createSourceFile(
    full,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const file = rel(full);
  const consts = stringConstants(src);
  const findings: Finding[] = [];
  const seen = new Set<ts.Node>();

  // An embed aliased in a select (`je:journal_entries!inner ( status )`) is
  // filtered as `je.status`.
  const aliasCols = new Set(
    [...text.matchAll(/\b(\w+)\s*:\s*journal_entries\b/g)].map((m) => `${m[1]}.status`),
  );

  /** Is `col` the JOURNAL entry status? A bare "status" only where the caller says so. */
  const isStatusCol = (col: string | null, bareStatus: boolean) =>
    col !== null &&
    (col === "journal_entries.status" ||
      col.endsWith(".journal_entries.status") ||
      aliasCols.has(col) ||
      (bareStatus && col === "status"));

  const str = (a: ts.Expression | undefined): string | null => {
    if (!a) return null;
    if (ts.isStringLiteralLike(a)) return a.text;
    if (ts.isIdentifier(a)) return consts.get(a.text) ?? null;
    return null;
  };
  const strArg = (call: ts.CallExpression, i: number) => str(call.arguments[i]);

  /** String elements of an array-literal argument, or null if it isn't one. */
  const arrayArg = (call: ts.CallExpression, i: number): string[] | null => {
    let a: ts.Expression | undefined = call.arguments[i];
    while (a && (ts.isAsExpression(a) || ts.isParenthesizedExpression(a))) a = a.expression;
    if (!a || !ts.isArrayLiteralExpression(a)) return null;
    return a.elements.map((e) => str(e)).filter((v): v is string => v !== null);
  };

  /**
   * Classify one filter call. `bareStatus` says whether a plain `"status"`
   * column means the JOURNAL status (true on a `.from("journal_entries")`
   * chain or a variable holding one; false elsewhere, where it is some other
   * table's status).
   *
   * "Posted-only" includes the negative spellings — `.neq(…, "reversed")`
   * drops the reversed original and keeps its mirror exactly like
   * `.eq(…, "posted")` does.
   */
  const classifyFilter = (call: ts.CallExpression, bareStatus: boolean): Kind | null => {
    const method = methodOf(call);

    if (method === "match") {
      const obj = call.arguments[0];
      if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
      for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const name = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
        if (isStatusCol(name, bareStatus) && str(p.initializer) === "posted") return "posted-only";
      }
      return null;
    }

    if (method === "or") {
      const expr = strArg(call, 0);
      if (!expr) return null;
      for (const m of expr.matchAll(/(?:^|[,(])\s*([\w.]+)\.(eq|neq)\.(\w+)/g)) {
        const [, col, op, value] = m;
        if (!isStatusCol(col!, bareStatus)) continue;
        if ((op === "eq" && value === "posted") || (op === "neq" && value === "reversed")) {
          return "posted-only";
        }
      }
      return null;
    }

    if (!isStatusCol(strArg(call, 0), bareStatus)) return null;

    switch (method) {
      case "eq":
        return strArg(call, 1) === "posted" ? "posted-only" : null;
      case "neq":
        return strArg(call, 1) === "reversed" ? "posted-only" : null;
      case "not":
        return strArg(call, 1) === "eq" && strArg(call, 2) === "reversed" ? "posted-only" : null;
      case "filter": {
        const op = strArg(call, 1);
        const value = strArg(call, 2)?.replace(/[()\s"]/g, "");
        if (op === "eq" && value === "posted") return "posted-only";
        if (op === "neq" && value === "reversed") return "posted-only";
        if (op === "in" && value === "posted") return "posted-only";
        return null;
      }
      case "in": {
        const values = arrayArg(call, 1);
        if (!values) return null; // an identifier — LEDGER_TOTAL_STATUSES or a variable
        if (values.length === 1 && values[0] === "posted") return "posted-only";
        if (values.includes("posted") && values.includes("reversed")) return "inline-pair";
        return null;
      }
      default:
        return null;
    }
  };

  const push = (node: ts.Node, kind: Kind) =>
    findings.push({
      file,
      // A chained call starts where the whole chain does; point at the
      // filter's own `.eq` / `.in` instead.
      line:
        src.getLineAndCharacterOfPosition(
          (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name
            : node
          ).getStart(src),
        ).line + 1,
      key: `${file} › ${scopeName(node)}`,
      kind,
    });

  /**
   * Variables holding a `.from("journal_entries")` builder, per function
   * scope — so a filter added in a later statement (`q = q.eq("status",
   * "posted")`) still knows its bare `status` is the journal's.
   */
  const entryVars = new Map<ts.Node, Set<string>>();
  const holdsEntries = (id: ts.Identifier) => {
    for (let cur: ts.Node | undefined = id; cur; cur = cur.parent) {
      if ((isFunctionLike(cur) || ts.isSourceFile(cur)) && entryVars.get(cur)?.has(id.text)) {
        return true;
      }
    }
    return false;
  };

  // (a) Read chains on a journal table. A pass of its own, because the walk
  // below meets a chain's OUTERMOST call (`.eq(…)`) before the `.from(…)` it
  // hangs off — (b) must already know which calls (a) has taken, and which
  // variables hold a journal_entries builder.
  const collectChains = (node: ts.Node) => {
    if (isJournalFrom(node)) {
      const calls = collectChain(node);
      const isWrite = calls.some((c) => WRITE_METHODS.has(methodOf(c)));
      const bareStatus = strArg(node, 0) === "journal_entries";
      for (const call of calls) {
        seen.add(call);
        if (isWrite) continue;
        const kind = classifyFilter(call, bareStatus);
        if (kind) push(call, kind);
      }
      const outer = calls[calls.length - 1]!;
      const decl = outer.parent;
      if (
        bareStatus &&
        !isWrite &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer === outer &&
        ts.isIdentifier(decl.name)
      ) {
        const scope = enclosingScope(decl, src);
        const names = entryVars.get(scope) ?? new Set<string>();
        names.add(decl.name.text);
        entryVars.set(scope, names);
      }
    }
    node.forEachChild(collectChains);
  };
  collectChains(src);

  const visit = (node: ts.Node) => {
    // (b) A journal status filter anywhere else — a chain built across
    // statements (`q = q.eq(…)`), or an embed from another table.
    if (ts.isCallExpression(node) && !seen.has(node)) {
      const root = chainRoot(node);
      const kind = classifyFilter(node, !!root && holdsEntries(root));
      if (kind) push(node, kind);
    }
    // (c) Raw SQL in a string or template literal that reads journal data.
    // An `update … set status = 'posted'` is a write, and a string that never
    // names a journal table is some other table's status.
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const sql = node.getText(src);
      if (/journal_(entries|lines)/.test(sql)) {
        const reads = [...sql.matchAll(RAW_POSTED_SQL)].filter(
          (m) => !/\bset\s+$/i.test(sql.slice(0, m.index)),
        );
        if (reads.length > 0) push(node, "posted-only");
      }
    }
    node.forEachChild(visit);
  };
  visit(src);
  return findings;
}

const findings = walkFiles(SRC_DIR).flatMap((full) =>
  scanSource(readFileSync(full, "utf8"), full),
);

const describeFinding = (f: Finding) => `${f.file}:${f.line} (${f.key})`;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("ledger totals count posted + reversed across src/", () => {
  it("pins the LEDGER_TOTAL_STATUSES value", () => {
    expect(LEDGER_TOTAL_STATUSES).toEqual(["posted", "reversed"]);
  });

  it("finds the known lookups (guard against a bad walk)", () => {
    // Every LOOKUPS entry is a posted-only read today, so an empty or tiny
    // result means the walk broke, not that the code got cleaner.
    expect(findings.filter((f) => f.kind === "posted-only").length).toBeGreaterThanOrEqual(
      Object.keys(LOOKUPS).length,
    );
  });

  it("allows a posted-only journal read only in a named LOOKUP", () => {
    const offenders = findings
      .filter((f) => f.kind === "posted-only" && !(f.key in LOOKUPS))
      .map(describeFinding);
    expect(
      offenders,
      "A ledger TOTAL must filter .in(\"journal_entries.status\", LEDGER_TOTAL_STATUSES) — " +
        "a posted-only filter drops the reversed original and keeps its mirror, subtracting " +
        "every reversal twice. If this is a lookup of the live entry, add it to LOOKUPS with a reason.",
    ).toEqual([]);
  });

  it("spells posted + reversed as LEDGER_TOTAL_STATUSES, never inline", () => {
    const offenders = findings.filter((f) => f.kind === "inline-pair").map(describeFinding);
    expect(offenders).toEqual([]);
  });

  it("gives every LOOKUP a stated reason", () => {
    const blank = Object.entries(LOOKUPS)
      .filter(([, why]) => why.trim().length < 20)
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  it("has no stale LOOKUPS entries", () => {
    const live = new Set(findings.filter((f) => f.kind === "posted-only").map((f) => f.key));
    const stale = Object.keys(LOOKUPS).filter((key) => !live.has(key));
    expect(stale, "These no longer make a posted-only read — remove them from LOOKUPS.").toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// The scanner catches what it should (fed real TypeScript, not hand-built
// findings — the walk is where a guard like this silently goes blind)
// ---------------------------------------------------------------------------

const probe = (source: string) => scanSource(source, join(SRC_DIR, "probe.ts"));

describe("the scanner", () => {
  it("flags a posted-only total on journal_lines", () => {
    const [f] = probe(`
      async function incomeStatement(client) {
        return client.from("journal_lines").select("debit_php, journal_entries!inner(status)")
          .eq("journal_entries.status", "posted");
      }`);
    expect(f).toMatchObject({ kind: "posted-only", key: "probe.ts › incomeStatement" });
  });

  it("flags a bare status = posted inside a journal_entries chain", () => {
    expect(probe(`const f = (c) => c.from("journal_entries").select("id").eq("status", "posted");`))
      .toHaveLength(1);
  });

  it("does not flag a bare status filter on another table", () => {
    expect(probe(`const f = (c) => c.from("bills").select("id").eq("status", "posted");`)).toEqual(
      [],
    );
  });

  it("flags a status filter added in a later statement", () => {
    const found = probe(`
      function report(c) {
        let q = c.from("journal_lines").select("id");
        q = q.eq("journal_entries.status", "posted");
        return q;
      }`);
    expect(found.map((f) => f.kind)).toEqual(["posted-only"]);
  });

  it("flags .filter(…, 'eq', 'posted') and a one-element .in()", () => {
    const found = probe(`
      function a(c) { return c.from("journal_lines").select("id").filter("journal_entries.status", "eq", "posted"); }
      function b(c) { return c.from("journal_lines").select("id").in("journal_entries.status", ["posted"]); }`);
    expect(found.map((f) => f.kind)).toEqual(["posted-only", "posted-only"]);
  });

  it("accepts LEDGER_TOTAL_STATUSES and flags the pair spelled inline", () => {
    const found = probe(`
      function ok(c) { return c.from("journal_lines").select("id").in("journal_entries.status", LEDGER_TOTAL_STATUSES); }
      function inline(c) { return c.from("journal_lines").select("id").in("journal_entries.status", ["posted", "reversed"]); }`);
    expect(found.map((f) => `${f.key}:${f.kind}`)).toEqual(["probe.ts › inline:inline-pair"]);
  });

  it("skips writes that restore status to posted", () => {
    expect(
      probe(`const f = (a, id) => a.from("journal_entries").update({ status: "posted" }).eq("id", id);`),
    ).toEqual([]);
  });

  it("flags raw SQL that filters status = 'posted'", () => {
    const found = probe("const SQL = `select sum(debit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.status = 'posted'`;");
    expect(found.map((f) => f.kind)).toEqual(["posted-only"]);
  });

  it("attributes a read inside an anonymous callback to its named owner", () => {
    const [f] = probe(`
      async function runAutoMatch(admin) {
        return fetchCompleteRows((from, to) =>
          admin.from("journal_lines").select("id").eq("journal_entries.status", "posted").range(from, to));
      }`);
    expect(f?.key).toBe("probe.ts › runAutoMatch");
  });

  it("flags a bare status filter on a journal_entries builder held in a variable", () => {
    const found = probe(`
      function report(c) {
        let q = c.from("journal_entries").select("id");
        q = q.eq("status", "posted");
        return q;
      }`);
    expect(found.map((f) => `${f.key}:${f.kind}`)).toEqual(["probe.ts › report:posted-only"]);
  });

  it("does not borrow a journal_entries variable from another function", () => {
    expect(
      probe(`
        function a(c) { const q = c.from("journal_entries").select("id"); return q; }
        function b(c) { let q = c.from("bills").select("id"); q = q.eq("status", "posted"); return q; }`),
    ).toEqual([]);
  });

  it("does not treat a journal_entries builder's user-chosen status as posted-only", () => {
    expect(
      probe(`
        function list(c, status) {
          let query = c.from("journal_entries").select("id");
          if (status !== "all") query = query.eq("status", status);
          return query;
        }`),
    ).toEqual([]);
  });

  it("flags the negative spellings that drop the reversed original", () => {
    const found = probe(`
      function a(c) { return c.from("journal_entries").select("id").neq("status", "reversed"); }
      function b(c) { return c.from("journal_lines").select("id").not("journal_entries.status", "eq", "reversed"); }
      function d(c) { return c.from("journal_lines").select("id").filter("journal_entries.status", "neq", "reversed"); }`);
    expect(found.map((f) => f.key)).toEqual(["probe.ts › a", "probe.ts › b", "probe.ts › d"]);
  });

  it("flags .match(), .or() and .filter(…, 'in', '(posted)')", () => {
    const found = probe(`
      function a(c) { return c.from("journal_entries").select("id").match({ status: "posted", source_kind: "payment" }); }
      function b(c) { return c.from("journal_lines").select("id").or("journal_entries.status.eq.posted,account_id.eq.x"); }
      function d(c) { return c.from("journal_lines").select("id").filter("journal_entries.status", "in", "(posted)"); }`);
    expect(found.map((f) => f.key)).toEqual(["probe.ts › a", "probe.ts › b", "probe.ts › d"]);
  });

  it("resolves a hoisted string constant", () => {
    const found = probe(`
      const POSTED = "posted";
      function a(c) { return c.from("journal_lines").select("id").eq("journal_entries.status", POSTED); }`);
    expect(found).toHaveLength(1);
  });

  it("follows an aliased or nested journal_entries embed", () => {
    const found = probe(`
      function a(c) { return c.from("journal_lines").select("id, je:journal_entries!inner ( status )").eq("je.status", "posted"); }
      function b(c) { return c.from("bill_payments").select("id, bills ( journal_entries ( status ) )").eq("bills.journal_entries.status", "posted"); }`);
    expect(found.map((f) => f.key)).toEqual(["probe.ts › a", "probe.ts › b"]);
  });

  it("flags raw SQL spelled status in ('posted')", () => {
    const found = probe("const SQL = `select count(*) from journal_entries where status in ('posted')`;");
    expect(found).toHaveLength(1);
  });

  it("does not flag raw SQL on another table, or a write that SETS status = 'posted'", () => {
    expect(
      probe(`
        const A = "select * from bills where status = 'posted'";
        const B = "update journal_entries set status = 'posted' where id = $1";
        const C = "update journal_entries je set je.status = 'posted'";`),
    ).toEqual([]);
  });
});
