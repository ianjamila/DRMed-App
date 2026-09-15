/**
 * Every P-code a migration can raise has a user-facing translation.
 *
 * WHY THIS EXISTS
 * ---------------
 * CLAUDE.md and the drmed-payments skill both say it: "New P-code →
 * `pg-errors.ts` translation in the same PR." A convention nobody checks is a
 * convention that decays, and the failure is quiet in the worst way — the
 * `default:` branch hands the raw Postgres message to the UI, so a guard that
 * was written to explain itself to reception instead shows them SQL prose, or
 * (for a raise with an internal message) nothing they can act on.
 *
 * It decayed already: writing this test is what found P0035 sitting
 * untranslated since migration 0059, on a path
 * (admin/result-templates/[service_id]/edit) that calls `translatePgError`.
 *
 * WHAT IT READS
 * -------------
 * The migration text, not a database — same reasoning as
 * `cash-denominations.parity.test.ts`. A raise is any `using errcode = 'P00NN'`
 * in `supabase/migrations/`.
 *
 * THE SECOND RULE: NO BARE RAISE
 * ------------------------------
 * The coverage rule above can only see a raise that HAS a code. A raise with no
 * `using errcode` at all is untranslatable BY CONSTRUCTION — `translatePgError`
 * never gets a key to match, so the `default:` branch hands the raw Postgres
 * string to the UI no matter how many cases `pg-errors.ts` grows. That is the
 * same failure the first rule exists to prevent, one level further back, and
 * nothing was checking it.
 *
 * Two kinds of raise are deliberately NOT covered:
 *
 *   - Anything inside a `do $$ … $$` block. Those run ONCE, at migration time,
 *     and are the post-condition assertions this repo requires — they abort a
 *     deploy, they never reach a user, and giving them P-codes would put
 *     migration-time failures into a registry meant for UI messages. There are
 *     42 of them.
 *   - A raise carrying a standard SQLSTATE rather than a P-code
 *     (`check_violation`, `42501`). The release gates use `check_violation`
 *     deliberately; they have a code, so they are translatable.
 *
 * THE ALLOWLIST CAN ONLY SHRINK
 * -----------------------------
 * `DEAD_CODES` is not "codes we decided not to translate" — it is codes whose
 * raise site no longer exists in the live schema, which the migration history
 * still contains because migrations are append-only. Adding an entry needs the
 * reason to be the same one: the function was dropped. A new guard that raises
 * a new code belongs in `pg-errors.ts`, not here.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations", import.meta.url),
);
const PG_ERRORS = fileURLToPath(new URL("./pg-errors.ts", import.meta.url));

/**
 * Raised only inside `reverse_petty_cash_entry`, which migration 0145 dropped
 * when the till got its single write path. Nothing in the live schema can
 * raise them, and nothing can produce a row the function would have accepted.
 */
const DEAD_CODES = new Set(["P0037", "P0038", "P0039"]);

function raisedCodes(): Map<string, string[]> {
  const byCode = new Map<string, string[]>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const m of text.matchAll(/errcode\s*=\s*'(P\d{4})'/g)) {
      const list = byCode.get(m[1]) ?? [];
      if (!list.includes(file)) list.push(file);
      byCode.set(m[1], list);
    }
  }
  return byCode;
}

/**
 * Runtime raises that predate this rule and still carry no errcode. FROZEN —
 * the list may only SHRINK. Each entry is `file :: owning function`.
 *
 * The four `ap_*` ones and `employees_require_daily_rate` ARE reachable from
 * the UI (voiding a bill, editing a draft, running payroll), so they are the
 * ones worth a P-code next. The other two are internal-consistency guards a
 * user should not be able to trip. Giving any of them a code needs a new
 * migration, which is why this freezes the set rather than changing behaviour.
 */
const BARE_RAISES = new Set([
  "0033_op_gl_bridge_polish.sql :: public.coa_uuid_for_code",
  "0040_package_decomposition.sql :: public.fn_test_request_parent_is_header",
  "0044_payroll.sql :: public.employees_require_daily_rate",
  "0049_ap_subledger_behavior.sql :: public.ap_bill_void_guard",
  "0049_ap_subledger_behavior.sql :: public.ap_reverse_je_for_source",
  "0049_ap_subledger_behavior.sql :: public.ap_update_bill_draft",
  "0049_ap_subledger_behavior.sql :: public.ap_void_bill_with_guard",
]);

/** Blank out line and block comments, preserving every character offset. */
function stripComments(text: string): string {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i) + " ".repeat(line.length - i);
    })
    .join("\n");
}

/** Character ranges of every `do $tag$ … $tag$` block. */
function doBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /\bdo\s+(\$[A-Za-z_]*\$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = text.indexOf(m[1], m.index + m[0].length);
    if (end === -1) continue;
    ranges.push([m.index, end + m[1].length]);
    re.lastIndex = end + m[1].length;
  }
  return ranges;
}

/** `file :: function` for every RUNTIME raise that carries no errcode. */
function bareRuntimeRaises(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    const blocks = doBlockRanges(text);
    for (const m of text.matchAll(/raise\s+exception\b[\s\S]*?;/gi)) {
      if (/\busing\b[\s\S]*errcode/i.test(m[0])) continue;
      if (blocks.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const fn = [
        ...text.slice(0, m.index).matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)/gi),
      ].pop();
      found.push(`${file} :: ${fn ? fn[1] : "(top level)"}`);
    }
  }
  return found;
}

function translatedCodes(): Set<string> {
  const text = readFileSync(PG_ERRORS, "utf8");
  return new Set([...text.matchAll(/case "(P\d{4})":/g)].map((m) => m[1]));
}

describe("P-code translation coverage", () => {
  const raised = raisedCodes();
  const translated = translatedCodes();

  it("every live P-code raised by a migration has a translatePgError case", () => {
    const missing = [...raised.entries()]
      .filter(([code]) => !translated.has(code) && !DEAD_CODES.has(code))
      .map(([code, files]) => `${code} (raised in ${files.join(", ")})`);

    expect(
      missing,
      "add a `case` to src/lib/accounting/pg-errors.ts for each of these",
    ).toEqual([]);
  });

  it("does not translate a code nothing raises", () => {
    // A stale case is harmless at runtime but means the guard it describes is
    // gone — which is worth knowing, because the behaviour it documented is
    // gone with it.
    const orphans = [...translated].filter((c) => !raised.has(c)).sort();
    expect(orphans).toEqual([]);
  });

  it("keeps the dead-code allowlist honest", () => {
    // Every allowlisted code must still appear in the history (otherwise the
    // entry is dead weight) and must still be absent from the translator
    // (otherwise it should just leave the list).
    for (const code of DEAD_CODES) {
      expect(raised.has(code), `${code} is allowlisted but no migration raises it`).toBe(true);
      expect(
        translated.has(code),
        `${code} is translated now — drop it from DEAD_CODES`,
      ).toBe(false);
    }
  });

  it("no migration adds a runtime raise with no errcode at all", () => {
    const novel = [...new Set(bareRuntimeRaises())].filter((r) => !BARE_RAISES.has(r)).sort();

    expect(
      novel,
      "A `raise exception` with no `using errcode` cannot be translated by " +
        "translatePgError — there is no key to match, so the UI shows the raw " +
        "Postgres string however many cases pg-errors.ts grows. Add " +
        "`using errcode = 'P00NN'` plus a case in pg-errors.ts (CLAUDE.md " +
        "names the next free code), or a standard SQLSTATE like " +
        "`check_violation` if that is genuinely what it is. Post-condition " +
        "asserts inside a `do $$ … $$` block are exempt and need no code.",
    ).toEqual([]);
  });

  it("keeps the bare-raise allowlist honest", () => {
    // Same contract as DEAD_CODES: the list may only shrink, so an entry that
    // no longer matches anything is an entry to delete.
    const live = new Set(bareRuntimeRaises());
    const stale = [...BARE_RAISES].filter((r) => !live.has(r)).sort();
    expect(
      stale,
      "These no longer raise without an errcode — delete them from " +
        "BARE_RAISES so the list stays a true map of what is left.",
    ).toEqual([]);
  });

  it("does not count a migration-time assertion as a bare raise", () => {
    // 0148 and 0149 both end with `do $$ … $$` post-conditions that raise with
    // no code, which is correct — they abort a deploy and never reach a user.
    // If the do-block detection breaks, this goes red BEFORE the rule above
    // starts demanding P-codes for every migration assertion in the repo.
    const raises = bareRuntimeRaises().join("\n");
    expect(raises).not.toContain("0148_ops_daily_view_grants.sql");
    expect(raises).not.toContain("0149_ap_cash_bill_payment_drawer_link.sql");
  });

  it("registers the two codes 0149 introduces", () => {
    expect(raised.get("P0051")).toContain("0149_ap_cash_bill_payment_drawer_link.sql");
    expect(raised.get("P0052")).toContain("0149_ap_cash_bill_payment_drawer_link.sql");
    expect(translated.has("P0051")).toBe(true);
    expect(translated.has("P0052")).toBe(true);
  });
});
