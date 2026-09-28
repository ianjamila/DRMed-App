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
  // Not an RPC call: its audit action is literally named "patient_sources_people"
  // (P12), which happens to string-match the RPC of the same name. The route
  // only calls the RPC through loadAllPeople() (patient-sources.server.ts).
  "src/app/api/admin/reports/patient-sources-people.csv/route.ts": "the people CSV route's audit action name collides with the RPC name",
};
const S = "src/app/(staff)/staff/(dashboard)";
const SURFACES: Record<string, string> = {
  [`${S}/marketing/patients/page.tsx`]: "loadPatientSourcesSummary",
  [`${S}/marketing/sources/page.tsx`]: "loadPatientSourcesSummary",
  [`${S}/_dashboards/admin-dashboard.tsx`]: "loadNewPatientsToday",
  ["src/app/api/admin/reports/patient-sources.csv/route.ts"]: "loadPatientSourcesSummary",
};

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
        const src = readFileSync(join(ROOT, f), "utf8");
        return RPCS.some((r) => src.includes(`"${r}"`) || src.includes(`'${r}'`));
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
