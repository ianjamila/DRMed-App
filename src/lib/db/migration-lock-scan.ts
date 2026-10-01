/**
 * Text-level scanner for lock / claim functions in `supabase/migrations`.
 * Pure (no fs) so the guard's self-tests can feed it synthetic SQL.
 *
 * It replays migrations in filename order and keeps the LATEST definition of
 * each function SIGNATURE (name + normalised argument types), so a later
 * `create or replace` without locks un-flags that overload, and a
 * `drop function` removes the overload it names (all overloads when it names
 * none). Registry/baseline keys are bare names and cover every overload.
 *
 * Known limits: a compare-and-set claim whose name lacks a `claim` segment is
 * not detected (no explicit lock, nothing to match); a `begin atomic` body
 * ends at the first line that is just `end;`; lock words inside string
 * literals count (dynamic SQL), so a message that says "for update" is a
 * rare false positive.
 */

export interface MigrationFile {
  /** e.g. "0198_atomic_report_release.sql" */
  file: string;
  sql: string;
}

export interface LockFunction {
  /** Bare function name (schema stripped, lower-cased). */
  name: string;
  /** Normalised argument types, e.g. "uuid, uuid[]". */
  signature: string;
  /** Migration file holding the latest definition. */
  file: string;
  /** Names of the lock signals found in the body (sorted, unique). */
  signals: string[];
}

/** Signals that mean "this function serialises or claims work". */
export const LOCK_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["for update", /\bfor\s+update\b/],
  ["for no key update", /\bfor\s+no\s+key\s+update\b/],
  ["for share", /\bfor\s+share\b/],
  ["for key share", /\bfor\s+key\s+share\b/],
  ["skip locked", /\bskip\s+locked\b/],
  ["nowait", /\bnowait\b/],
  ["advisory lock", /\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\s*\(/],
  ["lock table", /\block\s+(?:table\s+)?(?:only\s+)?[a-z_"][\w".]*\s+in\s+[a-z ]+\s+mode\b/],
];

/**
 * Lock helpers other functions delegate to. A function that calls one holds
 * its locks through the helper (e.g. release_visit_results has no `for update`
 * of its own — release_report_locks takes them), so the call is a signal.
 */
export const LOCK_HELPERS = [
  "release_report_locks",
  "lifecycle_lock",
  "lifecycle_lock_results",
  "lifecycle_lock_and_assert",
];
const HELPER_CALL = new RegExp(`\\b(?:${LOCK_HELPERS.join("|")})\\s*\\(`);
/** Compare-and-set claims (`update … where claimed_by is null`) take no explicit lock. */
const CLAIM_NAME = /(?:^|_)(?:un)?claim(?:_|$)/;

/** Index just past the single-quoted string opening at `i` (an E-string honours backslashes). */
function skipString(sql: string, i: number, escapes: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    if (escapes && sql[j] === "\\") j += 2;
    else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
    else if (sql[j] === "'") return j + 1;
    else j++;
  }
  return sql.length;
}

const isEString = (sql: string, i: number) => /^[eE]$/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? " ");

/** Blank `--` and block comments; keep strings and dollar-quoted bodies verbatim. */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
    }
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    const c = sql[i];
    if (!dollarTag) {
      if (c === "'") {
        const end = skipString(sql, i, isEString(sql, i));
        out += sql.slice(i, end);
        i = end;
        continue;
      }
      if (c === "$") {
        const m = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i, i + 40));
        if (m) {
          dollarTag = m[0];
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

// --- signatures ------------------------------------------------------------

const TYPE_ALIASES: Record<string, string> = {
  int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean",
  float8: "double precision", float4: "real", varchar: "character varying",
  timestamptz: "timestamp with time zone", timetz: "time with time zone",
};
const MODES = new Set(["in", "out", "inout", "variadic"]);
const MULTIWORD_START = new Set(["double", "timestamp", "time", "character", "bit", "national", "interval"]);

/** Split on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "" || parts.length) parts.push(cur);
  return parts;
}

function normaliseType(raw: string): string {
  let t = raw.toLowerCase().replace(/\b(?:public|pg_catalog)\./g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/\(\s*\d+(?:\s*,\s*\d+)?\s*\)/g, ""); // numeric(10,2) == numeric
  for (const [from, to] of Object.entries(TYPE_ALIASES)) {
    t = t.replace(new RegExp(`^${from}(?=$|\\[| )`), to);
  }
  return t.replace(/\s*\[\s*\]/g, "[]");
}

/** One argument: drop mode, name and default; keep the type. */
function normaliseArg(arg: string): string | null {
  const a = arg.trim().replace(/\s+(?:default\b|=)[\s\S]*$/i, "").trim();
  if (a === "") return null;
  const toks = a.split(/\s+/);
  if (MODES.has(toks[0].toLowerCase()) && toks.length > 1) toks.shift();
  if (toks.length > 1 && !(MULTIWORD_START.has(toks[0].toLowerCase()) && /^(precision|with|without|varying|zone|\d)/i.test(toks[1]))) {
    toks.shift(); // a parameter name
  }
  return normaliseType(toks.join(" "));
}

export function normaliseSignature(argList: string): string {
  return splitTop(argList).map(normaliseArg).filter((x): x is string => x !== null).join(", ");
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "'") {
      i = skipString(text, i, isEString(text, i)) - 1;
      continue;
    }
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

const bareName = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();

// --- definitions -----------------------------------------------------------

const HEADER = /create\s+(?:or\s+replace\s+)?function\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi;

interface Def {
  name: string;
  signature: string;
  index: number;
  body: string;
}

/**
 * The body belongs to THIS function only: it is looked for between the end of
 * the argument list and the first `;` — `as $tag$ … $tag$`, `as '…'` or
 * `begin atomic … end;`. A function with none of these (e.g. language c) has
 * no body and must not borrow the next function's.
 */
function bodyAfterHeader(text: string, from: number): string | null {
  const semi = text.indexOf(";", from);
  const re = /\bas\s*(\$[A-Za-z_]?\w*\$|[eE]?')|\bbegin\s+atomic\b/gi;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m || (semi !== -1 && m.index > semi)) return null;
  const bodyStart = m.index + m[0].length;
  if (/^begin/i.test(m[0])) {
    const rest = text.slice(bodyStart);
    const end = /^\s*end\s*;/im.exec(rest);
    return end ? rest.slice(0, end.index) : rest;
  }
  const opener = m[1];
  if (opener.endsWith("'")) {
    const quoteAt = m.index + m[0].length - 1;
    const end = skipString(text, quoteAt, opener.length === 2);
    const raw = text.slice(quoteAt + 1, end - 1);
    return opener.length === 2 ? raw.replace(/\\(.)/g, "$1").replace(/''/g, "'") : raw.replace(/''/g, "'");
  }
  const close = text.indexOf(opener, bodyStart);
  return close === -1 ? null : text.slice(bodyStart, close);
}

function definitions(text: string): Def[] {
  const defs: Def[] = [];
  for (const m of text.matchAll(HEADER)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) continue;
    const body = bodyAfterHeader(text, close + 1);
    if (body === null) continue;
    defs.push({
      name: bareName(m[1]),
      signature: normaliseSignature(text.slice(open + 1, close)),
      index: m.index!,
      body,
    });
  }
  return defs;
}

interface Drop {
  index: number;
  name: string;
  /** undefined = every overload. */
  signature?: string;
}

function drops(text: string): Drop[] {
  const out: Drop[] = [];
  for (const m of text.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?([^;]*);/gi)) {
    for (const item of splitTop(m[1])) {
      const it = /^\s*((?:"?\w+"?\.)?"?\w+"?)\s*(\([^]*\))?\s*(?:cascade|restrict)?\s*$/i.exec(item);
      if (!it) continue;
      out.push({
        index: m.index!,
        name: bareName(it[1]),
        signature: it[2] === undefined ? undefined : normaliseSignature(it[2].slice(1, -1)),
      });
    }
  }
  return out;
}

export function lockSignals(body: string, name = ""): string[] {
  const clean = stripComments(body).toLowerCase();
  const found = LOCK_SIGNALS.filter(([, re]) => re.test(clean)).map(([n]) => n);
  if (HELPER_CALL.test(clean)) found.push("calls lock helper");
  if (CLAIM_NAME.test(name.toLowerCase())) found.push("claim name");
  return found.sort();
}

/** Replay the migrations; return the live functions that carry lock signals. */
export function scanLockFunctions(files: MigrationFile[]): LockFunction[] {
  const live = new Map<string, LockFunction | null>();
  const keyOf = (name: string, sig: string) => `${name}(${sig})`;
  for (const { file, sql } of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const text = stripComments(sql);
    const events = [
      ...definitions(text).map((d) => ({ at: d.index, def: d })),
      ...drops(text).map((d) => ({ at: d.index, drop: d })),
    ].sort((a, b) => a.at - b.at);
    for (const e of events) {
      if ("drop" in e) {
        const { name, signature } = e.drop;
        if (signature !== undefined) live.delete(keyOf(name, signature));
        else for (const k of [...live.keys()]) if (k.startsWith(`${name}(`)) live.delete(k);
        continue;
      }
      const { name, signature, body } = e.def;
      const signals = lockSignals(body, name);
      live.set(keyOf(name, signature), signals.length ? { name, signature, file, signals } : null);
    }
  }
  return [...live.values()]
    .filter((v): v is LockFunction => v !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.signature.localeCompare(b.signature));
}

// ---------------------------------------------------------------------------
// The guard's decision logic, kept pure so it can be self-tested.
// ---------------------------------------------------------------------------

export type RegistryEntry =
  | { proof: readonly string[] }
  | { exempt: string };

export interface GuardInput {
  live: LockFunction[];
  /** Keyed by BARE name: an entry covers every overload of that name. */
  registry: Record<string, RegistryEntry>;
  /** Frozen pre-guard functions: bare name -> migration file of the latest definition at freeze time. */
  baseline: Record<string, string>;
  /** Proof file text by repo-relative path, or null when the file does not exist. */
  readProof: (relPath: string) => string | null;
}

/**
 * Names a proof file claims to race, from lines of the form
 * `concurrency-proof: fn_a, fn_b (free text)` (any comment prefix). The
 * annotation sits in or next to the scenario that actually races the
 * function — a bare mention, or the word "race" elsewhere in the file, proves
 * nothing.
 */
export function annotatedFunctions(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/concurrency-proof:[ \t]*([^\n]*)/g)) {
    for (const n of m[1].split("(")[0].split(",")) if (n.trim()) names.add(n.trim());
  }
  return names;
}

export function missingEntryMessage(fn: LockFunction): string {
  return (
    `${fn.name}(${fn.signature}) (${fn.file}) takes locks or claims work [${fn.signals.join(", ")}] but has no concurrency proof. ` +
    `Write scripts/<name>-concurrency-proof.ts (two real connections, with a --control mode) or ` +
    `supabase/tests/<NNNN>_<name>_race_smoke.sql, put a "concurrency-proof: ${fn.name}" comment line in or next to the scenario that races it, ` +
    `then add "${fn.name}": { proof: ["<that path>"] } to REGISTRY in ` +
    `src/lib/db/concurrency-proof-guard.test.ts. If no interleaving is possible, add ` +
    `"${fn.name}": { exempt: "<why>" } instead. Do NOT add it to BASELINE — that list is frozen.`
  );
}

export function checkGuard({ live, registry, baseline, readProof }: GuardInput): string[] {
  const problems: string[] = [];
  const byName = new Map<string, LockFunction[]>();
  for (const f of live) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);

  for (const [name, fns] of byName) {
    // The newest definition among the overloads decides whether the name is "redefined".
    const latest = fns.reduce((a, b) => (a.file >= b.file ? a : b));
    const inRegistry = name in registry;
    const inBaseline = name in baseline;
    if (inRegistry && inBaseline) {
      problems.push(`${name} is in both REGISTRY and BASELINE — baseline entries are for unproven pre-guard functions only; remove it from BASELINE.`);
    } else if (inBaseline) {
      if (baseline[name] !== latest.file) {
        problems.push(
          `${name} was redefined in ${latest.file} after the guard froze it at ${baseline[name]}. A redefinition is new work: ` +
            missingEntryMessage(latest),
        );
      }
    } else if (!inRegistry) {
      problems.push(missingEntryMessage(latest));
    }
  }

  for (const [name, file] of Object.entries(baseline)) {
    if (!byName.has(name)) {
      problems.push(`STALE BASELINE: ${name} (frozen at ${file}) no longer exists or no longer locks — delete the entry.`);
    }
  }

  for (const [name, entry] of Object.entries(registry)) {
    if (!byName.has(name)) {
      problems.push(`STALE REGISTRY: ${name} no longer exists or no longer locks — delete the entry.`);
      continue;
    }
    if ("exempt" in entry) {
      if (entry.exempt.trim().length < 20) problems.push(`${name}: an exemption needs a real reason (>= 20 characters).`);
      continue;
    }
    if (entry.proof.length === 0) problems.push(`${name}: proof list is empty — give a path or use { exempt }.`);
    for (const rel of entry.proof) {
      const text = readProof(rel);
      if (text === null) {
        problems.push(`${name}: proof file ${rel} does not exist (renamed or deleted?).`);
        continue;
      }
      if (!annotatedFunctions(text).has(name)) {
        problems.push(
          `${name}: proof file ${rel} has no "concurrency-proof: ${name}" annotation — add one in or next to the scenario that races it ` +
            `(a mention, or a race elsewhere in the file, is not enough).`,
        );
      }
    }
  }
  return problems;
}
