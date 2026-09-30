// A "use server" module may export only async functions (Next's server-action
// compiler turns every export into an action reference). Type DECLARATIONS
// (`export type X = …`, `export interface`) are erased and fine, but a
// re-export list — even `export type { X }` — is compiled as a value export:
// the module then throws `ReferenceError: X is not defined` when the action
// loader evaluates it, so every action in the file 500s at runtime while
// typecheck and unit tests stay green. That shipped once on this branch
// (visits/[id]/actions.ts re-exporting ReleaseMedium) and was caught only in
// the browser. This guard makes it a test failure instead.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** True when the module's first statement is the "use server" directive. */
function isUseServerModule(text: string): boolean {
  const body = text.replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, "");
  return /^["']use server["'];?/.test(body);
}

// Anything exported that is not `export async function` or a type declaration.
const FORBIDDEN = /^export\s+(\{|type\s*\{|\*|const\s|let\s|var\s|class\s|default\s|function\s)/m;

function offendingExports(text: string): string[] {
  return text.split("\n").filter((line) => FORBIDDEN.test(line));
}

describe('"use server" modules export only async functions', () => {
  it("flags a type re-export list and non-async exports", () => {
    expect(offendingExports('export type { ReleaseMedium };')).toHaveLength(1);
    expect(offendingExports('export { foo };\nexport const X = 1;')).toHaveLength(2);
    expect(offendingExports("export function f() {}")).toHaveLength(1);
  });

  it("allows async functions and type declarations", () => {
    const ok = [
      "export async function a() {}",
      "export type R = { ok: true };",
      "export interface I { a: string }",
    ].join("\n");
    expect(offendingExports(ok)).toEqual([]);
  });

  it("detects the directive after a leading comment", () => {
    expect(isUseServerModule('// header\n/* more */\n"use server";\n')).toBe(true);
    expect(isUseServerModule('import x from "y";\n"use server";')).toBe(false);
  });

  it("holds for every use-server module under src/", () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      if (!isUseServerModule(text)) continue;
      for (const line of offendingExports(text)) bad.push(`${relative(SRC, file)}: ${line.trim()}`);
    }
    expect(bad).toEqual([]);
  });
});
