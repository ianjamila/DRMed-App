/**
 * Text-level scanner for lock / claim functions in `supabase/migrations`.
 * Pure (no fs) so the guard's self-tests can feed it synthetic SQL.
 *
 * It replays migrations in filename order and keeps the LATEST definition of
 * each function name, so a later `create or replace` without locks un-flags a
 * function, and a `drop function` removes it. Overloads share one key (the
 * bare name): the repo has no overloaded lock functions, and a later overload
 * simply supersedes — acceptable for a guard that only needs "does the live
 * function lock".
 */

export interface MigrationFile {
  /** e.g. "0198_atomic_report_release.sql" */
  file: string;
  sql: string;
}

export interface LockFunction {
  name: string;
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

/** Remove `--` and block comments, and single-quoted string literals. */
export function stripNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += "''";
    } else if (c === "$") {
      // Keep dollar-quoted text verbatim (comments inside are handled by the
      // caller re-running stripNoise on bodies); copy the tag and move on.
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Blank comments only (keep quotes and dollar bodies) so dollar tags and
 * function headers can be located without a `--` comment confusing them.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      // comments inside a dollar body are still comments; but a nested tag
      // of a different name is just text here.
    }
    const two = sql.slice(i, i + 2);
    if (!inStr && two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inStr && two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    const c = sql[i];
    if (!dollarTag) {
      if (c === "'") inStr = !inStr;
      if (!inStr && c === "$") {
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

const HEADER =
  /create\s+(?:or\s+replace\s+)?function\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi;
const DROP = /drop\s+function\s+(?:if\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s*(?:\(|;|\s)/gi;

function bareName(raw: string): string {
  return raw.replace(/"/g, "").split(".").pop()!.toLowerCase();
}

interface Def {
  name: string;
  index: number;
  body: string;
}

function definitions(sql: string): { defs: Def[]; drops: { name: string; index: number }[] } {
  const text = stripComments(sql);
  const defs: Def[] = [];
  for (const m of text.matchAll(HEADER)) {
    const start = m.index! + m[0].length;
    // the body opens at the first dollar tag after the header's `as`
    const rest = text.slice(start);
    const tagMatch = /\bas\s+(\$[A-Za-z_]?\w*\$)/i.exec(rest);
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyStart = tagMatch.index + tagMatch[0].length;
    const bodyEnd = rest.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue;
    defs.push({
      name: bareName(m[1]),
      index: m.index!,
      body: rest.slice(bodyStart, bodyEnd),
    });
  }
  const drops: { name: string; index: number }[] = [];
  for (const m of text.matchAll(DROP)) drops.push({ name: bareName(m[1]), index: m.index! });
  return { defs, drops };
}

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

export function lockSignals(body: string, name = ""): string[] {
  const clean = stripNoise(body).toLowerCase();
  const found = LOCK_SIGNALS.filter(([, re]) => re.test(clean)).map(([n]) => n);
  if (HELPER_CALL.test(clean)) found.push("calls lock helper");
  if (CLAIM_NAME.test(name.toLowerCase())) found.push("claim name");
  return found.sort();
}

/** Replay the migrations; return the live functions that carry lock signals. */
export function scanLockFunctions(files: MigrationFile[]): LockFunction[] {
  const live = new Map<string, LockFunction | null>();
  for (const { file, sql } of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const { defs, drops } = definitions(sql);
    const events = [
      ...defs.map((d) => ({ at: d.index, def: d })),
      ...drops.map((d) => ({ at: d.index, drop: d.name })),
    ].sort((a, b) => a.at - b.at);
    for (const e of events) {
      if ("drop" in e) {
        live.delete(e.drop);
        continue;
      }
      const signals = lockSignals(e.def.body, e.def.name);
      live.set(e.def.name, signals.length ? { name: e.def.name, file, signals } : null);
    }
  }
  return [...live.values()].filter((v): v is LockFunction => v !== null).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// The guard's decision logic, kept pure so it can be self-tested.
// ---------------------------------------------------------------------------

export type RegistryEntry =
  | { proof: readonly string[] }
  | { exempt: string };

export interface GuardInput {
  live: LockFunction[];
  /** Functions that need a proof or a reasoned exemption. */
  registry: Record<string, RegistryEntry>;
  /** Frozen pre-guard functions: name -> migration file of the definition at freeze time. */
  baseline: Record<string, string>;
  /** Proof file text by repo-relative path, or null when the file does not exist. */
  readProof: (relPath: string) => string | null;
}

/** A proof must actually run an interleaving, not just call the function. */
export const RACE_MARKER = /\brace\b|races\b|concurren|two[- ]connection|two sessions|dblink/i;

export function missingEntryMessage(fn: LockFunction): string {
  return (
    `${fn.name} (${fn.file}) takes locks or claims work [${fn.signals.join(", ")}] but has no concurrency proof. ` +
    `Write scripts/<name>-concurrency-proof.ts (two real connections, with a --control mode) or ` +
    `supabase/tests/<NNNN>_<name>_race_smoke.sql, then add "${fn.name}": { proof: ["<that path>"] } to REGISTRY in ` +
    `src/lib/db/concurrency-proof-guard.test.ts. If no interleaving is possible, add ` +
    `"${fn.name}": { exempt: "<why>" } instead. Do NOT add it to BASELINE — that list is frozen.`
  );
}

export function checkGuard({ live, registry, baseline, readProof }: GuardInput): string[] {
  const problems: string[] = [];
  const liveByName = new Map(live.map((f) => [f.name, f]));

  for (const fn of live) {
    const inRegistry = fn.name in registry;
    const inBaseline = fn.name in baseline;
    if (inRegistry && inBaseline) {
      problems.push(`${fn.name} is in both REGISTRY and BASELINE — baseline entries are for unproven pre-guard functions only; remove it from BASELINE.`);
    } else if (inBaseline) {
      if (baseline[fn.name] !== fn.file) {
        problems.push(
          `${fn.name} was redefined in ${fn.file} after the guard froze it at ${baseline[fn.name]}. ` +
            `A redefinition is new work: ` + missingEntryMessage(fn),
        );
      }
    } else if (!inRegistry) {
      problems.push(missingEntryMessage(fn));
    }
  }

  for (const [name, file] of Object.entries(baseline)) {
    if (!liveByName.has(name)) {
      problems.push(`STALE BASELINE: ${name} (frozen at ${file}) no longer exists or no longer locks — delete the entry.`);
    }
  }

  for (const [name, entry] of Object.entries(registry)) {
    if (!liveByName.has(name)) {
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
      if (!new RegExp(`\\b${name}\\b`).test(text)) {
        problems.push(`${name}: proof file ${rel} never mentions "${name}" — it no longer covers this function.`);
      }
      if (!RACE_MARKER.test(text)) {
        problems.push(`${name}: ${rel} has no race/concurrency marker — a sequential smoke is not a concurrency proof.`);
      }
    }
  }
  return problems;
}
