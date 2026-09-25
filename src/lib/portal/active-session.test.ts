import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 0167: portal access requires an ACTIVE patient record on every request.
// The bare cookie helper getPatientSession() only proves the cookie is
// signed; getActivePatientSession() also re-reads the record. Any code —
// anywhere in src/, not just under the portal route — that still called the
// bare helper directly would keep serving a deleted or merged record until
// its cookie expires. Scan the whole tree so a future caller (a new portal
// entry point, or an unrelated file that reaches for the cookie helper
// directly) can't slip past this the way a portal-folder-only scan would.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
// getPatientSession() is defined here and called, once, by
// getActivePatientSession() — the portal's only session check. Nothing else
// may call it bare. (Login mints the cookie; it never reads a session, so
// it holds no exemption here.)
const ALLOWED_BARE = new Set([
  "src/lib/auth/patient-session-cookies.ts",
  "src/lib/auth/require-patient.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const files = walk(SRC).map(rel);

describe("no code outside require-patient.ts calls the bare cookie helper", () => {
  it("scans src files (guards a broken walk)", () => expect(files.length).toBeGreaterThan(100));

  it("never calls the bare cookie helper", () => {
    const offenders = files.filter((f) => !ALLOWED_BARE.has(f))
      .filter((f) => /\bgetPatientSession\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders, "Use getActivePatientSession() or requirePatientProfile().").toEqual([]);
  });

  it("requirePatientProfile no longer follows the merge chain", () => {
    const src = readFileSync(join(ROOT, "src/lib/auth/require-patient.ts"), "utf8");
    expect(src).not.toMatch(/merged_into_id\)/);
    expect(src).toMatch(/export async function getActivePatientSession/);
    expect(src).toMatch(/activePatients\(/);
  });
});
