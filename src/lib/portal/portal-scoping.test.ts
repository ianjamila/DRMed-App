import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// PR 9 (H2) guard — pure fs, no DB. Enforces that patient-portal pages read the
// database through the patient-scoped RLS client (src/lib/supabase/patient.ts)
// rather than the service-role admin client, so real row-level security backs
// portal reads. A new portal page that reaches for createAdminClient to read
// patient data — bypassing RLS — fails this test.
//
// The service-role client is legitimately needed in a few places RLS cannot
// serve, so it is allowlisted there (and only there):
//   - (authenticated)/actions.ts        Storage signed-URLs / .download() /
//                                        .remove(), the row DELETE, and audit.
//   - (authenticated)/data-export/route.ts  audit_log read (compliance ledger,
//                                        not patient-readable) + Storage download.
//   - login/actions.ts                  pre-auth (no patient identity yet).
// If you add a genuinely-required admin use, add the file here WITH a comment
// explaining why RLS can't serve it — don't widen it silently.

const PORTAL_DIR = join(process.cwd(), "src", "app", "(patient)", "portal");
const ADMIN_IMPORT = "@/lib/supabase/admin";
const PATIENT_IMPORT = "@/lib/supabase/patient";

// Relative-to-PORTAL_DIR posix paths, so the lists read the same on any OS.
const ADMIN_ALLOWLIST = new Set([
  "(authenticated)/actions.ts",
  "(authenticated)/data-export/route.ts",
  "login/actions.ts",
]);

// Files that read patient-scoped data and MUST go through the RLS client.
// Regression guard: reverting one of these to the admin client trips both this
// list and the allowlist check above.
const REQUIRE_PATIENT_CLIENT = [
  "(authenticated)/page.tsx",
  "(authenticated)/visits/[id]/page.tsx",
  "(authenticated)/data-export/route.ts",
  "(authenticated)/actions.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (full: string) => relative(PORTAL_DIR, full).split(sep).join("/");
const files = walk(PORTAL_DIR);

describe("patient portal RLS scoping", () => {
  it("has portal files to scan (guard against a bad glob)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports the service-role admin client only in allowlisted files", () => {
    const offenders = files
      .filter((f) => readFileSync(f, "utf8").includes(ADMIN_IMPORT))
      .map(rel)
      .filter((r) => !ADMIN_ALLOWLIST.has(r));
    expect(
      offenders,
      `These portal files import ${ADMIN_IMPORT} but aren't allowlisted. ` +
        `Patient reads must go through ${PATIENT_IMPORT} (RLS-backed). If the ` +
        `admin client is genuinely required (Storage/audit/pre-auth), add the ` +
        `file to ADMIN_ALLOWLIST with a justifying comment.`,
    ).toEqual([]);
  });

  it("reads patient data through the patient-scoped client in the migrated files", () => {
    for (const target of REQUIRE_PATIENT_CLIENT) {
      const full = files.find((f) => rel(f) === target);
      expect(full, `expected portal file to exist: ${target}`).toBeTruthy();
      const src = readFileSync(full!, "utf8");
      expect(
        src.includes(PATIENT_IMPORT),
        `${target} must import ${PATIENT_IMPORT} so its patient reads are RLS-backed.`,
      ).toBe(true);
    }
  });
});
