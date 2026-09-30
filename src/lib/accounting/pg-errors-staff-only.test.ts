import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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

// Static imports, re-exports, side-effect imports and dynamic import(). Type-only
// imports are skipped: they are erased at build time and carry no runtime code.
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?!type\s)(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string, text = readFileSync(file, "utf8")): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const r = resolveSpecifier(file, (m[1] ?? m[2])!);
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
});
