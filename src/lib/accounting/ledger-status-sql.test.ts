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
 * This replays `supabase/migrations/` in order and keeps the LATEST
 * definition of every view and function (a later `create or replace`
 * supersedes an earlier one; a `drop` removes it) — the set that is live on
 * the database once every migration has run. Checked against prod on
 * 2026-09-25: the same 31 functions + 3 views read journal data there, with
 * no overloads.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. A live view/function that reads journal data with a posted-only
 *      predicate — `status = 'posted'`, `status in ('posted')`, or the
 *      negative spellings `status <> 'reversed'` / `!= 'reversed'` /
 *      `is distinct from 'reversed'` — is named in `SQL_LOOKUPS` with a
 *      reason. Excluded: assignments in an UPDATE's SET list (a write, not a
 *      read), and `new.status` / `old.status` (a trigger testing the row it
 *      fired on, not a filter over the ledger). A qualified predicate counts
 *      only when its qualifier is `journal_entries` or an alias of it, so a
 *      function joining `bills b` may test `b.status = 'posted'` freely.
 *   2. A live view/function that AGGREGATES journal amounts (`sum(` over
 *      `debit_php` / `credit_php`, directly or through a CTE) filters
 *      `status in ('posted', 'reversed')`, unless `SQL_AGGREGATE_EXEMPT`
 *      says why not.
 *   3. Neither allowlist has stale entries.
 *
 * NOT covered: one-off statements outside a view/function (data fixes in a
 * `do $$` block run once and are not live), and SQL built at runtime with
 * `execute format(…)`.
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
    "Finds the live payment JE to reverse when an unpaid payment row is deleted.",
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

// ---------------------------------------------------------------------------
// Replaying the migrations
// ---------------------------------------------------------------------------

interface LiveObject {
  key: string;
  file: string;
  body: string;
}

const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");

/** Live views/functions after replaying `files` (name → latest definition) in order. */
function replay(files: { file: string; sql: string }[]): Map<string, LiveObject> {
  const live = new Map<string, LiveObject>();
  for (const { file, sql: raw } of files) {
    const sql = stripComments(raw);
    const events: { pos: number; key: string; body?: string }[] = [];

    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(/gi)) {
      const rest = sql.slice(m.index);
      const quote = rest.match(/\$(\w*)\$/);
      if (!quote || quote.index === undefined) continue;
      const open = quote.index + quote[0].length;
      const close = rest.indexOf(quote[0], open);
      events.push({ pos: m.index, key: `function:${m[1]!.toLowerCase()}`, body: rest.slice(open, close) });
    }
    for (const m of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi,
    )) {
      const rest = sql.slice(m.index);
      events.push({ pos: m.index, key: `view:${m[1]!.toLowerCase()}`, body: rest.slice(0, rest.indexOf(";")) });
    }
    for (const m of sql.matchAll(/drop\s+(function|view|materialized\s+view)\s+(?:if\s+exists\s+)?([^;]+);/gi)) {
      const kind = /function/i.test(m[1]!) ? "function" : "view";
      // `drop view a, b` — split on commas outside any argument list.
      const names = m[2]!.replace(/\([^)]*\)/g, "").replace(/\b(cascade|restrict)\b/gi, "").split(",");
      for (const n of names) {
        const name = n.trim().replace(/^public\./i, "").replace(/"/g, "").toLowerCase();
        if (name) events.push({ pos: m.index, key: `${kind}:${name}` });
      }
    }

    events.sort((a, b) => a.pos - b.pos);
    for (const e of events) {
      if (e.body === undefined) live.delete(e.key);
      else live.set(e.key, { key: e.key, file, body: e.body });
    }
  }
  return live;
}

const readsJournal = (o: LiveObject) => /\bjournal_(entries|lines)\b/i.test(o.body);

/**
 * Is the text ending here inside an UPDATE's SET list? The last `set` comes
 * after the last keyword that opens a predicate or a new clause/statement.
 */
function inSetClause(before: string): boolean {
  const statement = before.slice(before.lastIndexOf(";") + 1);
  const lastOf = (re: RegExp) => Math.max(-1, ...[...statement.matchAll(re)].map((m) => m.index));
  return (
    lastOf(/\bset\b/gi) > lastOf(/\b(where|from|join|on|select|returning|having|when|if|and|or)\b/gi)
  );
}

const POSTED_ONLY =
  /\b(?:(\w+)\.)?status\s*(?:=\s*'posted'|in\s*\(\s*'posted'\s*\)|(?:<>|!=)\s*'reversed'|is\s+distinct\s+from\s+'reversed')/gi;

/** The posted-only journal predicates in a live object's body. */
function postedOnlyReads(o: LiveObject): string[] {
  const body = o.body;
  const aliases = new Set(
    [...body.matchAll(/\bjournal_entries\s+(?:as\s+)?(\w+)/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((a) => !/^(where|set|on|join|left|inner|using|values|for|returning|group|order|limit)$/.test(a)),
  );
  aliases.add("journal_entries");
  return [...body.matchAll(POSTED_ONLY)]
    .filter((m) => {
      const qualifier = m[1]?.toLowerCase();
      if (qualifier === "new" || qualifier === "old") return false;
      if (qualifier && !aliases.has(qualifier)) return false;
      return !inSetClause(body.slice(0, m.index));
    })
    .map((m) => m[0]);
}

const aggregatesJournal = (o: LiveObject) =>
  /\bjournal_lines\b/i.test(o.body) &&
  /\bsum\s*\(/i.test(o.body) &&
  // `sum(debit_php)` directly, or `sum(amount)` over a CTE that read `jl.debit_php`.
  (/\bsum\s*\([^;]*?\b(debit_php|credit_php)\b/i.test(o.body) ||
    /\b\w+\.(debit_php|credit_php)\b/i.test(o.body));

const countsBoth = (o: LiveObject) =>
  /status\s+in\s*\(\s*'posted'\s*,\s*'reversed'\s*\)|status\s+in\s*\(\s*'reversed'\s*,\s*'posted'\s*\)/i.test(
    o.body,
  );

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));

const journalObjects = [...replay(migrations).values()].filter(readsJournal);

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("SQL ledger totals count posted + reversed", () => {
  it("finds the live journal views and functions (guard against a bad replay)", () => {
    const keys = journalObjects.map((o) => o.key);
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const known of [
      "view:v_ops_daily_pnl",
      "view:v_ops_daily_expenses",
      "function:send_out_spend_by_lab",
      "function:bridge_payment_void",
    ]) {
      expect(keys).toContain(known);
    }
  });

  it("allows a posted-only journal read only in a named SQL_LOOKUP", () => {
    const offenders = journalObjects
      .filter((o) => postedOnlyReads(o).length > 0 && !(o.key in SQL_LOOKUPS))
      .map((o) => `${o.key} (latest: ${o.file}): ${postedOnlyReads(o).join(" | ")}`);
    expect(
      offenders,
      "A report or total must filter status in ('posted', 'reversed') — a posted-only filter keeps " +
        "each reversal mirror and drops its original. If this finds the live entry, add it to SQL_LOOKUPS.",
    ).toEqual([]);
  });

  it("makes every journal aggregate count posted + reversed", () => {
    const offenders = journalObjects
      .filter((o) => aggregatesJournal(o) && !countsBoth(o) && !(o.key in SQL_AGGREGATE_EXEMPT))
      .map((o) => `${o.key} (latest: ${o.file})`);
    expect(offenders).toEqual([]);
  });

  it("gives every allowlist entry a stated reason", () => {
    const blank = Object.entries({ ...SQL_LOOKUPS, ...SQL_AGGREGATE_EXEMPT })
      .filter(([, why]) => why.trim().length < 20)
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  it("has no stale SQL_LOOKUPS or SQL_AGGREGATE_EXEMPT entries", () => {
    const byKey = new Map(journalObjects.map((o) => [o.key, o]));
    const staleLookups = Object.keys(SQL_LOOKUPS).filter((k) => {
      const o = byKey.get(k);
      return !o || postedOnlyReads(o).length === 0;
    });
    const staleExempt = Object.keys(SQL_AGGREGATE_EXEMPT).filter((k) => {
      const o = byKey.get(k);
      return !o || !aggregatesJournal(o) || countsBoth(o);
    });
    expect([...staleLookups, ...staleExempt]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The replay and the predicate finder, on real SQL
// ---------------------------------------------------------------------------

const probe = (...sqls: string[]) =>
  [...replay(sqls.map((sql, i) => ({ file: `${String(i).padStart(4, "0")}_probe.sql`, sql }))).values()];

describe("the SQL replay", () => {
  it("keeps the latest definition, so a fixed view is judged by its fix", () => {
    const [v] = probe(
      "create view public.v_x as select sum(jl.debit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.status = 'posted';",
      "create or replace view public.v_x with (security_invoker = on) as select sum(jl.debit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.status in ('posted', 'reversed');",
    );
    expect(postedOnlyReads(v!)).toEqual([]);
    expect(countsBoth(v!)).toBe(true);
  });

  it("catches a redefinition that puts the posted-only filter back", () => {
    const [v] = probe(
      "create view public.v_x as select 1 from journal_entries je where je.status in ('posted', 'reversed');",
      "create or replace view public.v_x as select sum(jl.credit_php) from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.status = 'posted';",
    );
    expect(postedOnlyReads(v!)).toHaveLength(1);
    expect(aggregatesJournal(v!) && !countsBoth(v!)).toBe(true);
  });

  it("forgets a dropped function, including one in a multi-name drop", () => {
    const live = probe(
      "create function public.f(a int) returns int language sql as $$ select 1 from journal_entries where status = 'posted' $$;",
      "create function public.g() returns int language sql as $fn$ select 1 $fn$;",
      "drop function if exists public.f(int), public.g() cascade;",
    );
    expect(live).toEqual([]);
  });

  it("does not read a comment as SQL", () => {
    const [f] = probe(
      "create function public.f() returns int language sql as $$\n  -- was: where je.status = 'posted'\n  select 1 from journal_entries je where je.status in ('posted','reversed')\n$$;",
    );
    expect(postedOnlyReads(f!)).toEqual([]);
  });

  it("skips SET-list writes and trigger-row tests, but not a WHERE after a SET", () => {
    const [f] = probe(`create function public.f() returns trigger language plpgsql as $$
      begin
        if new.status = 'posted' and old.status is distinct from 'posted' then null; end if;
        update public.journal_entries set status = 'posted' where id = v_id;
        update public.journal_entries set posted_at = now(), status = 'reversed' where id = v_id;
        update public.journal_entries set notes = 'x' where status = 'posted';
      end $$;`);
    expect(postedOnlyReads(f!)).toEqual(["status = 'posted'"]);
  });

  it("flags the negative spellings and a posted-only IN list", () => {
    const [f] = probe(`create function public.f() returns int language sql as $$
      select 1 from journal_entries je where je.status <> 'reversed'
      union all select 1 from journal_entries where status in ('posted')
      union all select 1 from journal_entries e where e.status is distinct from 'reversed'
    $$;`);
    expect(postedOnlyReads(f!)).toHaveLength(3);
  });

  it("ignores another table's status in a function that also reads the journal", () => {
    const [f] = probe(`create function public.f() returns int language sql as $$
      select 1 from bills b join journal_entries je on je.source_id = b.id
      where b.status = 'posted' and je.status in ('posted', 'reversed')
    $$;`);
    expect(postedOnlyReads(f!)).toEqual([]);
  });

  it("sees an aggregate built through a CTE", () => {
    const [f] = probe(`create function public.f() returns table (x numeric) language sql as $$
      with l as (select jl.debit_php - jl.credit_php as amount from journal_lines jl
                 join journal_entries je on je.id = jl.entry_id where je.status = 'posted')
      select sum(amount) from l
    $$;`);
    expect(aggregatesJournal(f!)).toBe(true);
    expect(countsBoth(f!)).toBe(false);
  });
});
