/**
 * Environment resolution + production guard for the one-off runners in `scripts/`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every script in `scripts/` builds a service-role Supabase client, which
 * bypasses RLS entirely. They used to be launched with a hardcoded
 * `tsx --env-file=.env.local`, and every `.env.local` in this repo (root and
 * each worktree) points at the PRODUCTION project. So `npm run seed:services`
 * rewrote the live clinic's price list and `npm run dedup:patients -- --commit`
 * merged real patient records. Nothing in the invocation said so.
 *
 * Two independent protections live in this module:
 *
 *   1. `loadScriptEnv()` (via the side-effect module `./load-env`) decides
 *      WHICH env file a script reads. It defaults to the local stack and only
 *      reaches for `.env.local` when the operator explicitly opts in.
 *
 *   2. `requireLocalOrExplicitProd()` refuses to continue when the *resolved*
 *      target is not a local database, whatever the env file said. It checks
 *      every configured target (REST endpoint AND direct Postgres URL) and
 *      fails closed on anything it cannot parse.
 *
 * The two are deliberately separate: (1) is convenience, (2) is the seatbelt.
 * A script that is handed a prod URL through the ambient shell environment
 * still gets stopped by (2).
 *
 * OPT-IN
 * ------
 *   SEED_ALLOW_PROD=1 npm run seed:services
 *   npm run seed:services -- --prod
 *
 * Either form switches the env default to `.env.local` AND satisfies the
 * guard, which then prints a loud banner naming the host, the project ref and
 * what the script is about to write, and (on a TTY) pauses so there is a
 * window to Ctrl-C.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * The env shape these helpers read. Deliberately NOT `NodeJS.ProcessEnv` —
 * Next.js augments that with a required `NODE_ENV`, which would force every
 * test fixture to carry one. `process.env` is assignable to this.
 */
export type ScriptEnv = Record<string, string | undefined>;

/** Env vars that name a database a script could write to. */
export const TARGET_ENV_VARS = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", label: "Supabase REST" },
  { name: "SUPABASE_DB_URL", label: "Postgres direct" },
] as const;

export const PROD_OPT_IN_ENV = "SEED_ALLOW_PROD";
export const ENV_FILE_OVERRIDE_ENV = "DRMED_ENV_FILE";
export const SKIP_COUNTDOWN_ENV = "SEED_SKIP_COUNTDOWN";
export const LOCAL_ENV_FILE = ".env.development.local";
export const PROD_ENV_FILE = ".env.local";

/** Seconds to pause before writing to a non-local database on a TTY. */
export const PROD_COUNTDOWN_SECONDS = 5;

// ---------------------------------------------------------------------------
// Host classification
// ---------------------------------------------------------------------------

/**
 * True only for hosts that can be a developer's own machine or the local
 * Supabase docker stack. Anything unrecognised is treated as remote — this
 * must fail closed, so do not loosen it with substring matching (a
 * `url.includes("localhost")` test would pass `https://localhost.example.com`).
 */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === "host.docker.internal") return true;

  // Container hostnames used inside the local Supabase docker network —
  // `supabase_kong_DRMed`, `supabase_db_DRMed`, etc.
  if (h === "supabase_kong" || h.startsWith("supabase_kong_")) return true;
  if (h === "supabase_db" || h.startsWith("supabase_db_")) return true;

  return false;
}

/** Hostname of a URL, or null when it is absent/unparseable (⇒ treated remote). */
export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * `qhptbmafrosgibooelpp` out of `qhptbmafrosgibooelpp.supabase.co`.
 *
 * Pooler hosts (`aws-0-<region>.pooler.supabase.com`) deliberately return null:
 * their subdomain is a REGION, and the project ref lives in the connection
 * username (`postgres.<ref>`). Printing the region as a project ref would name
 * the wrong thing in a banner whose whole job is to say which database.
 */
export function supabaseProjectRef(host: string | null): string | null {
  if (!host) return null;
  const m = /^([a-z0-9]+)\.supabase\.(?:co|in)$/i.exec(host);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Guard evaluation (pure)
// ---------------------------------------------------------------------------

export interface EnvTarget {
  /** Env var this target came from. */
  varName: string;
  /** Human label for the banner. */
  label: string;
  /** Hostname, or null when the value could not be parsed as a URL. */
  host: string | null;
  /** Supabase project ref when the host is a Supabase-hosted one. */
  projectRef: string | null;
  isLocal: boolean;
}

export interface GuardDecision {
  targets: EnvTarget[];
  nonLocal: EnvTarget[];
  prodOptIn: boolean;
  /** How the opt-in was given, for the banner. Null when there was none. */
  optInVia: string | null;
  allowed: boolean;
  blockReason: "unconfigured" | "non-local" | null;
}

/** Every target env var that is actually set, classified local/remote. */
export function classifyTargets(env: ScriptEnv): EnvTarget[] {
  const out: EnvTarget[] = [];
  for (const { name, label } of TARGET_ENV_VARS) {
    const value = env[name];
    if (!value || !value.trim()) continue;
    const host = hostOf(value.trim());
    out.push({
      varName: name,
      label,
      host,
      projectRef: supabaseProjectRef(host),
      isLocal: isLocalHost(host),
    });
  }
  return out;
}

export function readProdOptIn(
  env: ScriptEnv,
  argv: readonly string[],
): { prodOptIn: boolean; optInVia: string | null } {
  if (env[PROD_OPT_IN_ENV] === "1") {
    return { prodOptIn: true, optInVia: `${PROD_OPT_IN_ENV}=1` };
  }
  if (argv.includes("--prod")) {
    return { prodOptIn: true, optInVia: "--prod" };
  }
  return { prodOptIn: false, optInVia: null };
}

export function evaluateEnvGuard(opts: {
  env: ScriptEnv;
  argv: readonly string[];
}): GuardDecision {
  const targets = classifyTargets(opts.env);
  const nonLocal = targets.filter((t) => !t.isLocal);
  const { prodOptIn, optInVia } = readProdOptIn(opts.env, opts.argv);

  if (targets.length === 0) {
    return {
      targets,
      nonLocal,
      prodOptIn,
      optInVia,
      allowed: false,
      blockReason: "unconfigured",
    };
  }

  const allowed = nonLocal.length === 0 || prodOptIn;
  return {
    targets,
    nonLocal,
    prodOptIn,
    optInVia,
    allowed,
    blockReason: allowed ? null : "non-local",
  };
}

// ---------------------------------------------------------------------------
// Message formatting (pure — kept separate so the wording is unit-testable)
// ---------------------------------------------------------------------------

function describeTarget(t: EnvTarget): string {
  const host = t.host ?? "(unparseable value)";
  const ref = t.projectRef ? `  [project ${t.projectRef}]` : "";
  return `  ${t.label.padEnd(16)} ${host}${ref}`;
}

export function formatBlockMessage(
  scriptName: string,
  decision: GuardDecision,
): string {
  if (decision.blockReason === "unconfigured") {
    return [
      ``,
      `[${scriptName}] no database target is configured.`,
      ``,
      `Set NEXT_PUBLIC_SUPABASE_URL (and SUPABASE_SERVICE_ROLE_KEY) — normally`,
      `by creating ${LOCAL_ENV_FILE} pointing at your local stack:`,
      ``,
      `    supabase status --output json | jq -r .API_URL`,
      ``,
    ].join("\n");
  }

  return [
    ``,
    `[${scriptName}] refusing to run against a NON-LOCAL database.`,
    ``,
    ...decision.nonLocal.map(describeTarget),
    ``,
    `Scripts default to the local Supabase stack (${LOCAL_ENV_FILE}).`,
    `If you really mean to touch this database, opt in explicitly:`,
    ``,
    `    ${PROD_OPT_IN_ENV}=1 npm run ${scriptName}`,
    `    npm run ${scriptName} -- --prod`,
    ``,
    `To run locally instead, start the stack (\`supabase start\`) and make sure`,
    `${LOCAL_ENV_FILE} exists with its API URL and service-role key.`,
    ``,
  ].join("\n");
}

export function formatProdWarning(
  scriptName: string,
  decision: GuardDecision,
  writes: string | undefined,
  readOnly = false,
): string {
  const rule = "=".repeat(72);
  const effect = readOnly
    ? `  will read        ${writes ?? "(not declared)"}`
    : `  will write       ${writes ?? "(this script does not declare what it writes)"}`;

  return [
    ``,
    rule,
    `  ⚠  ${scriptName} IS ABOUT TO ${readOnly ? "READ FROM" : "TOUCH"} A NON-LOCAL DATABASE`,
    rule,
    ...decision.nonLocal.map(describeTarget),
    ``,
    effect,
    `  opted in via     ${decision.optInVia ?? "(unknown)"}`,
    rule,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

export interface GuardOptions {
  /**
   * One line describing what this script writes, shown in the prod banner.
   * Say the tables/rows, not the mechanism — "upserts `services` rows (prices,
   * active flags)" beats "runs an upsert".
   */
  writes?: string;
  /**
   * This script only reads. It is still guarded — pointing a "local" smoke
   * run at the live clinic reads real patient data (RA 10173) — but the
   * banner says "will read" rather than "will write".
   */
  readOnly?: boolean;
  /** Skip the TTY countdown (already-confirmed flows, tests). */
  noCountdown?: boolean;
}

/**
 * Abort unless every configured database target is local, or the operator
 * explicitly opted in. Call this before the first write — ideally right after
 * the client is built.
 */
export function requireLocalOrExplicitProd(
  scriptName: string,
  options: GuardOptions = {},
): void {
  const decision = evaluateEnvGuard({ env: process.env, argv: process.argv });

  if (!decision.allowed) {
    console.error(formatBlockMessage(scriptName, decision));
    process.exit(1);
  }

  if (decision.nonLocal.length === 0) return;

  console.warn(
    formatProdWarning(
      scriptName,
      decision,
      options.writes,
      options.readOnly === true,
    ),
  );

  const skip =
    options.noCountdown === true ||
    process.env[SKIP_COUNTDOWN_ENV] === "1" ||
    process.argv.includes("--yes") ||
    !process.stdout.isTTY;
  if (!skip) countdown(PROD_COUNTDOWN_SECONDS, scriptName);
}

/**
 * Blocking pause so an operator who typed `--prod` by reflex can still bail.
 * Synchronous on purpose: the guard is called from module top-level in several
 * scripts, before any `await` exists to hang an async sleep off.
 */
function countdown(seconds: number, scriptName: string): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  for (let remaining = seconds; remaining > 0; remaining--) {
    process.stdout.write(
      `\r  starting ${scriptName} in ${remaining}s — Ctrl-C to abort   `,
    );
    Atomics.wait(buffer, 0, 0, 1000);
  }
  process.stdout.write("\r".padEnd(60, " ") + "\r");
}

// ---------------------------------------------------------------------------
// Env-file resolution
// ---------------------------------------------------------------------------

export interface EnvFileIo {
  exists(path: string): boolean;
  /** File contents, or null when the path is a directory / unreadable. */
  readText(path: string): string | null;
}

export const nodeEnvFileIo: EnvFileIo = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      if (statSync(path).isDirectory()) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * Root of the MAIN worktree, given a directory that may itself be a linked
 * worktree. Linked worktrees have a `.git` FILE containing
 * `gitdir: /main/root/.git/worktrees/<name>`; the main worktree has a `.git`
 * directory.
 *
 * This matters because none of this repo's worktrees carry their own
 * `.env.development.local` — only the main checkout does.
 */
export function findMainWorktreeRoot(
  cwd: string,
  io: EnvFileIo = nodeEnvFileIo,
): string | null {
  const dotGit = join(cwd, ".git");
  if (!io.exists(dotGit)) return null;

  const text = io.readText(dotGit);
  if (text === null) return cwd; // `.git` is a directory ⇒ this IS the main root

  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return null;

  const gitdirRaw = match[1].trim();
  const gitdir = isAbsolute(gitdirRaw) ? gitdirRaw : resolve(cwd, gitdirRaw);

  const marker = `${sep}.git${sep}worktrees${sep}`;
  const index = gitdir.lastIndexOf(marker);
  if (index === -1) return null;

  return gitdir.slice(0, index);
}

export type EnvFileSource = "override" | "prod-opt-in" | "default";

export interface EnvFilePlan {
  /** Files to load, in order. Earlier files WIN (Node never overwrites a set var). */
  files: { path: string; label: string; role: "primary" | "fallback" }[];
  source: EnvFileSource;
  prodOptIn: boolean;
  /** Paths that were looked for but not found — for the error message. */
  searched: string[];
}

/**
 * Decide which env file(s) a script should read.
 *
 * Layering rule: Node's env-file loader never overwrites a variable that is
 * already set, so the FIRST file listed wins. In local mode we therefore load
 * `.env.development.local` first (it owns the Supabase target) and then
 * `.env.local` as a fallback purely to fill in the unrelated config the local
 * file does not carry (CONSULTANT_*_STAFF_ID, CRON_SECRET, …). The database
 * target still comes from the local file.
 *
 * In prod-opt-in mode only `.env.local` is loaded. With an explicit
 * DRMED_ENV_FILE override only that file is loaded — no layering, no surprises.
 */
export function planEnvFiles(opts: {
  cwd: string;
  env: ScriptEnv;
  argv: readonly string[];
  io?: EnvFileIo;
}): EnvFilePlan {
  const io = opts.io ?? nodeEnvFileIo;
  const { prodOptIn } = readProdOptIn(opts.env, opts.argv);
  const searched: string[] = [];

  const locate = (label: string): string | null => {
    const local = join(opts.cwd, label);
    searched.push(local);
    if (io.exists(local)) return local;

    const mainRoot = findMainWorktreeRoot(opts.cwd, io);
    if (mainRoot && mainRoot !== opts.cwd) {
      const shared = join(mainRoot, label);
      searched.push(shared);
      if (io.exists(shared)) return shared;
    }
    return null;
  };

  const override = opts.env[ENV_FILE_OVERRIDE_ENV]?.trim();
  if (override) {
    const path = isAbsolute(override) ? override : resolve(opts.cwd, override);
    searched.push(path);
    return {
      files: io.exists(path)
        ? [{ path, label: override, role: "primary" }]
        : [],
      source: "override",
      prodOptIn,
      searched,
    };
  }

  if (prodOptIn) {
    const path = locate(PROD_ENV_FILE);
    return {
      files: path ? [{ path, label: PROD_ENV_FILE, role: "primary" }] : [],
      source: "prod-opt-in",
      prodOptIn,
      searched,
    };
  }

  const files: EnvFilePlan["files"] = [];
  const primary = locate(LOCAL_ENV_FILE);
  if (primary) files.push({ path: primary, label: LOCAL_ENV_FILE, role: "primary" });

  const fallback = locate(PROD_ENV_FILE);
  if (fallback) files.push({ path: fallback, label: PROD_ENV_FILE, role: "fallback" });

  return { files, source: "default", prodOptIn, searched };
}

export function formatMissingEnvFileMessage(plan: EnvFilePlan): string {
  const wanted =
    plan.source === "override"
      ? `the file named by ${ENV_FILE_OVERRIDE_ENV}`
      : plan.source === "prod-opt-in"
        ? PROD_ENV_FILE
        : `${LOCAL_ENV_FILE} (or ${PROD_ENV_FILE})`;

  return [
    ``,
    `[env] could not find ${wanted}.`,
    ``,
    `Looked in:`,
    ...plan.searched.map((p) => `  ${p}`),
    ``,
    `Scripts read ${LOCAL_ENV_FILE} by default so they target the local`,
    `Supabase stack. Create it with your local API URL, anon key and`,
    `service-role key (\`supabase status\`), or point at another file:`,
    ``,
    `    ${ENV_FILE_OVERRIDE_ENV}=/path/to/env npm run <script>`,
    ``,
  ].join("\n");
}

export function formatLoadSummary(plan: EnvFilePlan): string {
  const primary = plan.files.find((f) => f.role === "primary");
  const fallback = plan.files.find((f) => f.role === "fallback");

  if (plan.source === "prod-opt-in") {
    return `[env] PROD opt-in — loaded ${primary?.path ?? "(none)"}`;
  }
  if (plan.source === "override") {
    return `[env] ${ENV_FILE_OVERRIDE_ENV} — loaded ${primary?.path ?? "(none)"}`;
  }
  const tail = fallback
    ? ` (+ ${fallback.path} for values it does not define)`
    : "";
  return `[env] loaded ${primary?.path ?? "(none)"}${tail}`;
}

/**
 * Populate `process.env` from the resolved env file(s). Variables already
 * present in the real environment always win, so CI and one-off
 * `FOO=bar npm run …` overrides keep working.
 */
export function loadScriptEnv(
  opts: { cwd?: string; quiet?: boolean } = {},
): EnvFilePlan {
  const cwd = opts.cwd ?? process.cwd();
  const plan = planEnvFiles({ cwd, env: process.env, argv: process.argv });

  if (plan.files.length === 0) {
    console.error(formatMissingEnvFileMessage(plan));
    process.exit(1);
  }

  for (const file of plan.files) process.loadEnvFile(file.path);

  if (!opts.quiet) console.log(formatLoadSummary(plan));
  return plan;
}
