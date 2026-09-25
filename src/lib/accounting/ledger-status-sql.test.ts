/**
 * Guard: the DATABASE half of "ledger totals count posted + reversed".
 *
 * WHY THIS EXISTS
 * ----------------
 * `ledger-status.test.ts` sweeps the TypeScript in `src/`. It cannot see SQL
 * views and functions, and that is where #222's worst damage lived: the
 * `v_ops_daily_*` views filtered `je.status = 'posted'`, keeping every
 * reversal mirror and dropping its original, so the Operations dashboard
 * subtracted each undo twice (June 2026: −₱418,319 of expenses). 0173 fixed
 * them; nothing stopped the next `create or replace view` from putting the
 * posted-only filter back.
 *
 * HOW
 * ---
 * It replays `supabase/migrations/` in order with a small SQL lexer (string,
 * quoted-identifier, dollar-quote and nested-comment aware, so a `;` or `--`
 * inside a literal cannot cut a statement short) and keeps the LATEST definition of
 * every view, function and procedure: a later `create or replace` supersedes
 * an earlier one, `drop` removes it (per overload — functions are keyed by
 * name AND argument TYPES), `alter … rename to` / `set schema` move it. That
 * is the set live on the database once every migration has run. A definition
 * the replay cannot read (a `begin atomic` body, a function or view created
 * inside a `do` block that touches the journal) FAILS rather than vanishing.
 *
 * Each body is then split into query units — every plpgsql statement, every
 * parenthesised `select`/`with` (subqueries, CTEs, derived tables), and each
 * arm of a `union`/`intersect`/`except` — and each is judged by its OWN
 * filters, not a sibling's. CTE names resolve by lexical scope.
 *
 * Checked against prod on 2026-09-25 (head 0177): `pg_proc`/`pg_class` list
 * 31 functions + 3 views whose definition mentions a journal table; the
 * replay finds the same 29 functions that READ one plus the 3 views. The
 * other two are the journal tables' own trigger functions
 * (`journal_entries_block_petty_cash_source`,
 * `journal_lines_block_inactive_account`), whose only mention is their name.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. POSTED-ONLY READS. A unit that reads journal data with a posted-only
 *      predicate — `status = 'posted'` (also `::text` casts, the operands
 *      swapped, and any `in (…)` / `= any(array[…])` list whose values are
 *      only 'posted' — `in ('posted', 'posted')` included) or the negative
 *      spellings `<> 'reversed'`, `!= 'reversed'`, a `not in (…)` list of
 *      only 'reversed', `is distinct from 'reversed'` — must sit in an object named in
 *      `SQL_LOOKUPS` with a reason. A qualified predicate is exempt only when
 *      its qualifier is PROVEN to be another base table (`bills b` →
 *      `b.status`); a CTE, a derived table, a journal-reading view, a record
 *      variable or anything unresolved counts. Also exempt: assignments in an
 *      UPDATE's SET list (a write) and `new.status` / `old.status` (a trigger
 *      testing its own row).
 *   2. JOURNAL SUMS. A unit that calls `sum(` over journal data — read
 *      directly, or through a subquery, CTE or journal-reading view — must
 *      filter status to exactly {posted, reversed} itself (a `filter (where …)`
 *      clause counts only for the aggregate it is attached to), or every
 *      journal source it reads must. Unless `SQL_AGGREGATE_EXEMPT` says why.
 *   3. No stale allowlist entries, and no overloaded journal function (the
 *      allowlists key by name).
 *   4. Every SQL_LOOKUPS function carries a `comment on function` saying it
 *      is posted-only on purpose and naming SQL_LOOKUPS (0180), so the reason
 *      is on the object too, for anyone editing it from psql or Studio. The
 *      replay tracks comments per overload: `create or replace` keeps one,
 *      `drop` loses it, `rename to` carries it, `is null` removes it.
 *
 * NOT covered: SQL built at runtime (`execute format(…)`); a plpgsql
 * row-by-row total (`for r in … loop t := t + r.debit_php`) that has no
 * status filter at all (rule 1 still catches one that filters posted-only);
 * and SQL written to evade a regex-level reader. This is a lexer plus
 * heuristics, not a Postgres parser — it errs toward flagging, and the
 * allowlists absorb the false alarms. The probe tests below pin every shape
 * two review rounds (Fable, Astra) raised.
 *
 * FIXING A FAILURE
 * ----------------
 *   - A report, dashboard view or total → `where je.status in ('posted',
 *     'reversed')`, so a reversed pair nets to zero.
 *   - A lookup of "the live entry" (idempotency check, the entry to reverse,
 *     "does a posted JE exist yet") → add it to `SQL_LOOKUPS` with why.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

/** Live functions whose posted-only journal read finds "the live entry". */
const SQL_LOOKUPS: Record<string, string> = {
  "function:bridge_payment_insert":
    "Idempotency: skips the insert when a live posted JE already exists for this payment.",
  "function:bridge_payment_void":
    "Finds the live payment JE to reverse; a reversed one must not be reversed twice.",
  "function:bridge_payment_delete":
    "Finds the live payment JE to reverse when a payment row is hard-deleted before being voided.",
  "function:bridge_test_request_released":
    "Idempotency: one live revenue JE per released line; a reversed one (after an undo) lets a re-release post again.",
  "function:bridge_test_request_cancelled":
    "Finds the live revenue JE to reverse on cancel.",
  "function:fn_undo_release_bridge":
    "Finds the live revenue JE to reverse on undo-release.",
  "function:bridge_hmo_claim_resolution_insert":
    "Idempotency: one live JE per HMO claim resolution.",
  "function:bridge_hmo_claim_resolution_void":
    "Finds the live resolution JE to reverse on void.",
  "function:bridge_cash_adjustment_insert":
    "Idempotency: one live JE per cash-drawer adjustment.",
  "function:bridge_cash_adjustment_void":
    "Finds the live adjustment JE to reverse on void.",
  "function:ap_reverse_je_for_source":
    "Finds the live AP JE (bill post / bill payment) to reverse on void.",
  "function:payments_block_post_je_edits":
    "Blocks editing a payment while its live posted JE stands; once reversed (voided) the row is no longer on the books.",
  "function:cash_adjustments_block_post_je_edits":
    "Same guard for cash-drawer adjustments.",
  "function:coa_account_has_open_period_postings":
    "CoA deactivation gate: does a live posted line hit this account in an open period? A reversed original is always accompanied by its posted mirror, so the answer is unchanged.",
  "function:recompute_clinic_fee_for_unreleased":
    "Only recomputes lines with no live revenue JE yet; a line whose JE was reversed is unreleased again and may be recomputed.",
};

/** Live functions that sum journal amounts without the posted + reversed pair. */
const SQL_AGGREGATE_EXEMPT: Record<string, string> = {
  "function:je_lines_balance_check":
    "Balance check of ONE entry's own lines (debits = credits), not a ledger total.",
  "function:je_status_balance_check":
    "Balance check of ONE entry's own lines as it is posted, not a ledger total.",
};

/** Journal-reading objects seen on prod (2026-09-25) — the replay must find each. */
const SEEN_ON_PROD = [
  "function:ap_bill_payment_bridge",
  "function:ap_bill_post_bridge",
  "function:ap_reverse_je_for_source",
  "function:bridge_cash_adjustment_insert",
  "function:bridge_cash_adjustment_void",
  "function:bridge_eod_close",
  "function:bridge_hmo_claim_resolution_insert",
  "function:bridge_hmo_claim_resolution_void",
  "function:bridge_payment_delete",
  "function:bridge_payment_insert",
  "function:bridge_payment_void",
  "function:bridge_payroll_13th_month_payout",
  "function:bridge_payroll_payout_bank",
  "function:bridge_payroll_run_finalise",
  "function:bridge_payroll_run_void",
  "function:bridge_pf_at_hmo_allocation",
  "function:bridge_pf_at_hmo_writeoff",
  "function:bridge_pf_disbursement_post",
  "function:bridge_replay_summary",
  "function:bridge_test_request_cancelled",
  "function:bridge_test_request_released",
  "function:cash_adjustments_block_post_je_edits",
  "function:coa_account_has_open_period_postings",
  "function:fn_undo_release_bridge",
  "function:je_lines_balance_check",
  "function:je_status_balance_check",
  "function:payments_block_post_je_edits",
  "function:recompute_clinic_fee_for_unreleased",
  "function:send_out_spend_by_lab",
  "view:v_ops_daily_expense_accounts",
  "view:v_ops_daily_expenses",
  "view:v_ops_daily_pnl",
];

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/**
 * Two same-length views of `sql`:
 *   clean — comments blanked (newlines kept), everything else verbatim;
 *   mask  — clean, with every non-word character INSIDE a string literal,
 *           quoted identifier or dollar-quoted body replaced by `_`. Letters
 *           survive, so `'posted'` still reads as posted, but a `;`, `(` or
 *           `--` inside a literal can no longer end a statement, open a group
 *           or start a comment.
 */
function lex(sql: string): { clean: string; mask: string } {
  const clean = sql.split("");
  const mask = sql.split("");
  const n = sql.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) {
      if (sql[k] !== "\n") clean[k] = mask[k] = " ";
    }
  };
  const hide = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (!/[\w\s]/.test(sql[k]!)) mask[k] = "_";
  };

  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      const j = sql.indexOf("\n", i) < 0 ? n : sql.indexOf("\n", i);
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      // Postgres block comments nest: `/* a /* b */ still a comment */`.
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          j += 2;
          if (--depth === 0) break;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]!) && (i < 2 || !/\w/.test(sql[i - 2]!));
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      hide(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      const j = e < 0 ? n : e;
      hide(i + 1, j);
      i = j + 1;
    } else if (c === "$" && !(i > 0 && /\w/.test(sql[i - 1]!))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      if (!tag) {
        i++;
        continue;
      }
      const e = sql.indexOf(tag, i + tag.length);
      const j = e < 0 ? n : e;
      hide(i + tag.length, j);
      i = j + tag.length;
    } else {
      i++;
    }
  }
  return { clean: clean.join(""), mask: mask.join("") };
}

/** Index of the `)` matching the `(` at `open`, in masked text. */
function closeParen(mask: string, open: number): number {
  let depth = 0;
  for (let k = open; k < mask.length; k++) {
    if (mask[k] === "(") depth++;
    else if (mask[k] === ")" && --depth === 0) return k;
  }
  return mask.length;
}

/** [start, end) ranges of `mask` split on `sep` at paren depth 0. */
function splitTopLevel(mask: string, sep: string, from = 0, to = mask.length): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    if (mask[k] === "(") depth++;
    else if (mask[k] === ")") depth--;
    else if (mask[k] === sep && depth === 0) {
      out.push([start, k]);
      start = k + 1;
    }
  }
  out.push([start, to]);
  return out;
}

// ---------------------------------------------------------------------------
// Replaying the migrations
// ---------------------------------------------------------------------------

interface LiveObject {
  /** `function:name(argtypes)` or `view:name` — overload-exact. */
  id: string;
  /** `function:name` or `view:name` — what the allowlists key by. */
  label: string;
  file: string;
  body: string;
}

interface Unsupported {
  file: string;
  what: string;
}

const QNAME = String.raw`((?:"[^"]*"|\w+)(?:\s*\.\s*(?:"[^"]*"|\w+))?)`;
const unquote = (q: string) => q.split(".").pop()!.trim().replace(/"/g, "").toLowerCase();
const isPublic = (q: string) => !q.includes(".") || /^\s*"?public"?\s*\./i.test(q);

const TYPE_ALIASES: Record<string, string> = {
  int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean",
  varchar: "character varying", decimal: "numeric", float8: "double precision", float4: "real",
  timestamptz: "timestamp with time zone", timestamp: "timestamp without time zone",
  timetz: "time with time zone", time: "time without time zone",
};
const MULTIWORD_TYPE =
  /^(double precision|character varying|bit varying|(?:timestamp|time)\s+with(?:out)?\s+time\s+zone)\b/;

/**
 * A signature's argument TYPES, normalised the way Postgres identifies an
 * overload: argument names, defaults and OUT arguments dropped, typmods
 * (`numeric(14,2)`) ignored, common aliases (`int`, `timestamptz`) folded.
 * So `f(p_day date default null)` and `drop function f(date)` name the same
 * function, and `f(date)` / `f(uuid)` stay two.
 */
function signature(argsClean: string, argsMask: string): string {
  if (!argsMask.trim()) return "";
  return splitTopLevel(argsMask, ",")
    .map(([a, b]) => {
      let t = argsClean.slice(a, b).toLowerCase().replace(/\s+/g, " ").trim();
      t = t.replace(/\s+(?:default\b|=)[\s\S]*$/, "").trim();
      const mode = /^(in|out|inout|variadic)\s+/.exec(t);
      if (mode) t = t.slice(mode[0].length);
      if (mode?.[1] === "out") return null;
      if (!MULTIWORD_TYPE.test(t) && /^\S+\s+\S/.test(t)) t = t.replace(/^\S+\s+/, "");
      t = t.replace(/"/g, "").replace(/^public\./, "").replace(/\(\s*\d+\s*(?:,\s*\d+\s*)?\)/g, "").trim();
      const array = /\[\]$/.test(t) ? "[]" : "";
      const base = t.replace(/\s*\[\]$/, "").trim();
      return (TYPE_ALIASES[base] ?? base) + array;
    })
    .filter((t): t is string => t !== null)
    .join(",");
}

function replay(files: { file: string; sql: string }[]): {
  live: Map<string, LiveObject>;
  /** `comment on function` text by function id. A replace keeps it; a drop loses it. */
  comments: Map<string, string>;
  unsupported: Unsupported[];
} {
  const live = new Map<string, LiveObject>();
  const comments = new Map<string, string>();
  const unsupported: Unsupported[] = [];

  /** Live function ids named by `name` — one overload, or all when no signature is given. */
  const functionIds = (name: string, sig: string | null) =>
    [...live.keys()].filter(
      (id) => id === `function:${name}(${sig})` || (sig === null && id.startsWith(`function:${name}(`)),
    );

  for (const { file, sql } of files) {
    const { clean, mask } = lex(sql);
    for (const [s, e] of splitTopLevel(mask, ";")) {
      const st = clean.slice(s, e);
      const sm = mask.slice(s, e);
      const head = sm.replace(/^\s+/, "");
      const off = sm.length - head.length;

      // create [or replace] function|procedure
      const fn = new RegExp(
        String.raw`^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${QNAME}\s*\(`,
        "i",
      ).exec(head);
      if (fn) {
        if (!isPublic(fn[1]!)) continue;
        const name = unquote(fn[1]!);
        const open = off + fn[0].length - 1;
        const close = closeParen(sm, open);
        const tail = sm.slice(close + 1);
        const as = /\bas\s*(\$(?:[A-Za-z_]\w*)?\$|')/i.exec(tail);
        let body: string | null = null;
        if (as) {
          const at = close + 1 + as.index + as[0].length - as[1]!.length;
          if (as[1] === "'") {
            let j = at + 1;
            let text = "";
            while (j < st.length) {
              if (st[j] === "'" && st[j + 1] === "'") {
                text += "'";
                j += 2;
              } else if (st[j] === "'") break;
              else text += st[j++];
            }
            body = text;
          } else {
            const tag = as[1]!;
            const end = st.indexOf(tag, at + tag.length);
            body = st.slice(at + tag.length, end < 0 ? st.length : end);
          }
        }
        if (body === null) {
          unsupported.push({ file, what: `function ${name}: no readable body (begin atomic?)` });
          continue;
        }
        const id = `function:${name}(${signature(st.slice(open + 1, close), sm.slice(open + 1, close))})`;
        live.set(id, { id, label: `function:${name}`, file, body });
        continue;
      }

      // create [or replace] [materialized] view
      const view = new RegExp(
        String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|recursive)\s+)*(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${QNAME}`,
        "i",
      ).exec(head);
      if (view) {
        if (!isPublic(view[1]!)) continue;
        const name = unquote(view[1]!);
        live.set(`view:${name}`, { id: `view:${name}`, label: `view:${name}`, file, body: st });
        continue;
      }

      // drop function|procedure|view|materialized view  a[(args)], b[(args)] …
      const drop = /^drop\s+(function|procedure|view|materialized\s+view)\s+(?:if\s+exists\s+)?/i.exec(head);
      if (drop) {
        const isFn = /function|procedure/i.test(drop[1]!);
        const from = s + off + drop[0].length;
        for (const [a, b] of splitTopLevel(mask, ",", from, e)) {
          const item = new RegExp(String.raw`^\s*${QNAME}\s*(\()?`).exec(mask.slice(a, b));
          if (!item || !isPublic(item[1]!)) continue;
          const name = unquote(item[1]!);
          if (!isFn) {
            live.delete(`view:${name}`);
            continue;
          }
          const open = item[2] ? a + item[0].length - 1 : -1;
          const sig = open < 0 ? null : signature(clean.slice(open + 1, closeParen(mask, open)), mask.slice(open + 1, closeParen(mask, open)));
          for (const id of functionIds(name, sig)) {
            live.delete(id);
            comments.delete(id);
          }
        }
        continue;
      }

      // alter function|procedure|view … rename to / set schema
      const alter = new RegExp(
        String.raw`^alter\s+(function|procedure|view|materialized\s+view)\s+(?:if\s+exists\s+)?${QNAME}\s*`,
        "i",
      ).exec(head);
      if (alter && isPublic(alter[2]!)) {
        const isFn = /function|procedure/i.test(alter[1]!);
        const name = unquote(alter[2]!);
        let rest = off + alter[0].length;
        let sig: string | null = null;
        if (sm[rest] === "(") {
          const close = closeParen(sm, rest);
          sig = signature(st.slice(rest + 1, close), sm.slice(rest + 1, close));
          rest = close + 1;
        }
        const action = sm.slice(rest);
        const rename = /^\s*rename\s+to\s+"?(\w+)"?/i.exec(action);
        const moved = /^\s*set\s+schema\s+"?(\w+)"?/i.exec(action);
        if (!rename && !(moved && moved[1]!.toLowerCase() !== "public")) continue;
        const matches = (isFn ? functionIds(name, sig) : [`view:${name}`])
          .map((id) => live.get(id))
          .filter((o): o is LiveObject => !!o);
        for (const o of matches) {
          live.delete(o.id);
          const comment = comments.get(o.id);
          comments.delete(o.id);
          if (!rename) continue;
          const to = rename[1]!.toLowerCase();
          const kind = isFn ? "function" : "view";
          const id = isFn ? `function:${to}(${o.id.slice(o.id.indexOf("(") + 1, -1)})` : `view:${to}`;
          live.set(id, { ...o, id, label: `${kind}:${to}` });
          if (comment !== undefined) comments.set(id, comment);
        }
        continue;
      }

      // comment on function|procedure name[(args)] is '…' ['…' …] | null
      const note = new RegExp(String.raw`^comment\s+on\s+(?:function|procedure)\s+${QNAME}\s*`, "i").exec(head);
      if (note) {
        if (!isPublic(note[1]!)) continue;
        const name = unquote(note[1]!);
        let rest = off + note[0].length;
        let sig: string | null = null;
        if (sm[rest] === "(") {
          const close = closeParen(sm, rest);
          sig = signature(st.slice(rest + 1, close), sm.slice(rest + 1, close));
          rest = close + 1;
        }
        const is = /^\s*is\s+/i.exec(sm.slice(rest));
        let j = rest + (is ? is[0].length : 0);
        let text: string | null = null;
        if (is && /^null\b/i.test(st.slice(j))) text = "";
        // Adjacent literals separated by whitespace are one string in Postgres.
        while (is && st[j] === "'") {
          let k = j + 1;
          let part = "";
          while (k < st.length) {
            if (st[k] === "'" && st[k + 1] === "'") {
              part += "'";
              k += 2;
            } else if (st[k] === "'") break;
            else part += st[k++];
          }
          text = (text ?? "") + part;
          j = k + 1;
          while (/\s/.test(st[j] ?? "")) j++;
        }
        if (text === null) {
          unsupported.push({ file, what: `comment on function ${name}: unreadable text` });
          continue;
        }
        for (const id of functionIds(name, sig)) {
          if (text) comments.set(id, text);
          else comments.delete(id);
        }
        continue;
      }

      // A `do` block can create objects the replay cannot follow.
      if (/^do\b/i.test(head) && /\bjournal_(entries|lines)\b/i.test(st) &&
          /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure|(?:materialized\s+)?view)\b/i.test(st)) {
        unsupported.push({ file, what: "a do-block that creates a journal-reading function or view" });
      }
    }
  }
  return { live, comments, unsupported };
}

// ---------------------------------------------------------------------------
// Query units and the two rules
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(
  ("where join on left right inner outer full cross natural lateral using group order limit offset " +
    "union intersect except having window returning set into loop then and or as from select with " +
    "values for when else end is not null in do update insert delete fetch").split(" "),
);

interface Unit {
  start: number;
  end: number;
  parent: Unit | null;
  children: Unit[];
  /** The CTE name this unit defines, if it is `name as ( … )`. */
  cte?: string;
  /** The alias after `) x`, if this unit is a derived table. */
  alias?: string;
}

interface Analysed {
  clean: string;
  mask: string;
  units: Unit[];
}

function analyse(body: string): Analysed {
  const { clean, mask } = lex(body);
  const units: Unit[] = [];

  // Top-level statements are root units; parenthesised select/with are children.
  const roots = splitTopLevel(mask, ";").map(([a, b]) => ({ start: a, end: b, parent: null, children: [] }) as Unit);
  units.push(...roots);
  const stack: number[] = [];
  const groups: [number, number][] = [];
  for (let k = 0; k < mask.length; k++) {
    if (mask[k] === "(") stack.push(k);
    else if (mask[k] === ")" && stack.length) groups.push([stack.pop()!, k]);
  }
  groups.sort((a, b) => a[0] - b[0]);
  for (const [open, close] of groups) {
    if (!/^\s*(select|with|values)\b/i.test(mask.slice(open + 1, close))) continue;
    const unit: Unit = { start: open + 1, end: close, parent: null, children: [] };
    const before = mask.slice(0, open);
    unit.cte = /(\w+)\s*(?:\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?$/i.exec(before)?.[1]?.toLowerCase();
    const after = /^\s*(?:as\s+)?(\w+)/i.exec(mask.slice(close + 1))?.[1]?.toLowerCase();
    if (after && !KEYWORDS.has(after)) unit.alias = after;
    // Parent: the innermost unit that contains it.
    unit.parent =
      units.filter((u) => u.start <= open && close <= u.end).sort((a, b) => b.start - a.start)[0] ?? null;
    unit.parent?.children.push(unit);
    units.push(unit);
  }
  return { clean, mask, units };
}

/** A unit's own text: its range with child units blanked out. */
function own(a: Analysed, u: Unit, which: "clean" | "mask" = "clean"): string {
  const text = a[which].slice(u.start, u.end).split("");
  for (const c of u.children) for (let k = c.start; k < c.end; k++) text[k - u.start] = " ";
  return text.join("");
}

/** `from|join|update` sources in a unit's own text: alias → source name. */
function sources(a: Analysed, u: Unit): Map<string, string> {
  return sourcesOf(own(a, u, "mask"), u.children);
}

const ancestors = (u: Unit): Unit[] => (u.parent ? [u.parent, ...ancestors(u.parent)] : []);
const rootOf = (u: Unit): Unit => (u.parent ? rootOf(u.parent) : u);

/**
 * Does this text filter status to EXACTLY {posted, reversed}? Read as a set,
 * so `in ('posted', 'posted')` — posted-only in disguise — does not count,
 * and neither does a list that also admits drafts.
 */
function countsBoth(text: string): boolean {
  const lists = [
    ...text.matchAll(/\bstatus(?:\s*::\s*\w+)?\s+in\s*\(([^()]*)\)/gi),
    ...text.matchAll(/\bstatus(?:\s*::\s*\w+)?\s*=\s*any\s*\(\s*(?:array\s*)?\[([^\]]*)\]/gi),
  ];
  return lists.some((m) => {
    const values = new Set([...m[1]!.matchAll(/'(\w+)'/g)].map((v) => v[1]!.toLowerCase()));
    return values.size === 2 && values.has("posted") && values.has("reversed");
  });
}

const q = String.raw`\b(?:(\w+)\.)?`;
const cast = String.raw`(?:\s*::\s*\w+)?`;
const POSTED_ONLY = [
  new RegExp(String.raw`${q}status${cast}\s*=\s*'posted'`, "gi"),
  new RegExp(String.raw`'posted'${cast}\s*=\s*${q}status\b`, "gi"),
  new RegExp(String.raw`${q}status${cast}\s*(?:<>|!=)\s*'reversed'`, "gi"),
  new RegExp(String.raw`${q}status${cast}\s+is\s+distinct\s+from\s+'reversed'`, "gi"),
];

/**
 * List predicates, judged by their VALUE SET: `in (…)` / `= any(array[…])`
 * admitting only 'posted', or `not in (…)` / `<> all(array[…])` excluding
 * only 'reversed' — so `in ('posted', 'posted')` is posted-only too.
 */
const STATUS_LISTS = new RegExp(
  String.raw`${q}status${cast}\s+(not\s+)?in\s*\(([^()]*)\)|${q}status${cast}\s*(=\s*any|<>\s*all)\s*\(\s*(?:array\s*)?\[([^\]]*)\]`,
  "gi",
);

function isPostedOnlyList(m: RegExpMatchArray): boolean {
  const negated = !!m[2] || /all/i.test(m[5] ?? "");
  const values = new Set([...(m[3] ?? m[6] ?? "").matchAll(/'(\w+)'/g)].map((v) => v[1]!.toLowerCase()));
  const only = (v: string) => values.size === 1 && values.has(v);
  return negated ? only("reversed") : only("posted");
}

/** Is the text ending here inside an UPDATE's SET list? */
function inSetClause(before: string): boolean {
  const lastOf = (re: RegExp) => Math.max(-1, ...[...before.matchAll(re)].map((m) => m.index));
  return lastOf(/\bset\b/gi) > lastOf(/\b(where|from|join|on|select|returning|having|when|if|and|or|then)\b/gi);
}

/** One arm of a set operation (`union`, `intersect`, `except`) in a unit's own text. */
interface Branch {
  unit: Unit;
  text: string;
  mask: string;
  /** The unit's child units that sit inside this branch. */
  children: Unit[];
}

/** A unit's own text split on top-level set operators — each arm is judged alone. */
function branches(a: Analysed, u: Unit): Branch[] {
  const text = own(a, u);
  const mask = own(a, u, "mask");
  const cuts: [number, number][] = [];
  let depth = 0;
  let start = 0;
  const setOp = /(?:union(?:\s+all|\s+distinct)?|intersect|except)\b/iy;
  for (let k = 0; k < mask.length; k++) {
    if (mask[k] === "(") depth++;
    else if (mask[k] === ")") depth--;
    else if (depth === 0 && (k === 0 || !/\w/.test(mask[k - 1]!))) {
      setOp.lastIndex = k;
      const m = setOp.exec(mask);
      if (m) {
        cuts.push([start, k]);
        start = k + m[0].length;
        k = start - 1;
      }
    }
  }
  cuts.push([start, mask.length]);
  return cuts.map(([from, to]) => ({
    unit: u,
    text: text.slice(from, to),
    mask: mask.slice(from, to),
    children: u.children.filter((c) => c.start >= u.start + from && c.start < u.start + to),
  }));
}

/** `from|join|update` sources in masked text: alias → source name, plus derived aliases. */
function sourcesOf(mask: string, children: Unit[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of mask.matchAll(
    /\b(?:from|join|update)\s+(?:only\s+)?(?:(?:public|"public")\s*\.\s*)?"?(\w+)"?(?:\s+(?:as\s+)?(\w+))?/gi,
  )) {
    const name = m[1]!.toLowerCase();
    if (KEYWORDS.has(name)) continue;
    out.set(name, name);
    const alias = m[2]?.toLowerCase();
    if (alias && !KEYWORDS.has(alias)) out.set(alias, name);
  }
  for (const c of children) if (c.alias) out.set(c.alias, `(derived:${c.start})`);
  return out;
}

/** Blank `text` over [a, b]. */
const blankRange = (text: string[], a: number, b: number) => {
  for (let k = a; k <= b && k < text.length; k++) text[k] = " ";
};

/** Every `case … end` expression in masked text, as [start, end] ranges (outermost). */
function caseRanges(mask: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\b(case|end)\b/gi;
  let depth = 0;
  let start = -1;
  for (const m of mask.matchAll(re)) {
    if (m[1]!.toLowerCase() === "case") {
      if (depth++ === 0) start = m.index;
    } else if (depth > 0 && --depth === 0) {
      out.push([start, m.index + m[0].length - 1]);
    }
  }
  return out;
}

/**
 * The part of a branch that filters ROWS: from its first top-level `from`
 * on (so WHERE, JOIN … ON, HAVING), with every `filter (where …)` clause and
 * `case … end` expression blanked. A status test inside one aggregate's
 * FILTER or CASE constrains that aggregate only — never its siblings.
 */
function rowFilterText(b: Branch): string {
  const text = b.text.split("");
  let depth = 0;
  let from = b.mask.length;
  for (let k = 0; k < b.mask.length; k++) {
    if (b.mask[k] === "(") depth++;
    else if (b.mask[k] === ")") depth--;
    else if (depth === 0 && /^from\b/i.test(b.mask.slice(k, k + 5)) && (k === 0 || !/\w/.test(b.mask[k - 1]!))) {
      from = k;
      break;
    }
  }
  blankRange(text, 0, from - 1);
  for (const m of b.mask.matchAll(/\bfilter\s*\(/gi)) {
    blankRange(text, m.index, closeParen(b.mask, m.index + m[0].length - 1));
  }
  for (const [a, e] of caseRanges(b.mask)) blankRange(text, a, e);
  return text.join("");
}

/** How many `sum(…)` in the branch are not protected by their OWN status condition. */
function sumsWithoutOwnFilter(b: Branch): number {
  let loose = 0;
  for (const m of b.mask.matchAll(/\bsum\s*\(/gi)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(b.mask, open);
    // sum(case when je.status in ('posted', 'reversed') then … end)
    if (countsBoth(b.text.slice(open, close + 1))) continue;
    // sum(…) filter (where je.status in ('posted', 'reversed'))
    const filter = /^\s*filter\s*\(/i.exec(b.mask.slice(close + 1));
    if (filter) {
      const fOpen = close + 1 + filter[0].length - 1;
      if (countsBoth(b.text.slice(fOpen, closeParen(b.mask, fOpen) + 1))) continue;
    }
    loose++;
  }
  return loose;
}

/** Does the branch sum at all? */
const sums = (b: Branch) => /\bsum\s*\(/i.test(b.mask);

class Journal {
  /** Views that read journal data, directly or through another such view. */
  readonly views = new Set<string>();

  constructor(private readonly objects: Map<string, LiveObject>) {
    const viewBodies = [...objects.values()].filter((o) => o.id.startsWith("view:"));
    for (let changed = true; changed; ) {
      changed = false;
      for (const v of viewBodies) {
        const name = v.id.slice("view:".length);
        if (!this.views.has(name) && this.readsJournal(v.body)) {
          this.views.add(name);
          changed = true;
        }
      }
    }
  }

  readsJournal(body: string): boolean {
    if (/\bjournal_(entries|lines)\b/i.test(body)) return true;
    return [...this.views].some((v) => new RegExp(String.raw`\b${v}\b`, "i").test(body));
  }

  isJournalName = (name: string) =>
    name === "journal_entries" || name === "journal_lines" || this.views.has(name);

  /** CTE units visible from `u` (defined anywhere in its root statement). */
  /**
   * CTEs visible from `u`, by lexical scope: those defined by `u` itself or
   * by an enclosing unit, innermost first — so a CTE nested inside a sibling
   * cannot shadow the outer one of the same name.
   */
  private ctes(_a: Analysed, u: Unit): Map<string, Unit> {
    const out = new Map<string, Unit>();
    for (const scope of [u, ...ancestors(u)]) {
      for (const c of scope.children) if (c.cte && !out.has(c.cte)) out.set(c.cte, c);
    }
    return out;
  }

  /** Does this unit (with its subqueries and the CTEs it names) read journal data? */
  unitReadsJournal(a: Analysed, u: Unit, seen = new Set<Unit>()): boolean {
    if (seen.has(u)) return false;
    seen.add(u);
    const ctes = this.ctes(a, u);
    for (const name of sources(a, u).values()) {
      if (this.isJournalName(name)) return true;
      const cte = ctes.get(name);
      if (cte && cte !== u && this.unitReadsJournal(a, cte, seen)) return true;
    }
    return u.children.some((c) => this.unitReadsJournal(a, c, seen));
  }

  /** Posted-only journal predicates in an object. */
  postedOnlyReads(o: LiveObject): string[] {
    if (!this.readsJournal(o.body)) return [];
    const a = analyse(o.body);
    const found: string[] = [];
    for (const u of a.units) {
      const text = own(a, u);
      const matches = [
        ...POSTED_ONLY.flatMap((re) => [...text.matchAll(re)].map((m) => ({ m, qualifier: m[1] }))),
        ...[...text.matchAll(STATUS_LISTS)]
          .filter(isPostedOnlyList)
          .map((m) => ({ m, qualifier: m[1] ?? m[4] })),
      ];
      for (const { m, qualifier: raw } of matches) {
        const qualifier = raw?.toLowerCase();
        if (qualifier === "new" || qualifier === "old") continue;
        if (inSetClause(text.slice(0, m.index))) continue;
        if (!this.predicateIsJournal(a, u, qualifier)) continue;
        found.push(m[0].replace(/\s+/g, " "));
      }
    }
    return found;
  }

  private predicateIsJournal(a: Analysed, u: Unit, qualifier: string | undefined): boolean {
    const ctes = this.ctes(a, u);
    const isJournalSource = (name: string) => {
      if (this.isJournalName(name)) return true;
      if (name.startsWith("(derived:")) {
        const child = a.units.find((c) => `(derived:${c.start})` === name);
        return !child || this.unitReadsJournal(a, child);
      }
      const cte = ctes.get(name);
      return cte ? this.unitReadsJournal(a, cte) : false;
    };
    if (!qualifier) {
      // Unqualified: journal unless every source of this unit is proven non-journal.
      const names = [...sources(a, u).values()];
      return names.length === 0 ? this.unitReadsJournal(a, rootOf(u)) : names.some(isJournalSource);
    }
    for (const scope of [u, ...ancestors(u)]) {
      const source = sources(a, scope).get(qualifier);
      if (source !== undefined) return isJournalSource(source);
    }
    return true; // a record variable, a parameter, anything unresolved
  }

  /** Branches that sum journal data without counting posted + reversed. */
  uncountedSums(o: LiveObject): string[] {
    if (!this.readsJournal(o.body)) return [];
    const a = analyse(o.body);
    const out: string[] = [];
    for (const u of a.units) {
      for (const b of branches(a, u)) {
        const loose = sumsWithoutOwnFilter(b);
        if (loose === 0 || countsBoth(rowFilterText(b))) continue;
        const sourcesRead = this.branchSources(a, b, new Set());
        if (sourcesRead.length === 0 || sourcesRead.every((src) => src)) continue;
        out.push(b.text.replace(/\s+/g, " ").trim().slice(0, 120));
      }
    }
    return out;
  }

  /** Does every journal source this unit reads count both statuses? One entry per source. */
  private unitSources(a: Analysed, u: Unit, seen: Set<Unit>): boolean[] {
    if (seen.has(u)) return [];
    seen.add(u);
    // A branch whose every sum is protected by its own condition exports
    // subtotals that already count both statuses — summing them again is fine.
    return branches(a, u).flatMap((b) =>
      sums(b) && sumsWithoutOwnFilter(b) === 0 ? [true] : this.branchSources(a, b, seen),
    );
  }

  /**
   * One boolean per journal source a branch reads: does it count posted +
   * reversed — in its own filter, or in this branch's (outside any
   * `filter (where …)` clause, which constrains only its own aggregate)?
   */
  private branchSources(a: Analysed, b: Branch, seen: Set<Unit>): boolean[] {
    const pair = countsBoth(rowFilterText(b));
    const ctes = this.ctes(a, b.unit);
    const out: boolean[] = [];
    for (const name of new Set(sourcesOf(b.mask, []).values())) {
      if (name === "journal_entries" || name === "journal_lines") out.push(pair);
      else if (this.views.has(name)) out.push(pair || this.viewCountsBoth(name));
      else {
        const cte = ctes.get(name);
        if (cte && cte !== b.unit) out.push(...this.unitSources(a, cte, seen).map((x) => x || pair));
      }
    }
    for (const c of b.children) out.push(...this.unitSources(a, c, seen).map((x) => x || pair));
    return out;
  }

  private readonly viewVerdicts = new Map<string, boolean>();

  /** Does a journal view count both statuses for every journal source it reads? */
  private viewCountsBoth(name: string): boolean {
    const known = this.viewVerdicts.get(name);
    if (known !== undefined) return known;
    this.viewVerdicts.set(name, false); // cycle guard
    const view = this.objects.get(`view:${name}`);
    let verdict = false;
    if (view) {
      const a = analyse(view.body);
      verdict = a.units
        .filter((u) => !u.parent)
        .every((u) => this.unitSources(a, u, new Set()).every((x) => x));
    }
    this.viewVerdicts.set(name, verdict);
    return verdict;
  }
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));

const { live, comments, unsupported } = replay(migrations);
const journal = new Journal(live);
const journalObjects = [...live.values()].filter((o) => journal.readsJournal(o.body));

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("SQL ledger totals count posted + reversed", () => {
  it("reads every definition in the migrations", () => {
    expect(unsupported, "Extend the replay rather than let an object vanish from the guard.").toEqual([]);
  });

  it("finds every journal-reading object seen on prod (guard against a bad replay)", () => {
    const labels = new Set(journalObjects.map((o) => o.label));
    expect(
      SEEN_ON_PROD.filter((l) => !labels.has(l)),
      "Missing from the replay — or dropped by a migration, in which case remove it from SEEN_ON_PROD.",
    ).toEqual([]);
  });

  it("has no overloaded journal function (the allowlists key by name)", () => {
    const byLabel = new Map<string, string[]>();
    for (const o of journalObjects) byLabel.set(o.label, [...(byLabel.get(o.label) ?? []), o.id]);
    expect([...byLabel.values()].filter((ids) => ids.length > 1)).toEqual([]);
  });

  it("allows a posted-only journal read only in a named SQL_LOOKUP", () => {
    const offenders = journalObjects
      .filter((o) => journal.postedOnlyReads(o).length > 0 && !(o.label in SQL_LOOKUPS))
      .map((o) => `${o.label} (latest: ${o.file}): ${journal.postedOnlyReads(o).join(" | ")}`);
    expect(
      offenders,
      "A report or total must filter status in ('posted', 'reversed') — a posted-only filter keeps " +
        "each reversal mirror and drops its original. If this finds the live entry, add it to SQL_LOOKUPS.",
    ).toEqual([]);
  });

  it("makes every journal sum count posted + reversed", () => {
    const offenders = journalObjects
      .filter((o) => !(o.label in SQL_AGGREGATE_EXEMPT))
      .flatMap((o) => journal.uncountedSums(o).map((u) => `${o.label} (latest: ${o.file}): ${u}`));
    expect(offenders).toEqual([]);
  });

  it("gives every allowlist entry a stated reason", () => {
    const blank = Object.entries({ ...SQL_LOOKUPS, ...SQL_AGGREGATE_EXEMPT })
      .filter(([, why]) => why.trim().length < 20)
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  it("gives every SQL_LOOKUPS function a database comment saying why it is posted-only", () => {
    const byLabel = new Map(journalObjects.map((o) => [o.label, o]));
    const missing = Object.keys(SQL_LOOKUPS).filter((k) => {
      const o = byLabel.get(k);
      const text = o ? comments.get(o.id) : undefined;
      return !text || !/posted-only/i.test(text) || !text.includes("SQL_LOOKUPS");
    });
    expect(
      missing,
      "Add `comment on function public.<name>(<arg types>) is 'Posted-only … on purpose: <why>. … Listed in " +
        "SQL_LOOKUPS (src/lib/accounting/ledger-status-sql.test.ts).'` in a migration (0180 is the model). " +
        "A `drop function` loses the comment, so a drop-and-recreate must restate it.",
    ).toEqual([]);
  });

  it("has no stale SQL_LOOKUPS or SQL_AGGREGATE_EXEMPT entries", () => {
    const byLabel = new Map(journalObjects.map((o) => [o.label, o]));
    const staleLookups = Object.keys(SQL_LOOKUPS).filter((k) => {
      const o = byLabel.get(k);
      return !o || journal.postedOnlyReads(o).length === 0;
    });
    const staleExempt = Object.keys(SQL_AGGREGATE_EXEMPT).filter((k) => {
      const o = byLabel.get(k);
      return !o || journal.uncountedSums(o).length === 0;
    });
    expect([...staleLookups, ...staleExempt]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The replay and the rules, on real SQL
// ---------------------------------------------------------------------------

function probe(...sqls: string[]) {
  const result = replay(sqls.map((sql, i) => ({ file: `${String(i).padStart(4, "0")}_probe.sql`, sql })));
  const j = new Journal(result.live);
  const objects = [...result.live.values()];
  return {
    ...result,
    objects,
    ids: objects.map((o) => o.id),
    posted: (id: string) => j.postedOnlyReads(result.live.get(id)!),
    sums: (id: string) => j.uncountedSums(result.live.get(id)!),
  };
}

const TOTAL = "select sum(jl.debit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id";

describe("the SQL replay", () => {
  it("tracks function comments: kept by a replace, carried by a rename, lost by a drop", () => {
    const fn = (body: string) =>
      `create or replace function public.f(a uuid) returns int language sql as $$ ${body} $$;`;
    const why = "comment on function public.f(uuid) is 'why';";

    const kept = probe(fn("select 1"), "comment on function public.f(uuid) is 'one '\n  'two''s';", fn("select 2"));
    expect(kept.comments.get("function:f(uuid)")).toBe("one two's");

    const moved = probe(fn("select 1"), why, "alter function public.f(uuid) rename to g;");
    expect([...moved.comments]).toEqual([["function:g(uuid)", "why"]]);

    const lost = probe(fn("select 1"), why, "drop function public.f(uuid);", fn("select 1"));
    expect(lost.comments.size).toBe(0);

    const cleared = probe(fn("select 1"), "comment on function public.f is 'why';", "comment on function f(uuid) is null;");
    expect(cleared.comments.size).toBe(0);

    const overload = probe(
      fn("select 1"),
      "create function public.f() returns int language sql as $$ select 1 $$;",
      "comment on function public.f() is 'why';",
    );
    expect([...overload.comments.keys()]).toEqual(["function:f()"]);
  });

  it("fails loudly on a function comment it cannot read", () => {
    const p = probe(
      "create function public.f() returns int language sql as $$ select 1 $$;",
      "comment on function public.f() is E'why';",
    );
    expect(p.unsupported).toHaveLength(1);
  });

  it("keeps the latest definition, so a fixed view is judged by its fix", () => {
    const p = probe(
      `create view public.v_x as ${TOTAL} where je.status = 'posted';`,
      `create or replace view public.v_x with (security_invoker = on) as ${TOTAL} where je.status in ('posted', 'reversed');`,
    );
    expect(p.posted("view:v_x")).toEqual([]);
    expect(p.sums("view:v_x")).toEqual([]);
  });

  it("catches a redefinition that puts the posted-only filter back", () => {
    const p = probe(
      `create view public.v_x as ${TOTAL} where je.status in ('posted', 'reversed');`,
      `create or replace view public.v_x as ${TOTAL} where je.status = 'posted';`,
    );
    expect(p.posted("view:v_x")).toHaveLength(1);
    expect(p.sums("view:v_x")).toHaveLength(1);
  });

  it("does not let a ';' or '--' inside a string literal cut a view short", () => {
    const p = probe(
      `create view public.v_x as select string_agg(c.code, '; '), '--' as dash, sum(jl.debit_php)
       from journal_lines jl join journal_entries je on je.id = jl.entry_id join chart_of_accounts c on c.id = jl.account_id
       where je.status = 'posted';`,
    );
    expect(p.posted("view:v_x")).toHaveLength(1);
  });

  it("reads quoted names, a single-quoted body, and a procedure", () => {
    const p = probe(
      `create function "public"."f"() returns numeric language sql as $$ ${TOTAL} where je.status = 'posted' $$;`,
      `create function public.g() returns numeric language sql as '${TOTAL} where je.status = ''posted''';`,
      "create procedure public.h() language plpgsql as $p$ begin perform 1 from journal_entries where status = 'posted'; end $p$;",
    );
    expect(p.ids.sort()).toEqual(["function:f()", "function:g()", "function:h()"]);
    expect(p.posted("function:g()")).toHaveLength(1);
  });

  it("takes the body from AS, not from a dollar-quoted argument default", () => {
    const p = probe(
      `create function public.f(p text default $d$x$d$) returns numeric language sql as $$ ${TOTAL} where je.status = 'posted' $$;`,
    );
    expect(p.posted("function:f(text)")).toHaveLength(1);
  });

  it("keeps overloads apart and drops only the one named", () => {
    const p = probe(
      `create function public.f(d date) returns numeric language sql as $$ ${TOTAL} where je.status = 'posted' $$;`,
      "create function public.f() returns int language sql as $$ select 1 $$;",
      "drop function public.f(uuid, uuid);",
      "drop function if exists public.f();",
    );
    expect(p.ids).toEqual(["function:f(date)"]);
  });

  it("forgets a dropped function, including one in a multi-name drop", () => {
    const p = probe(
      "create function public.f(a int) returns int language sql as $$ select 1 from journal_entries where status = 'posted' $$;",
      "create function public.g() returns int language sql as $fn$ select 1 $fn$;",
      "drop function if exists public.f(int), public.g() cascade;",
    );
    expect(p.ids).toEqual([]);
  });

  it("follows a rename and a move out of public", () => {
    const p = probe(
      `create function public.f() returns numeric language sql as $$ ${TOTAL} where je.status = 'posted' $$;`,
      "alter function public.f() rename to g;",
      "create function public.f() returns int language sql as $$ select 1 $$;",
      "create view public.v as select 1 from journal_entries;",
      "alter view public.v set schema archive;",
    );
    expect(p.ids.sort()).toEqual(["function:f()", "function:g()"]);
    expect(p.posted("function:g()")).toHaveLength(1);
  });

  it("fails loudly on a body it cannot read, and on a do-block that creates a journal object", () => {
    const p = probe(
      "create function public.f() returns int language sql begin atomic select 1; end;",
      "do $$ begin execute 'create or replace view public.v as select 1 from journal_entries'; end $$;",
    );
    expect(p.unsupported).toHaveLength(2);
  });

  it("does not read a comment as SQL", () => {
    const p = probe(
      "create function public.f() returns int language sql as $$\n  -- was: where je.status = 'posted'\n  select 1 from journal_entries je where je.status in ('posted','reversed')\n$$;",
    );
    expect(p.posted("function:f()")).toEqual([]);
  });
});

describe("the posted-only rule", () => {
  it("skips SET-list writes and trigger-row tests, but not a WHERE after a SET", () => {
    const p = probe(`create function public.f() returns trigger language plpgsql as $$
      begin
        if new.status = 'posted' and old.status is distinct from 'posted' then null; end if;
        update public.journal_entries set status = 'posted' where id = v_id;
        update public.journal_entries set posted_at = now(), status = 'reversed' where id = v_id;
        update public.journal_entries set notes = 'x' where status = 'posted';
      end $$;`);
    expect(p.posted("function:f()")).toEqual(["status = 'posted'"]);
  });

  it("catches every posted-only spelling", () => {
    const p = probe(`create function public.f() returns int language sql as $$
      select 1 from journal_entries je where je.status <> 'reversed'
      union all select 1 from journal_entries where status in ('posted')
      union all select 1 from journal_entries e where e.status is distinct from 'reversed'
      union all select 1 from journal_entries e where e.status::text = 'posted'
      union all select 1 from journal_entries e where 'posted' = e.status
      union all select 1 from journal_entries e where e.status = any(array['posted'])
      union all select 1 from journal_entries e where e.status not in ('reversed')
    $$;`);
    expect(p.posted("function:f()")).toHaveLength(7);
  });

  it("ignores another base table's status, but not a CTE or derived alias of the journal", () => {
    const p = probe(
      `create function public.a() returns int language sql as $$
        select 1 from bills b join journal_entries je on je.source_id = b.id
        where b.status = 'posted' and je.status in ('posted', 'reversed') $$;`,
      `create function public.b() returns numeric language sql as $$
        with e as (select id, status from journal_entries)
        select sum(jl.debit_php) from journal_lines jl join e on e.id = jl.entry_id where e.status = 'posted' $$;`,
      `create function public.c() returns numeric language sql as $$
        select sum(jl.debit_php) from journal_lines jl
        join (select id, status from journal_entries) x on x.id = jl.entry_id where x.status = 'posted' $$;`,
      `create function public.d() returns numeric language plpgsql as $$
        declare r record; t numeric := 0;
        begin for r in select je.status, jl.debit_php from journal_lines jl join journal_entries je on je.id = jl.entry_id loop
          if r.status = 'posted' then t := t + r.debit_php; end if; end loop; return t; end $$;`,
    );
    expect(p.posted("function:a()")).toEqual([]);
    expect(p.posted("function:b()")).toHaveLength(1);
    expect(p.posted("function:c()")).toHaveLength(1);
    expect(p.posted("function:d()")).toHaveLength(1);
  });

  it("follows a view built on a journal view", () => {
    const p = probe(
      "create view public.v_je as select je.status, jl.debit_php from journal_lines jl join journal_entries je on je.id = jl.entry_id;",
      "create view public.v_tot as select sum(debit_php) from v_je where status = 'posted';",
    );
    expect(p.posted("view:v_tot")).toHaveLength(1);
    expect(p.sums("view:v_tot")).toHaveLength(1);
  });
});

describe("the journal-sum rule", () => {
  it("judges each subquery by its own filter, not a sibling's", () => {
    const p = probe(`create function public.f() returns table (a numeric, b numeric) language sql as $$
      select
        (select sum(jl.debit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id
          where je.status in ('posted', 'reversed')),
        (select sum(jl.credit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id)
    $$;`);
    expect(p.sums("function:f()")).toHaveLength(1);
  });

  it("follows a sum through a CTE, and accepts the filter on either side", () => {
    const p = probe(
      `create function public.bad() returns numeric language sql as $$
        with l as (select debit_php - credit_php as amount from journal_lines)
        select sum(amount) from l $$;`,
      `create function public.inner_ok() returns numeric language sql as $$
        with l as (select jl.debit_php as amount from journal_lines jl join journal_entries je on je.id = jl.entry_id
                   where je.status in ('posted', 'reversed'))
        select sum(amount) from l $$;`,
      `create function public.outer_ok() returns numeric language sql as $$
        with l as (select je.status, jl.debit_php as amount from journal_lines jl join journal_entries je on je.id = jl.entry_id)
        select sum(amount) from l where l.status in ('posted', 'reversed') $$;`,
    );
    expect(p.sums("function:bad()")).toHaveLength(1);
    expect(p.sums("function:inner_ok()")).toEqual([]);
    expect(p.sums("function:outer_ok()")).toEqual([]);
  });

  it("does not treat a sum over another table as a journal total", () => {
    const p = probe(`create function public.f() returns numeric language sql as $$
      select sum(tr.final_price_php) from test_requests tr
      where exists (select 1 from journal_entries je where je.source_id = tr.id and je.status in ('posted', 'reversed')) $$;`);
    expect(p.sums("function:f()")).toEqual([]);
  });
});

describe("second-round review reproducers", () => {
  it("judges each arm of a UNION alone", () => {
    const p = probe(`create function public.f() returns numeric language sql as $$
      ${TOTAL} where je.status in ('posted', 'reversed')
      union all
      ${TOTAL}
    $$;`);
    expect(p.sums("function:f()")).toHaveLength(1);
  });

  it("does not let a FILTER clause on another aggregate vouch for a sum", () => {
    const p = probe(
      `create function public.bad() returns table (s numeric, n bigint) language sql as $$
        select sum(jl.debit_php), count(*) filter (where je.status in ('posted', 'reversed'))
        from journal_lines jl join journal_entries je on je.id = jl.entry_id $$;`,
      `create function public.ok() returns numeric language sql as $$
        select sum(jl.debit_php) filter (where je.status in ('posted', 'reversed'))
        from journal_lines jl join journal_entries je on je.id = jl.entry_id $$;`,
    );
    expect(p.sums("function:bad()")).toHaveLength(1);
    expect(p.sums("function:ok()")).toEqual([]);
  });

  it("resolves a CTE name by lexical scope, not from a nested sibling", () => {
    const p = probe(`create function public.f() returns numeric language sql as $$
      with e as (select je.status, jl.debit_php from journal_lines jl join journal_entries je on je.id = jl.entry_id
                 where je.status in ('posted', 'reversed')),
           n as (with e as (select status from bills) select count(*) from e)
      select sum(e.debit_php) from e where e.status = 'posted'
    $$;`);
    expect(p.posted("function:f()")).toHaveLength(1);
  });

  it("keeps same-arity overloads apart by argument type", () => {
    const p = probe(
      `create function public.f(p_day date default null) returns numeric language sql as $$ ${TOTAL} where je.status = 'posted' $$;`,
      "create function public.f(p_id uuid) returns int language sql as $$ select 1 $$;",
      "drop function if exists public.f(uuid);",
    );
    expect(p.ids).toEqual(["function:f(date)"]);
    expect(p.posted("function:f(date)")).toHaveLength(1);
  });

  it("normalises aliases, typmods and multi-word types in a signature", () => {
    const p = probe(
      "create function public.f(a int, b numeric(14,2), c timestamptz, d double precision) returns int language sql as $$ select 1 $$;",
      "drop function public.f(integer, numeric, timestamp with time zone, double precision);",
    );
    expect(p.ids).toEqual([]);
  });

  it("reads a repeated value as posted-only, not as both statuses", () => {
    const p = probe(
      `create function public.f() returns numeric language sql as $$ ${TOTAL} where je.status in ('posted', 'posted') $$;`,
    );
    expect(p.posted("function:f()")).toHaveLength(1);
    expect(p.sums("function:f()")).toHaveLength(1);
  });

  it("does not let a nested block comment hide a definition", () => {
    const p = probe(
      `/* outer /* inner */ still outer */ create view public.v_x as ${TOTAL} where je.status = 'posted';`,
    );
    expect(p.ids).toEqual(["view:v_x"]);
    expect(p.posted("view:v_x")).toHaveLength(1);
  });

  it("accepts a total built through a chain of views that count both statuses", () => {
    const p = probe(
      `create view public.v_lines as select je.status, jl.debit_php from journal_lines jl
         join journal_entries je on je.id = jl.entry_id where je.status in ('posted', 'reversed');`,
      "create view public.v_amounts as select debit_php from v_lines;",
      "create view public.v_total as select sum(debit_php) from v_amounts;",
      "create view public.v_leaky as select je.status, jl.debit_php from journal_lines jl join journal_entries je on je.id = jl.entry_id;",
      "create view public.v_leaky_total as select sum(debit_php) from v_leaky;",
    );
    expect(p.sums("view:v_total")).toEqual([]);
    expect(p.sums("view:v_leaky_total")).toHaveLength(1);
  });
});

describe("third-round review reproducers", () => {
  it("does not let a status test inside one CASE protect its sibling sums", () => {
    const p = probe(`create view public.v_pnl as
      select je.posting_date,
        sum(case when coa.type = 'revenue' and je.status in ('posted', 'reversed') then jl.credit_php else 0 end) as revenue,
        sum(case when coa.type = 'expense' then jl.debit_php else 0 end) as expense
      from journal_lines jl join journal_entries je on je.id = jl.entry_id
      join chart_of_accounts coa on coa.id = jl.account_id
      group by je.posting_date;`);
    expect(p.sums("view:v_pnl")).toHaveLength(1);
  });

  it("accepts the same report with the status test in WHERE", () => {
    const p = probe(`create view public.v_pnl as
      select je.posting_date,
        sum(case when coa.type = 'revenue' then jl.credit_php else 0 end) as revenue,
        sum(case when coa.type = 'expense' then jl.debit_php else 0 end) as expense
      from journal_lines jl join journal_entries je on je.id = jl.entry_id
      join chart_of_accounts coa on coa.id = jl.account_id
      where je.status in ('posted', 'reversed')
      group by je.posting_date;`);
    expect(p.sums("view:v_pnl")).toEqual([]);
  });

  it("accepts re-summing subtotals that were filtered at their own aggregate", () => {
    const p = probe(
      `create view public.v_daily as select je.posting_date as d,
         sum(jl.debit_php) filter (where je.status in ('posted', 'reversed')) as amount
         from journal_lines jl join journal_entries je on je.id = jl.entry_id group by 1;`,
      "create view public.v_monthly as select date_trunc('month', d) as m, sum(amount) from v_daily group by 1;",
      `create function public.f() returns numeric language sql as $$
         with daily as (select sum(jl.debit_php) filter (where je.status in ('posted', 'reversed')) as amount
                        from journal_lines jl join journal_entries je on je.id = jl.entry_id)
         select sum(amount) from daily $$;`,
    );
    expect(p.sums("view:v_monthly")).toEqual([]);
    expect(p.sums("function:f()")).toEqual([]);
  });
});
