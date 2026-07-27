/**
 * Guard coverage for `scripts/`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `requireLocalOrExplicitProd()` only protects the scripts that remember to
 * call it. Every runner in `scripts/` builds a service-role client, which
 * bypasses RLS, and every `.env.local` in this repo points at the PRODUCTION
 * project — so a new script that forgets the guard is one `npm run` away from
 * rewriting live clinic data. The convention is documented in CLAUDE.md, and a
 * convention nobody checks is a convention that decays.
 *
 * This test reads every file under `scripts/` as a module graph and fails when
 * a runner can reach a privileged client without the guard having run first.
 * It is deliberately a static check rather than a lint rule: it follows local
 * imports and function calls, so a client built three files away still counts.
 *
 * WHAT COUNTS AS A VIOLATION
 * --------------------------
 *   1. COVERAGE — the module graph touches `SUPABASE_SERVICE_ROLE_KEY` or
 *      `SUPABASE_DB_URL`, or constructs a Supabase/pg client, but never calls
 *      `requireLocalOrExplicitProd`, or never imports `scripts/lib/load-env`.
 *
 *   2. ORDER — a client IS constructed on a path the guard has not run on yet.
 *      Reading the env var early is fine (several scripts hoist their config to
 *      module scope); building the client that uses it is not.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It reasons about *reachability*, not about branches: a guard call anywhere
 * earlier in the executed path counts, whether or not it was inside an `if`.
 * `requireLocalOrExplicitProd` exits the process when it refuses, so being
 * reached at all is the property that matters. Dynamic dispatch (a client
 * factory passed as a value and called later) is not tracked — a bare
 * reference to a local function is treated as a call, which errs toward
 * flagging rather than missing.
 *
 * FIXING A FAILURE
 * ----------------
 *     import "./lib/load-env";                       // FIRST import
 *     import { requireLocalOrExplicitProd } from "./lib/env-guard";
 *
 *     requireLocalOrExplicitProd("<npm script name>", { writes: "…" });
 *
 * before the client is built. See scripts/lib/env-guard.ts.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPTS_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOAD_ENV_MODULE = join(SCRIPTS_DIR, "lib", "load-env.ts");
const GUARD_FN = "requireLocalOrExplicitProd";

/** Env vars that name a database. Reading one means this file is privileged. */
const PRIVILEGED_ENV = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"];

/** Factory functions that hand back a client bound to those credentials. */
const CLIENT_FACTORIES: Record<string, string[]> = {
  "@supabase/supabase-js": ["createClient"],
  "@supabase/ssr": ["createServerClient", "createBrowserClient"],
};

/** Constructors that open a direct Postgres connection. */
const CLIENT_CONSTRUCTORS: Record<string, string[]> = {
  pg: ["Client", "Pool"],
};

/**
 * Files that are not runners and carry no privileged code: the guard's own
 * tests, and SQL. Everything else under scripts/ is checked, including files
 * that are only ever imported — someone can always `tsx` them directly.
 */
const isCheckable = (path: string) =>
  /\.(ts|mts|mjs|js)$/.test(path) && !/\.test\.ts$/.test(path);

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

interface ImportRef {
  /** Raw specifier as written. */
  spec: string;
  /** Absolute path when the specifier resolves inside scripts/, else null. */
  resolved: string | null;
}

interface Binding {
  /** Bare module specifier (`pg`, `@supabase/supabase-js`) or an absolute path. */
  from: string;
  /** Imported export name, or "default" / "*". */
  name: string;
}

interface Module {
  path: string;
  rel: string;
  src: ts.SourceFile;
  imports: ImportRef[];
  /** Local name → the function it names, for call-graph walking. */
  functions: Map<string, ts.FunctionLikeDeclaration>;
  /** Local name → where it came from. */
  bindings: Map<string, Binding>;
  privilegedEnv: string[];
  buildsClient: boolean;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}

/** Resolve a relative import the way tsx does, including extensionless paths. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}.js`,
    // ESM specifiers may carry a .js extension that means the .ts source.
    base.replace(/\.js$/, ".ts"),
    join(base, "index.ts"),
    join(base, "index.mjs"),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // Not this candidate.
    }
  }
  return null;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/** `text` is supplied only by the analyser's own fixtures below. */
function parse(path: string, text = readFileSync(path, "utf8")): Module {
  const src = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /\.(mjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

  const imports: ImportRef[] = [];
  const bindings = new Map<string, Binding>();
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  const privilegedEnv = new Set<string>();

  // --- imports + top-level function declarations -----------------------------
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const resolved = resolveLocal(path, spec);
      imports.push({ spec, resolved });

      const from = resolved ?? spec;
      const clause = st.importClause;
      if (clause?.name) bindings.set(clause.name.text, { from, name: "default" });
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          bindings.set(clause.namedBindings.name.text, { from, name: "*" });
        } else {
          for (const el of clause.namedBindings.elements) {
            bindings.set(el.name.text, {
              from,
              name: (el.propertyName ?? el.name).text,
            });
          }
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(st) && st.name) {
      functions.set(st.name.text, st);
      continue;
    }

    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          isFunctionLike(decl.initializer)
        ) {
          functions.set(decl.name.text, decl.initializer);
        }
      }
    }
  }

  // --- privileged env reads, anywhere in the file ----------------------------
  const scan = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      PRIVILEGED_ENV.includes(node.name.text) &&
      node.expression.getText(src) === "process.env"
    ) {
      privilegedEnv.add(node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      PRIVILEGED_ENV.includes(node.argumentExpression.text) &&
      node.expression.getText(src) === "process.env"
    ) {
      privilegedEnv.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, scan);
  };
  scan(src);

  const mod: Module = {
    path,
    rel: relative(SCRIPTS_DIR, path),
    src,
    imports,
    functions,
    bindings,
    privilegedEnv: [...privilegedEnv].sort(),
    buildsClient: false,
  };

  // --- client construction, anywhere in the file ----------------------------
  const scanClients = (node: ts.Node): void => {
    if (isClientConstruction(mod, node)) mod.buildsClient = true;
    ts.forEachChild(node, scanClients);
  };
  scanClients(src);

  return mod;
}

/** `createClient(...)` / `new pg.Client(...)` bound to a real client package. */
function isClientConstruction(mod: Module, node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const b = mod.bindings.get(node.expression.text);
    return !!b && (CLIENT_FACTORIES[b.from] ?? []).includes(b.name);
  }

  if (ts.isNewExpression(node)) {
    // `new Client(...)` from a named import.
    if (ts.isIdentifier(node.expression)) {
      const b = mod.bindings.get(node.expression.text);
      return !!b && (CLIENT_CONSTRUCTORS[b.from] ?? []).includes(b.name);
    }
    // `new pg.Client(...)` from a default/namespace import.
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const b = mod.bindings.get(node.expression.expression.text);
      return (
        !!b &&
        (CLIENT_CONSTRUCTORS[b.from] ?? []).includes(node.expression.name.text)
      );
    }
  }

  return false;
}

const MODULES = new Map<string, Module>();
function moduleAt(path: string): Module {
  let m = MODULES.get(path);
  if (!m) {
    m = parse(path);
    MODULES.set(path, m);
  }
  return m;
}

/** Every local module an entry point pulls in, transitively, plus itself. */
function closureOf(entry: string): Module[] {
  const seen = new Set<string>();
  const out: Module[] = [];
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const mod = moduleAt(path);
    out.push(mod);
    for (const imp of mod.imports) if (imp.resolved) visit(imp.resolved);
  };
  visit(entry);
  return out;
}

// ---------------------------------------------------------------------------
// Reachability: is the guard reached before any client is built?
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** A guard call in a position that actually executes (not inside a function). */
function containsExecutedGuardCall(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || isFunctionLike(n)) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === GUARD_FN
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

interface WalkContext {
  violations: Violation[];
  visitedModules: Set<string>;
  visitedFunctions: Set<string>;
}

/** Where an identifier's function body lives, following local imports. */
function targetOf(
  mod: Module,
  name: string,
): { mod: Module; fn: ts.FunctionLikeDeclaration } | null {
  const own = mod.functions.get(name);
  if (own) return { mod, fn: own };

  const binding = mod.bindings.get(name);
  if (!binding || !binding.from.startsWith("/")) return null;

  let target: Module;
  try {
    target = moduleAt(binding.from);
  } catch {
    return null;
  }
  const fn = target.functions.get(binding.name);
  return fn ? { mod: target, fn } : null;
}

function record(mod: Module, node: ts.Node, ctx: WalkContext): void {
  const { line } = mod.src.getLineAndCharacterOfPosition(node.getStart(mod.src));
  ctx.violations.push({
    file: mod.rel,
    line: line + 1,
    text: node.getText(mod.src).split("\n")[0].trim().slice(0, 80),
  });
}

/**
 * Positions where an identifier names something rather than reading it. Walking
 * into these would treat `import { adminClient } from "./engine"` as a call to
 * adminClient at import time, which is how the first draft of this analyser
 * flagged three scripts that were in fact correctly guarded.
 */
function isNonExecutingPosition(node: ts.Node): boolean {
  return (
    ts.isImportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeNode(node)
  );
}

/** Walk an expression tree in an executing position under `guarded`. */
function walkExpression(
  mod: Module,
  node: ts.Node,
  guarded: boolean,
  ctx: WalkContext,
): void {
  // Function bodies are not executed where they are written — only where they
  // are called, which the identifier branch below handles.
  if (isFunctionLike(node) || isNonExecutingPosition(node)) return;

  if (!guarded && isClientConstruction(mod, node)) record(mod, node, ctx);

  const recurse = (child: ts.Node | undefined): void => {
    if (child) walkExpression(mod, child, guarded, ctx);
  };

  // `a.b` reads `a`; `b` is a member name, not a reference to a local `b`.
  if (ts.isPropertyAccessExpression(node)) return recurse(node.expression);
  // A declaration's NAME is not a read of it — only its initializer runs.
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    return recurse(node.initializer);
  }
  if (ts.isPropertyAssignment(node)) return recurse(node.initializer);

  if (ts.isIdentifier(node)) {
    // A bare reference counts as a call: passing a factory somewhere it is
    // invoked later is indistinguishable from calling it here, and erring
    // toward flagging is the right bias for this check.
    const target = targetOf(mod, node.text);
    if (target) enterFunction(target.mod, target.fn, guarded, ctx);
    return;
  }

  ts.forEachChild(node, recurse);
}

/** Walk a statement list, flipping to `guarded` once the guard has run. */
function walkStatements(
  mod: Module,
  statements: readonly ts.Statement[],
  guarded: boolean,
  ctx: WalkContext,
): boolean {
  for (const st of statements) {
    walkExpression(mod, st, guarded, ctx);
    if (!guarded && containsExecutedGuardCall(st)) guarded = true;
  }
  return guarded;
}

function enterFunction(
  mod: Module,
  fn: ts.FunctionLikeDeclaration,
  guarded: boolean,
  ctx: WalkContext,
): void {
  const key = `${mod.path}:${fn.getStart(mod.src)}:${guarded}`;
  if (ctx.visitedFunctions.has(key)) return;
  ctx.visitedFunctions.add(key);

  const body = fn.body;
  if (!body) return;
  if (ts.isBlock(body)) walkStatements(mod, body.statements, guarded, ctx);
  else walkExpression(mod, body, guarded, ctx); // concise arrow body
}

/**
 * Evaluate a module the way ESM does: imports first, in source order, then the
 * module body — so a side-effect import that guards (several runners import an
 * engine that guards at module scope) counts for everything after it.
 */
function walkModule(mod: Module, guarded: boolean, ctx: WalkContext): boolean {
  const key = `${mod.path}:${guarded}`;
  if (ctx.visitedModules.has(key)) return guarded;
  ctx.visitedModules.add(key);

  for (const imp of mod.imports) {
    if (!imp.resolved) continue;
    guarded = walkModule(moduleAt(imp.resolved), guarded, ctx);
  }
  return walkStatements(mod, mod.src.statements, guarded, ctx);
}

function unguardedClientBuilds(entry: string): Violation[] {
  const ctx: WalkContext = {
    violations: [],
    visitedModules: new Set(),
    visitedFunctions: new Set(),
  };
  walkModule(moduleAt(entry), false, ctx);
  return ctx.violations;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

const ENTRIES = walkFiles(SCRIPTS_DIR).sort();

describe("scripts/ guard coverage", () => {
  it("finds the runners to check", () => {
    // A resolution or glob mistake that silently checked nothing would make
    // every assertion below vacuously pass.
    expect(ENTRIES.length).toBeGreaterThan(20);
    expect(ENTRIES).toContain(join(SCRIPTS_DIR, "wipe-operational.ts"));
    expect(ENTRIES).toContain(join(SCRIPTS_DIR, "patient-dedup", "index.ts"));
  });

  it("resolves local imports rather than skipping them", () => {
    // patient-dedup/index.ts reaches its client through ./engine — if local
    // resolution broke, the checks below would see an empty module graph.
    const closure = closureOf(join(SCRIPTS_DIR, "patient-dedup", "index.ts"));
    expect(closure.map((m) => m.rel)).toContain(join("patient-dedup", "engine.ts"));
    expect(closure.some((m) => m.buildsClient)).toBe(true);
  });

  it.each(ENTRIES.map((e) => [relative(SCRIPTS_DIR, e), e] as const))(
    "%s calls requireLocalOrExplicitProd if it touches a privileged client",
    (rel, entry) => {
      const closure = closureOf(entry);
      const privileged = closure.filter(
        (m) => m.privilegedEnv.length > 0 || m.buildsClient,
      );
      if (privileged.length === 0) return;

      const why = privileged
        .map(
          (m) =>
            `    ${m.rel}${m.buildsClient ? " (builds a client)" : ""}${
              m.privilegedEnv.length ? ` (reads ${m.privilegedEnv.join(", ")})` : ""
            }`,
        )
        .join("\n");

      const guards = closure.some((m) =>
        m.src.getFullText().includes(`${GUARD_FN}(`),
      );
      expect(
        guards,
        `scripts/${rel} reaches privileged code but never calls ${GUARD_FN}:\n${why}\n` +
          `  Add requireLocalOrExplicitProd("<npm script name>", { writes: "…" }) before the client is built.`,
      ).toBe(true);

      const loadsEnv = closure.some((m) => m.path === LOAD_ENV_MODULE);
      expect(
        loadsEnv,
        `scripts/${rel} reaches privileged code but never imports lib/load-env, so it would ` +
          `read whatever env the shell happens to carry instead of defaulting to the local stack.\n${why}`,
      ).toBe(true);
    },
  );

  it.each(ENTRIES.map((e) => [relative(SCRIPTS_DIR, e), e] as const))(
    "%s builds no client before the guard has run",
    (rel, entry) => {
      const violations = unguardedClientBuilds(entry);
      const detail = violations
        .map((v) => `    ${v.file}:${v.line}  ${v.text}`)
        .join("\n");
      expect(
        violations,
        `scripts/${rel} constructs a database client on a path where ${GUARD_FN} ` +
          `has not run yet:\n${detail}\n` +
          `  Move the guard call above the construction (module scope is usually right).`,
      ).toEqual([]);
    },
  );
});

describe("guard-coverage analyser", () => {
  // The analyser is the thing standing between a new script and production, so
  // it gets its own fixtures — a coverage test that silently stopped detecting
  // anything would look exactly like a clean run.
  const analyse = (source: string): Violation[] => {
    // Fixture specifiers are all bare package names, so nothing resolves to
    // disk and the module graph is exactly this one file.
    const mod = parse(join(SCRIPTS_DIR, "__fixture__.ts"), source);
    const ctx: WalkContext = {
      violations: [],
      visitedModules: new Set(),
      visitedFunctions: new Set(),
    };
    walkModule(mod, false, ctx);
    return ctx.violations;
  };

  const CREATE = `import { createClient } from "@supabase/supabase-js";\n`;

  it("flags a client built with no guard at all", () => {
    expect(analyse(`${CREATE}const admin = createClient(a, b);`)).toHaveLength(1);
  });

  it("flags a client built BEFORE the guard call", () => {
    expect(
      analyse(
        `${CREATE}const admin = createClient(a, b);\n${GUARD_FN}("x");`,
      ),
    ).toHaveLength(1);
  });

  it("accepts a client built after a module-scope guard", () => {
    expect(
      analyse(`${CREATE}${GUARD_FN}("x");\nconst admin = createClient(a, b);`),
    ).toEqual([]);
  });

  it("accepts a client built in a function called after the guard", () => {
    // The shape wipe-operational.ts and patient-dedup use: the factory is
    // declared above the guard but only invoked below it.
    expect(
      analyse(
        `${CREATE}function build() { return createClient(a, b); }\n` +
          `${GUARD_FN}("x");\nconst admin = build();`,
      ),
    ).toEqual([]);
  });

  it("flags a client built in a function called BEFORE the guard", () => {
    expect(
      analyse(
        `${CREATE}function build() { return createClient(a, b); }\n` +
          `const admin = build();\n${GUARD_FN}("x");`,
      ),
    ).toHaveLength(1);
  });

  it("follows the guard through a function, not just module scope", () => {
    // patient-dedup guards inside run(), then builds the client further down.
    expect(
      analyse(
        `${CREATE}function build() { return createClient(a, b); }\n` +
          `function run() { ${GUARD_FN}("x"); const admin = build(); }\nrun();`,
      ),
    ).toEqual([]);
  });

  it("does not let a guard inside an UNCALLED function count", () => {
    expect(
      analyse(
        `${CREATE}function unused() { ${GUARD_FN}("x"); }\n` +
          `const admin = createClient(a, b);`,
      ),
    ).toHaveLength(1);
  });

  it("catches a direct Postgres connection too, not just Supabase", () => {
    expect(analyse(`import pg from "pg";\nconst c = new pg.Client({});`)).toHaveLength(1);
    expect(
      analyse(`import { Client } from "pg";\nconst c = new Client({});`),
    ).toHaveLength(1);
  });

  it("ignores a same-named function from an unrelated package", () => {
    expect(
      analyse(`import { createClient } from "redis";\nconst c = createClient();`),
    ).toEqual([]);
  });

  it("does not treat importing a factory as calling it", () => {
    // The bug this analyser shipped with first: three correctly-guarded
    // scripts were flagged because `import { adminClient }` was walked as a
    // call to adminClient at import time, i.e. before any guard could run.
    expect(
      analyse(
        `${CREATE}function adminClient() { return createClient(a, b); }\n` +
          `function run() { ${GUARD_FN}("x"); adminClient(); }\nrun();`,
      ),
    ).toEqual([]);
  });

  it("does not treat a member named like a local function as a call", () => {
    expect(
      analyse(
        `${CREATE}function build() { return createClient(a, b); }\n` +
          `const o = {}; o.build;\n${GUARD_FN}("x");`,
      ),
    ).toEqual([]);
  });
});
