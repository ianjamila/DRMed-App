import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Pure fs guard, like portal-scoping.test.ts. The portal layout's consent gate
// covers neither Server Actions / route handlers (the layout never runs for
// them) nor a page reached by client-side navigation (layouts don't re-render,
// and render in parallel with the page). So every entry point under
// (authenticated) repeats the check itself — see src/lib/portal/consent-guard.ts.
// A new page, route or action that forgets it fails here.

const AUTH_DIR = join(process.cwd(), "src", "app", "(patient)", "portal", "(authenticated)");
const GUARD = "portalConsentCurrent(";

// Relative-to-AUTH_DIR posix paths. Each exemption carries its reason.
const EXEMPT_PAGES: Record<string, string> = {
  "help/page.tsx": "static help text; reads no patient data",
};
const EXEMPT_ACTIONS: Record<string, string> = {
  deletePatientLabRequestUpload:
    "removing their own upload shrinks what the clinic holds — what withdrawal asks for",
  logPatientStatementPrintAction:
    "records a print that already happened; refusing it loses the audit row, not the disclosure",
};

// Reads/disclosures the guard must come BEFORE, wherever they appear.
const DISCLOSURES = [
  "createPatientClient(",
  "fetchStatement(",
  "auditPatientStatement(",
  "loadResults(",
  "createSignedUrl(",
  "sendStatementEmail(",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (full: string) => relative(AUTH_DIR, full).split(sep).join("/");
const files = walk(AUTH_DIR).map((full) => ({ path: rel(full), src: readFileSync(full, "utf8") }));

/** Source after the first match of `start`, so imports never count. */
function after(src: string, start: RegExp): string {
  const m = start.exec(src);
  return m ? src.slice(m.index) : "";
}

/** Guard present and ahead of every disclosure in `body`. */
function guardProblems(body: string): string | null {
  const at = body.indexOf(GUARD);
  if (at === -1) return "no consent check";
  for (const d of DISCLOSURES) {
    const i = body.indexOf(d);
    if (i !== -1 && i < at) return `${d} runs before the consent check`;
  }
  return null;
}

/** `export async function name(...)` bodies of a "use server" file. */
function actionBodies(src: string): { name: string; body: string }[] {
  const re = /^export async function (\w+)\(/gm;
  const starts = [...src.matchAll(re)];
  return starts.map((m, i) => ({
    name: m[1]!,
    body: src.slice(m.index, starts[i + 1]?.index ?? src.length),
  }));
}

const pages = files.filter((f) => f.path.endsWith("page.tsx"));
const routes = files.filter((f) => f.path.endsWith("route.ts"));
const actionFiles = files.filter((f) => /^\s*["']use server["']/.test(f.src));

describe("portal consent guard", () => {
  it("finds the portal's pages, routes and actions (guard against a bad glob)", () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(actionFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("layout uses the same guard", () => {
    const layout = files.find((f) => f.path === "layout.tsx");
    expect(layout?.src).toContain(GUARD);
  });

  it("every page checks consent before it reads or audits anything", () => {
    const problems = pages
      .filter((p) => !(p.path in EXEMPT_PAGES))
      .map((p) => [p.path, guardProblems(after(p.src, /^export default async function/m))])
      .filter(([, why]) => why !== null);
    expect(problems).toEqual([]);
  });

  it("every route handler checks consent first", () => {
    const problems = routes
      .map((r) => [r.path, guardProblems(after(r.src, /^export async function (GET|POST)/m))])
      .filter(([, why]) => why !== null);
    expect(problems).toEqual([]);
  });

  it("every Server Action checks consent first, unless exempted with a reason", () => {
    const problems = actionFiles.flatMap((f) =>
      actionBodies(f.src)
        .filter((a) => !(a.name in EXEMPT_ACTIONS))
        .map((a) => [`${f.path}#${a.name}`, guardProblems(a.body)])
        .filter(([, why]) => why !== null),
    );
    expect(problems).toEqual([]);
  });

  it("exempt pages and actions still exist (no stale exemptions)", () => {
    for (const p of Object.keys(EXEMPT_PAGES)) {
      expect(pages.map((x) => x.path)).toContain(p);
    }
    const names = actionFiles.flatMap((f) => actionBodies(f.src).map((a) => a.name));
    for (const a of Object.keys(EXEMPT_ACTIONS)) expect(names).toContain(a);
  });

  it("exempt actions really skip the check (an exemption is not a silent pass)", () => {
    for (const f of actionFiles) {
      for (const a of actionBodies(f.src)) {
        if (a.name in EXEMPT_ACTIONS) expect(a.body).not.toContain(GUARD);
      }
    }
  });
});
