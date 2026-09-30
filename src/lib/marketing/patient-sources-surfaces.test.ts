/**
 * Spec §5 "Equality": Booking Sources, Patient Sources, the dashboard tile and
 * the CSV header must show the same numbers. They do by construction if every
 * surface reads the report RPCs through the ONE loader module — this pins it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const RPCS = [
  "patient_sources_summary", "patient_sources_series", "patient_sources_revenue", "patient_sources_overlaps",
  "patient_sources_referrers", "patient_sources_people", "ad_spend_daily_totals", "ad_spend_coverage",
  "ad_spend_import", "ad_spend_delete",
];
const CALLERS: Record<string, string> = {
  "src/lib/marketing/patient-sources.server.ts": "the loader module",
  "src/app/(staff)/staff/(dashboard)/marketing/ad-spend-actions.ts": "the two ad-spend write actions",
  "src/types/database.ts": "generated types",
};
const S = "src/app/(staff)/staff/(dashboard)";
const SURFACES: Record<string, string> = {
  [`${S}/marketing/patients/page.tsx`]: "loadPatientSourcesSummary",
  [`${S}/marketing/sources/page.tsx`]: "loadPatientSourcesSummary",
  [`${S}/_dashboards/admin-dashboard.tsx`]: "loadNewPatientsToday",
  ["src/app/api/admin/reports/patient-sources.csv/route.ts"]: "loadPatientSourcesSummary",
  ["src/app/api/admin/reports/patient-sources-people.csv/route.ts"]: "loadAllPeople",
  [`${S}/marketing/patients/people/page.tsx`]: "loadPeoplePage",
};

// The people CSV route's own audit action is named, by design (P12), exactly
// like the RPC it does NOT call directly: `report: "patient_sources_people"`.
// Stripping only that one known literal — never the whole file — keeps the
// route OUT of CALLERS, so a real `.rpc("patient_sources_people", …)` added to
// it later still trips the offender scan below.
const AUDIT_KEY_EXCEPTION: [string, RegExp] = [
  "src/app/api/admin/reports/patient-sources-people.csv/route.ts",
  /report:\s*["']patient_sources_people["']/g,
];
function scanText(file: string, src: string): string {
  const [exceptionFile, pattern] = AUDIT_KEY_EXCEPTION;
  return file === exceptionFile ? src.replace(pattern, "") : src;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

describe("Patient Sources has one definition and one caller", () => {
  it("only the loader module and the ad-spend actions name the report RPCs", () => {
    const offenders = walk(join(ROOT, "src"))
      .map(rel)
      .filter((f) => !(f in CALLERS) && !f.endsWith(".test.ts"))
      .filter((f) => {
        const src = scanText(f, readFileSync(join(ROOT, f), "utf8"));
        return RPCS.some((r) => [`"${r}"`, `'${r}'`, "`" + r + "`"].some((q) => src.includes(q)));
      });
    expect(offenders).toEqual([]);
  });
  it("every summary surface reads through the shared loader", () => {
    for (const [file, loader] of Object.entries(SURFACES)) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, file).toContain("@/lib/marketing/patient-sources.server");
      expect(src, file).toContain(`${loader}(`);
    }
  });
  it("guards itself: the loader really calls the summary RPC", () => {
    expect(readFileSync(join(ROOT, "src/lib/marketing/patient-sources.server.ts"), "utf8")).toContain('"patient_sources_summary"');
  });
});


/**
 * The first-night check proves the surfaces agree, so it must read numbers the
 * way they do: the same loaders, the same formatters, never `.rpc(` of its own.
 */
describe("the first-night check reads exactly like the surfaces", () => {
  const CHECK_FILES = ["src/lib/marketing/first-night-check.ts", "src/lib/marketing/first-night-check.server.ts"];
  const engine = readFileSync(join(ROOT, "src/lib/marketing/first-night-check.server.ts"), "utf8");

  it("never calls .rpc( or names a report RPC", () => {
    for (const file of CHECK_FILES) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, file).not.toContain(".rpc(");
      for (const r of RPCS) expect(src, `${file} names ${r}`).not.toMatch(new RegExp(`["'\`]${r}["'\`]`));
    }
  });
  it("uses the same three loaders as the Patient Sources page, Booking Sources page and dashboard", () => {
    expect(engine).toContain('from "./patient-sources.server"');
    for (const loader of ["loadPatientSourcesSummary", "loadPatientSourcesSeries", "loadNewPatientsToday"]) {
      expect(engine, loader).toContain(`${loader}`);
    }
    // ...and the pages it reproduces still read through those very loaders.
    expect(readFileSync(join(ROOT, `${S}/marketing/sources/page.tsx`), "utf8")).toContain("loadPatientSourcesSummary(");
    expect(readFileSync(join(ROOT, `${S}/_dashboards/admin-dashboard.tsx`), "utf8")).toContain("loadNewPatientsToday(");
  });
  it("uses the surfaces' own formatters (dashboard tile, Booking Sources tile, Patient Sources card)", () => {
    expect(engine).toContain("formatNewToday(");
    expect(engine).toContain("newPatientsTile(");
    const pure = readFileSync(join(ROOT, CHECK_FILES[0]), "utf8");
    expect(pure).toContain("formatNewCounts(");
    expect(readFileSync(join(ROOT, `${S}/marketing/patients/page.tsx`), "utf8")).toContain("formatNewCounts(");
    expect(readFileSync(join(ROOT, `${S}/marketing/sources/page.tsx`), "utf8")).toContain("newPatientsTile(");
    expect(readFileSync(join(ROOT, `${S}/_dashboards/admin-dashboard.tsx`), "utf8")).toContain("formatNewToday(");
  });
});
