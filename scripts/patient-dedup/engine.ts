// scripts/patient-dedup/engine.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { writeCsv } from "../clinical-backfill/report";
import { clusterByName } from "./lib/cluster";
import { planCluster } from "./lib/plan";
import type { PatientRow, ClusterPlan } from "./lib/types";

interface Args { commit: boolean; confirmed: boolean; }
export function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
  };
}

function adminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required."); process.exit(2); }
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function fetchAll<T>(q: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []; let from = 0; const page = 1000;
  for (;;) { const b = await q(from, from + page - 1); out.push(...b); if (b.length < page) break; from += page; }
  return out;
}

async function loadRows(admin: SupabaseClient<Database>): Promise<PatientRow[]> {
  const patients = await fetchAll(async (from, to) => {
    const { data, error } = await admin
      .from("patients")
      .select("id, drm_id, first_name, last_name, middle_name, sex, phone, email, birthdate, address, created_at")
      .is("merged_into_id", null)
      .order("id")
      .range(from, to);
    if (error) throw new Error(`load patients: ${error.message}`);
    return data ?? [];
  });

  // Visit counts: fetch all visit patient_ids and tally in JS (no group-by in the JS client).
  const visitRows = await fetchAll(async (from, to) => {
    const { data, error } = await admin.from("visits").select("patient_id").order("id").range(from, to);
    if (error) throw new Error(`load visits: ${error.message}`);
    return data ?? [];
  });
  const counts = new Map<string, number>();
  for (const v of visitRows) {
    if (v.patient_id) counts.set(v.patient_id, (counts.get(v.patient_id) ?? 0) + 1);
  }

  return patients.map((p) => ({ ...p, visit_count: counts.get(p.id) ?? 0 }));
}

function summarize(plans: ClusterPlan[]): void {
  const clusters = plans.length;
  const autoMerges = plans.reduce((n, p) => n + p.auto.length, 0);
  const reviews = plans.reduce((n, p) => n + p.review.length, 0);
  const byTier: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const p of plans) {
    for (const a of p.auto) byTier[a.tier] = (byTier[a.tier] ?? 0) + 1;
    for (const r of p.review) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  console.log(`\nClusters with duplicates: ${clusters}`);
  console.log(`Auto-merge sources:       ${autoMerges}`, byTier);
  console.log(`Review sources:           ${reviews}`, byReason);
}

async function writeReports(plans: ClusterPlan[]): Promise<void> {
  const autoRows: string[][] = [];
  const reviewRows: string[][] = [];
  for (const p of plans) {
    for (const a of p.auto) {
      autoRows.push([p.canonical.drm_id, p.canonical.id, a.row.drm_id, a.row.id, a.tier,
        `${a.row.last_name ?? ""}, ${a.row.first_name ?? ""}`, a.row.birthdate ?? "", a.row.phone ?? ""]);
    }
    for (const r of p.review) {
      reviewRows.push([p.canonical.drm_id, p.canonical.id, r.row.drm_id, r.row.id, r.reason,
        `${r.row.last_name ?? ""}, ${r.row.first_name ?? ""}`, r.row.birthdate ?? "", r.row.phone ?? ""]);
    }
  }
  const head = ["keep_drm", "keep_id", "source_drm", "source_id", "tier_or_reason", "source_name", "source_dob", "source_phone"];
  const autoPath = await writeCsv("patient-dedup-auto-plan", head, autoRows);
  const reviewPath = await writeCsv("patient-dedup-review", head, reviewRows);
  console.log(`\nAuto-merge plan: ${autoPath}`);
  console.log(`Review pile:     ${reviewPath}`);
}

export async function run(): Promise<void> {
  const args = parseArgs();
  if (args.commit && !args.confirmed) {
    console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3);
  }
  if (args.commit) requireLocalOrExplicitProd("dedup:patients");

  const admin = adminClient();
  const rows = await loadRows(admin);
  console.log(`Loaded ${rows.length} live patients.`);

  const plans = clusterByName(rows).map(planCluster).filter((p) => p.auto.length + p.review.length > 0);
  summarize(plans);
  await writeReports(plans);

  if (!args.commit) {
    console.log(`\nDry-run. To commit against prod: npm run dedup:patients -- --commit --confirm="I-mean-it" --prod\n`);
    return;
  }

  await commitMerges(admin, plans); // implemented in Task 5
}

// --- commit path (Task 5 fills this in) ---
async function commitMerges(_admin: SupabaseClient<Database>, _plans: ClusterPlan[]): Promise<void> {
  throw new Error("commitMerges not implemented yet");
}
