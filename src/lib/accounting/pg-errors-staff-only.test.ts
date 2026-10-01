import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

// translatePgError passes a hand-written 23514 message through verbatim (0184's
// "a result can only hold one patient's tests", "a critical alert's patient
// must match its test's patient", …). Those lines are written for STAFF — they
// name internal records and rules. That is only safe while no patient-facing or
// public surface can reach pg-errors.ts. This guard walks the import graph from
// every non-staff entry under src/app and fails if pg-errors.ts is reachable,
// naming the import chain. If a portal/marketing path genuinely needs error
// text, give it its own patient-safe translator instead of importing this one.

const ROOT = process.cwd();
const APP = join(ROOT, "src", "app");
const TARGET = join(ROOT, "src", "lib", "accounting", "pg-errors.ts");

// Staff-only trees under src/app. Everything else is treated as reachable by a
// patient or the public: (patient)/portal, (marketing), display, review,
// register-poster, auth, api/cron, the root layout and error pages — plus the
// code that runs on every request outside src/app (the proxy, instrumentation
// and the Sentry configs).
const STAFF_ONLY = [join(APP, "(staff)"), join(APP, "api", "admin")];
const REQUEST_WIDE = [
  "src/proxy.ts",
  "src/instrumentation.ts",
  "src/instrumentation-client.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
].map((p) => join(ROOT, p));

const isSource = (f: string) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : isSource(f) ? [p] : [];
  });
}

const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package — not our code
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

// Module specifiers read with the TypeScript parser, not a regex: it accepts every
// form the compiler does (compact `import{x}from"m"`, backtick and comment-laden
// import(), `import x = require()`, `export * from`) and ignores text inside
// strings and comments. Type-only imports/exports (`import type`, `export type`)
// are skipped: they are erased at build time and carry no runtime code. An inline
// `import { type X }` is still counted — conservative, the guard errs toward flagging.
// The parser follows the FILE's own kind: a `.ts` generic arrow `<T>(x: T) => x`
// read as TSX is a JSX tag, and everything after it — an import() included — was
// lost (Codex recheck of #268). A file that does not parse fails the guard
// instead of quietly yielding fewer imports.
function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function specifiersOf(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  // parseDiagnostics is not in the public typings but has been on every
  // SourceFile for years; if a TypeScript upgrade drops it, fail loudly.
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!diagnostics) throw new Error("TypeScript no longer exposes parseDiagnostics — update specifiersOf");
  if (diagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ");
    throw new Error(`${rel(file)} does not parse as ${ts.ScriptKind[scriptKindOf(file)]}: ${first}`);
  }
  const out: string[] = [];
  const literal = (n: ts.Node | undefined) => {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) out.push(n.text);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      if (!n.importClause?.isTypeOnly) literal(n.moduleSpecifier);
    } else if (ts.isExportDeclaration(n)) {
      if (!n.isTypeOnly) literal(n.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(n)) {
      if (!n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) {
        literal(n.moduleReference.expression);
      }
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        literal(n.arguments[0]);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function importsOf(file: string, text?: string): string[] {
  // A stylesheet, JSON or image reached through an import carries no imports
  // of its own; only code files are parsed (and a code file must parse).
  if (!/\.[mc]?[jt]sx?$/.test(file)) return [];
  text ??= readFileSync(file, "utf8");
  const out: string[] = [];
  for (const spec of specifiersOf(file, text)) {
    const r = resolveSpecifier(file, spec);
    if (r) out.push(r);
  }
  return out;
}

// Breadth-first from every root. Returns one import chain per reachable file
// that imports TARGET directly, so every leak is named at once, not one per run.
function chainsToTarget(roots: string[]): string[][] {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of roots) {
    parent.set(r, null);
    queue.push(r);
  }
  const hits: string[][] = [];
  while (queue.length) {
    const f = queue.shift()!;
    for (const next of importsOf(f)) {
      if (next === TARGET) {
        const chain: string[] = [TARGET];
        for (let c: string | null = f; c; c = parent.get(c) ?? null) chain.unshift(c);
        hits.push(chain);
      } else if (!parent.has(next)) {
        parent.set(next, f);
        queue.push(next);
      }
    }
  }
  return hits;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const roots = [
  ...walk(APP).filter((f) => !STAFF_ONLY.some((d) => f.startsWith(d + sep))),
  ...REQUEST_WIDE.filter((f) => existsSync(f)),
];

describe("translatePgError stays staff-only", () => {
  it("scans the patient-facing trees (guard against a bad walk)", () => {
    const relRoots = roots.map(rel);
    expect(relRoots.some((r) => r.startsWith("src/app/(patient)/portal/"))).toBe(true);
    expect(relRoots.some((r) => r.startsWith("src/app/(marketing)/"))).toBe(true);
    expect(relRoots.some((r) => r.startsWith("src/app/(staff)/"))).toBe(false);
    expect(relRoots).toContain("src/proxy.ts");
  });

  it("no patient-facing or public entry can import pg-errors.ts", () => {
    const chains = chainsToTarget(roots).map((c) => c.map(rel).join(" → "));
    expect(
      chains,
      "A non-staff surface can reach translatePgError, whose 23514 passthrough " +
        "shows staff-only messages. Give that path a patient-safe translator instead.",
    ).toEqual([]);
  });

  it("mutation proof: the walk finds pg-errors.ts from a staff page that uses it", () => {
    const staffCaller = join(APP, "(staff)", "staff", "(dashboard)", "critical-alerts", "actions.ts");
    expect(chainsToTarget([staffCaller]).length).toBe(1);
  });

  it("mutation proof: the matcher reads every import form and skips type-only ones", () => {
    const from = join(APP, "(patient)", "portal", "x.ts");
    const found = (src: string) => importsOf(from, src).map(rel);
    const target = "src/lib/accounting/pg-errors.ts";
    expect(found(`import { translatePgError } from "@/lib/accounting/pg-errors";`)).toEqual([target]);
    expect(found(`import {\n  translatePgError,\n} from '@/lib/accounting/pg-errors'`)).toEqual([target]);
    expect(found(`export { translatePgError } from "@/lib/accounting/pg-errors";`)).toEqual([target]);
    expect(found(`const m = await import("@/lib/accounting/pg-errors");`)).toEqual([target]);
    expect(found(`import type { X } from "@/lib/accounting/pg-errors";`)).toEqual([]);
  });

  it("mutation proof: compact, backtick, commented and re-export forms are all read", () => {
    const from = join(APP, "(patient)", "portal", "x.ts");
    const found = (src: string) => importsOf(from, src).map(rel);
    const target = "src/lib/accounting/pg-errors.ts";
    expect(found(`import{translatePgError}from"@/lib/accounting/pg-errors"`)).toEqual([target]);
    expect(found("const m = await import(`@/lib/accounting/pg-errors`);")).toEqual([target]);
    expect(
      found(`const m = import(/* webpackChunkName: "x" */ "@/lib/accounting/pg-errors");`),
    ).toEqual([target]);
    expect(found(`import "@/lib/accounting/pg-errors";`)).toEqual([target]);
    expect(found(`export * from "@/lib/accounting/pg-errors";`)).toEqual([target]);
    expect(found(`export * as pg from "@/lib/accounting/pg-errors";`)).toEqual([target]);
    expect(found(`const m = require("@/lib/accounting/pg-errors");`)).toEqual([target]);
    expect(found(`import pg = require("@/lib/accounting/pg-errors");`)).toEqual([target]);
    expect(found(`import { type X, translatePgError } from "@/lib/accounting/pg-errors";`)).toEqual([target]);
    // Type-only forms are erased at build time: no runtime code, so not a leak.
    expect(found(`export type { X } from "@/lib/accounting/pg-errors";`)).toEqual([]);
    // Text that merely looks like an import (string / comment) is not one.
    expect(found(`const s = 'import x from "@/lib/accounting/pg-errors"';`)).toEqual([]);
    expect(found(`// import x from "@/lib/accounting/pg-errors"\nconst a = 1;`)).toEqual([]);
  });

  it("mutation proof: a .ts file is parsed as TS, a .tsx file as TSX, and a file that does not parse fails", () => {
    const target = "src/lib/accounting/pg-errors.ts";
    const ts_ = join(APP, "(patient)", "portal", "x.ts");
    const tsx = join(APP, "(patient)", "portal", "x.tsx");
    // Read as TSX, `<T>` opens a JSX tag and the import() after it was lost.
    expect(
      importsOf(ts_, `const identity = <T>(x: T) => x;\nconst load = () => import("@/lib/accounting/pg-errors");`).map(rel),
    ).toEqual([target]);
    expect(
      importsOf(tsx, `const el = <div />;\nconst load = () => import("@/lib/accounting/pg-errors");`).map(rel),
    ).toEqual([target]);
    expect(() => importsOf(ts_, `const el = <div />;`)).toThrow(/does not parse as TS/);
  });
});
