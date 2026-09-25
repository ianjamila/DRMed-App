import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_PRESETS } from "./presets";

const SRC = join(__dirname, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// Every string literal the code could write as an audit action — except the
// presets' own file, whose literals would otherwise vouch for themselves.
const PRESETS_FILE = join(__dirname, "presets.ts");
const literals = new Set<string>();
for (const file of walk(SRC).filter((f) => f !== PRESETS_FILE)) {
  for (const m of readFileSync(file, "utf8").matchAll(/"([a-z_]+\.[a-z_.]+)"/g)) {
    literals.add(m[1]!);
  }
}

describe("AUDIT_PRESETS", () => {
  it.each(AUDIT_PRESETS.map((p) => [p.label, p.action]))(
    "%s (%s) matches an action the code writes",
    (_label, action) => {
      expect([...literals].some((l) => l.startsWith(action))).toBe(true);
    },
  );

  it("has unique labels and actions", () => {
    expect(new Set(AUDIT_PRESETS.map((p) => p.label)).size).toBe(AUDIT_PRESETS.length);
    expect(new Set(AUDIT_PRESETS.map((p) => p.action)).size).toBe(AUDIT_PRESETS.length);
  });
});
