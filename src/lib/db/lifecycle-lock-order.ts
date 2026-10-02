/**
 * Static check of DRMed's global lock order in migration functions.
 *
 * The order every writer must follow (3a review, 0215/0216):
 *   patient lifecycle advisory lock (lifecycle_lock / lifecycle_lock_and_assert,
 *   shared for writers) → visit row → test_requests lines ORDER BY id → write.
 *
 * A function that row-locks a visit or a line FIRST, or writes a patient-owned
 * row FIRST, holds a row lock and only then reaches the patient lock — either
 * its own later lifecycle_lock call, or the a_lifecycle_guard trigger that the
 * write fires. merge_patients_guarded / undo_patient_merge_guarded (0196) go
 * the other way round (exclusive patient lock first, then `update visits`),
 * so the two deadlock (40P01). (delete_patient / restore_patient also lock the
 * patient exclusive, but then touch only the patients row.) That is the
 * cycle 3a's review found in recompute_clinic_fee_for_unreleased.
 *
 * This module is pure (no database): it reads the live function bodies the
 * migration replay produces (migration-lock-scan.ts) and reports, per
 * function, the first statement that takes a lifecycle-table row lock or
 * writes a guarded table before any patient lifecycle lock is taken.
 */
import { stripComments, type LiveFunction, type MigrationFile } from "./migration-lock-scan";

/** The function a_lifecycle_guard executes (0184); a table carrying it is patient-owned. */
export const LIFECYCLE_GUARD_FN = "enforce_patient_activity";

/** The trigger name 0184 installs; same-timing row triggers fire in name order. */
export const LIFECYCLE_GUARD_TRIGGER = "a_lifecycle_guard";

/** Tables whose row locks must come after the patient lock (the visit → lines tier of the order). */
export const ROW_LOCK_TABLES = ["visits", "test_requests"] as const;

/** Direct ways of taking the patient lifecycle lock. */
const DIRECT_LIFECYCLE_LOCK = [
  /\blifecycle_lock\s*\(/,
  /\blifecycle_lock_and_assert\s*\(/,
  // delete_patient / restore_patient / merge take the raw key (0167, 0196).
  /\bpg_advisory_xact_lock(?:_shared)?\s*\(\s*hashtext\s*\(\s*'patient_lifecycle'/,
];

const ROW_LOCK_CLAUSE = /\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b(?:\s+of\s+(\w+(?:\.\w+)?(?:\s*,\s*\w+(?:\.\w+)?)*))?/g;

export interface TriggerAttachment {
  table: string;
  trigger: string;
  fn: string;
  /** BEFORE row triggers fire in name order, so only one sorting after a_lifecycle_guard runs under its lock. */
  timing: "before" | "after" | "instead of";
}

/** Replay `create trigger` / `drop trigger` in filename order; return the live attachments. */
export function scanTriggers(files: MigrationFile[]): TriggerAttachment[] {
  const live = new Map<string, TriggerAttachment>();
  const bare = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();
  for (const { sql } of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const text = stripComments(sql);
    const events: { at: number; apply: () => void }[] = [];
    for (const m of text.matchAll(
      /create\s+(?:or\s+replace\s+)?(constraint\s+)?trigger\s+("?\w+"?)\s+(before|after|instead\s+of)\b[^;]*?\bon\s+((?:"?\w+"?\.)?"?\w+"?)[^;]*?\bexecute\s+(?:function|procedure)\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi,
    )) {
      const timing = m[3].toLowerCase().replace(/\s+/g, " ") as TriggerAttachment["timing"];
      const att = { trigger: bare(m[2]), table: bare(m[4]), fn: bare(m[5]), timing: m[1] ? ("after" as const) : timing };
      events.push({ at: m.index!, apply: () => live.set(`${att.table}.${att.trigger}`, att) });
    }
    for (const m of text.matchAll(/drop\s+trigger\s+(?:if\s+exists\s+)?("?\w+"?)\s+on\s+((?:"?\w+"?\.)?"?\w+"?)/gi)) {
      const key = `${bare(m[2])}.${bare(m[1])}`;
      events.push({ at: m.index!, apply: () => live.delete(key) });
    }
    for (const e of events.sort((a, b) => a.at - b.at)) e.apply();
  }
  return [...live.values()].sort((a, b) => `${a.table}.${a.trigger}`.localeCompare(`${b.table}.${b.trigger}`));
}

/** Tables carrying the lifecycle guard trigger — the patient-owned tables. */
export function guardedTables(triggers: TriggerAttachment[]): string[] {
  return [...new Set(triggers.filter((t) => t.fn === LIFECYCLE_GUARD_FN && t.trigger === LIFECYCLE_GUARD_TRIGGER).map((t) => t.table))].sort();
}

/**
 * Split a body into statements on top-level `;` (string literals and nested
 * dollar-quoted bodies are kept whole, so dynamic SQL stays one statement).
 */
export function statements(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "'") {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === "'" && body[j + 1] === "'") j += 2;
        else if (body[j] === "'") break;
        else j++;
      }
      cur += body.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]?\w*\$/.exec(body.slice(i, i + 40));
      if (m) {
        const end = body.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? body.length : end + m[0].length;
        cur += body.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/"/g, "").replace(/\s+/g, " ");

/** alias → table for every FROM/JOIN item of a statement (a table with no alias maps to itself). */
function fromItems(stmt: string): Map<string, string> {
  const items = new Map<string, string>();
  const KEYWORDS = new Set(["where", "join", "left", "right", "inner", "outer", "cross", "full", "on", "using", "order", "group", "for", "limit", "set", "returning", "natural", "lateral", "union", "having", "window", "into"]);
  for (const m of stmt.matchAll(/\b(?:from|join)\s+(?:only\s+)?((?:\w+\.)?\w+)(?:\s+(?:as\s+)?(\w+))?/g)) {
    const table = m[1].split(".").pop()!;
    const alias = m[2] && !KEYWORDS.has(m[2]) ? m[2] : table;
    items.set(alias, table);
    items.set(table, table);
  }
  return items;
}

/** The lifecycle tables (visits / test_requests) this statement row-locks, if any. */
export function rowLockedTables(stmtRaw: string): string[] {
  const stmt = norm(stmtRaw);
  const locked = new Set<string>();
  for (const m of stmt.matchAll(ROW_LOCK_CLAUSE)) {
    const items = fromItems(stmt);
    const targets = m[1]
      ? m[1].split(",").map((a) => a.trim().split(".").pop()!).map((a) => items.get(a) ?? a)
      : [...new Set(items.values())];
    for (const t of targets) if ((ROW_LOCK_TABLES as readonly string[]).includes(t)) locked.add(t);
  }
  return [...locked].sort();
}

/** The guarded tables this statement inserts into, updates or deletes from. */
export function guardedWrites(stmtRaw: string, guarded: readonly string[]): string[] {
  const stmt = norm(stmtRaw);
  const hit = new Set<string>();
  for (const m of stmt.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?((?:\w+\.)?\w+)/g)) {
    const t = m[1].split(".").pop()!;
    if (guarded.includes(t)) hit.add(t);
  }
  return [...hit].sort();
}

export type OrderFinding =
  | { kind: "row-lock"; tables: string[]; statement: string }
  | { kind: "write"; tables: string[]; statement: string };

/**
 * Walk the body in text order. Returns null when a patient lifecycle lock is
 * taken before any lifecycle-table row lock or guarded write (or when there is
 * neither), else the first offending statement.
 */
export function firstUnorderedStatement(
  body: string,
  guarded: readonly string[],
  lifecycleFirstCallees: ReadonlySet<string>,
): OrderFinding | null {
  const callee = lifecycleFirstCallees.size
    ? new RegExp(`\\b(?:${[...lifecycleFirstCallees].join("|")})\\s*\\(`)
    : null;
  for (const raw of statements(body)) {
    const stmt = norm(raw);
    // A statement that takes the patient lock counts as taking it before its own row locks
    // (e.g. `perform lifecycle_lock_and_assert(...)`; `select … into v from visits … for update`
    // never also calls the helper in practice).
    if (DIRECT_LIFECYCLE_LOCK.some((re) => re.test(stmt)) || (callee && callee.test(stmt))) return null;
    const locks = rowLockedTables(raw);
    if (locks.length) return { kind: "row-lock", tables: locks, statement: raw.replace(/\s+/g, " ").slice(0, 160) };
    const writes = guardedWrites(raw, guarded);
    if (writes.length) return { kind: "write", tables: writes, statement: raw.replace(/\s+/g, " ").slice(0, 160) };
  }
  return null;
}

/** True when the body takes the patient lifecycle lock before anything else it locks or writes. */
function takesLifecycleFirst(body: string, guarded: readonly string[], lifecycleFirstCallees: ReadonlySet<string>): boolean {
  const callee = lifecycleFirstCallees.size
    ? new RegExp(`\\b(?:${[...lifecycleFirstCallees].join("|")})\\s*\\(`)
    : null;
  for (const raw of statements(body)) {
    const stmt = norm(raw);
    if (DIRECT_LIFECYCLE_LOCK.some((re) => re.test(stmt)) || (callee && callee.test(stmt))) return true;
    if (rowLockedTables(raw).length || guardedWrites(raw, guarded).length) return false;
  }
  return false;
}

/**
 * Functions whose first locking/writing act is the patient lifecycle lock, computed
 * to a fixed point: calling one of them counts as taking the lock (release_report_locks
 * is how release_visit_results takes it).
 */
export function lifecycleFirstFunctions(live: LiveFunction[], guarded: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of live) {
      if (set.has(f.name) || f.returnsTrigger) continue;
      if (takesLifecycleFirst(f.body, guarded, set)) {
        set.add(f.name);
        changed = true;
      }
    }
  }
  return set;
}

export interface LockOrderViolation {
  name: string;
  signature: string;
  file: string;
  finding: OrderFinding;
}

/**
 * Every live function that row-locks visits/test_requests or writes a guarded table before
 * taking the patient lifecycle lock. Trigger functions attached ONLY to guarded tables are
 * skipped: a_lifecycle_guard fires first on the same row (same-timing triggers run in name
 * order) and holds the patient lock while they run.
 */
export function scanLockOrder(live: LiveFunction[], triggers: TriggerAttachment[]): LockOrderViolation[] {
  const guarded = guardedTables(triggers);
  const lifecycleFirst = lifecycleFirstFunctions(live, guarded);
  // fn -> its attachments; and fn -> the attachments that run while a_lifecycle_guard holds the patient lock.
  const attachedTo = new Map<string, Set<string>>();
  const underGuard = new Map<string, Set<string>>();
  for (const t of triggers) {
    const key = `${t.table}.${t.trigger}`;
    if (!attachedTo.has(t.fn)) attachedTo.set(t.fn, new Set());
    attachedTo.get(t.fn)!.add(key);
    const guardFirst = t.timing === "after" || t.trigger > LIFECYCLE_GUARD_TRIGGER;
    if (guarded.includes(t.table) && guardFirst) {
      if (!underGuard.has(t.fn)) underGuard.set(t.fn, new Set());
      underGuard.get(t.fn)!.add(key);
    }
  }
  const out: LockOrderViolation[] = [];
  for (const f of live) {
    if (f.name === LIFECYCLE_GUARD_FN) continue;
    if (f.returnsTrigger) {
      const tables = attachedTo.get(f.name);
      if (tables && tables.size > 0 && tables.size === (underGuard.get(f.name)?.size ?? 0)) continue;
    }
    const finding = firstUnorderedStatement(f.body, guarded, lifecycleFirst);
    if (finding) out.push({ name: f.name, signature: f.signature, file: f.file, finding });
  }
  return out;
}

export interface LockOrderExemption {
  /** Migration file of the definition that was reviewed — a redefinition must be reviewed again. */
  file: string;
  why: string;
}

/** Decision logic, kept pure for self-tests. */
export function checkLockOrder(
  violations: LockOrderViolation[],
  allow: Record<string, LockOrderExemption>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const v of violations) {
    seen.add(v.name);
    const entry = allow[v.name];
    const what =
      v.finding.kind === "row-lock"
        ? `row-locks ${v.finding.tables.join("/")}`
        : `writes ${v.finding.tables.join("/")}`;
    if (!entry) {
      problems.push(
        `LOCK ORDER: ${v.name}(${v.signature}) in ${v.file} ${what} before taking the patient lifecycle lock:\n` +
          `    ${v.finding.statement}\n` +
          `  Take it first — \`perform public.lifecycle_lock_and_assert(<patient ids>, false);\` (shared) — then the visit\n` +
          `  row, then lines ORDER BY id (see 0216's delete_test_request_lines). A row lock taken before the patient lock\n` +
          `  deadlocks (40P01) against merge_patients_guarded / undo_patient_merge_guarded, which lock the patient EXCLUSIVE and then update visits.`,
      );
      continue;
    }
    if (entry.file !== v.file) {
      problems.push(
        `LOCK ORDER: ${v.name} is allow-listed for ${entry.file} but was redefined in ${v.file} — re-check its lock order and\n` +
          `  either take the patient lock first or update the entry's file after re-reviewing the reason.`,
      );
    }
    if (entry.why.trim().length < 40) problems.push(`LOCK ORDER: the allow-list reason for ${v.name} is not a real reason.`);
  }
  for (const name of Object.keys(allow)) {
    if (!seen.has(name)) problems.push(`STALE LOCK-ORDER ALLOW-LIST: ${name} no longer takes a row lock/write before the patient lock (or no longer exists) — remove it.`);
  }
  return problems;
}
