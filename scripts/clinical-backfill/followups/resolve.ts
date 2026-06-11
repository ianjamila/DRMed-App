// scripts/clinical-backfill/followups/resolve.ts
//
// Phase 1 of applying the clinic-partner's ambiguous-cluster decisions: perform
// the SAME-cluster patient merges. DISTINCT/SKIP need no merge here — their held
// rows are routed at import time by the engine's `--resolutions` override.
//
// Flow:
//   1. worksheet.ts  → partner fills clinical-cluster-resolutions.csv
//   2. resolve.ts --commit --confirm --prod   ← merges duplicates (this file)
//   3. backfill:clinical:{lab,consult} --commit --resolutions=<file> --prod
//      ← imports the 439 held rows (single-match for SAME, override for DISTINCT)
//
// Merges reuse the audited dedup primitive (scripts/patient-dedup mergeOne), so
// FK reassignment + tombstoning + audit_log are identical to the dedup pass.
//
// Run (dry-run):  tsx --env-file=.env.local scripts/clinical-backfill/followups/resolve.ts --file=<path>
// Run (commit):   ... --file=<path> --commit --confirm="I-mean-it" --prod
import { promises as fs } from "node:fs";
import { requireLocalOrExplicitProd } from "../../lib/env-guard";
import { adminClient, loadRows, mergeOne } from "../../patient-dedup/engine";
import type { PatientRow } from "../../patient-dedup/lib/types";
import { matchKey } from "../lib/names";
import { parseResolutions } from "./resolutions";

interface Args { file: string; commit: boolean; confirmed: boolean; }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => a.startsWith("--file="))?.substring(7) ?? "";
  if (!file) { console.error("--file=<resolutions.csv> is required."); process.exit(2); }
  return {
    file,
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { resolutions, errors } = parseResolutions(await fs.readFile(args.file, "utf8"));
  if (errors.length) { console.error("Resolution file errors:\n  " + errors.join("\n  ")); process.exit(4); }

  const admin = adminClient();
  const live = await loadRows(admin); // merged_into_id IS NULL only
  const byDrm = new Map<string, PatientRow>(live.map((p) => [p.drm_id, p]));
  const byKey = new Map<string, PatientRow[]>();
  for (const p of live) {
    const k = matchKey(p.last_name ?? "", p.first_name ?? "");
    if (!k) continue;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(p);
  }

  // Plan the merges (and validate) without touching the DB.
  interface MergePlan { clusterKey: string; target: PatientRow; sources: PatientRow[]; }
  const plans: MergePlan[] = [];
  const planErrors: string[] = [];
  let nSame = 0, nDistinct = 0, nSkip = 0;
  for (const res of resolutions) {
    if (res.decision === "SKIP") { nSkip++; continue; }
    if (res.decision === "DISTINCT") { nDistinct++; continue; }
    nSame++;
    const target = byDrm.get(res.targetDrm);
    if (!target) { planErrors.push(`${res.clusterKey}: SAME target ${res.targetDrm} is not a live patient (already merged?)`); continue; }
    if (matchKey(target.last_name ?? "", target.first_name ?? "") !== res.clusterKey)
      planErrors.push(`${res.clusterKey}: target ${res.targetDrm} belongs to a different name-cluster`);
    const members = byKey.get(res.clusterKey) ?? [];
    const sources = members.filter((m) => m.id !== target.id);
    plans.push({ clusterKey: res.clusterKey, target, sources });
  }
  if (planErrors.length) { console.error("Plan errors:\n  " + planErrors.join("\n  ")); process.exit(4); }

  const totalMerges = plans.reduce((n, p) => n + p.sources.length, 0);
  console.log(`Decisions: SAME ${nSame}, DISTINCT ${nDistinct} (no merge), SKIP ${nSkip}`);
  console.log(`SAME merges to perform: ${totalMerges} source(s) across ${plans.length} cluster(s)`);
  for (const p of plans) {
    console.log(`  ${p.clusterKey}: keep ${p.target.drm_id} <- ${p.sources.map((s) => s.drm_id).join(", ") || "(none — already merged)"}`);
  }

  if (!args.commit) {
    console.log(`\nDry-run. To merge: ... --file=${args.file} --commit --confirm="I-mean-it" --prod`);
    console.log(`Then import held rows: npm run backfill:clinical:lab -- --commit --confirm="I-mean-it" --resolutions=${args.file} --prod (and :consult)`);
    return;
  }
  if (!args.confirmed) { console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3); }
  requireLocalOrExplicitProd("clinical-backfill:resolve-merges");

  let merged = 0;
  for (const p of plans) {
    for (const s of p.sources) {
      await mergeOne(admin, p.target, s, "partner-resolution");
      merged++;
      console.log(`  merged ${s.drm_id} -> ${p.target.drm_id}`);
    }
  }
  console.log(`\nMerge complete: ${merged} merged. Next: import held rows with --resolutions=${args.file}.`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
