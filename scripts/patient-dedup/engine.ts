// scripts/patient-dedup/engine.ts
import "../lib/load-env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { activePatients } from "../../src/lib/patients/active";
import {
  CONFIRM_FLAG,
  expectedConfirmToken,
  requireLocalOrExplicitProd,
  requireTargetConfirmation,
} from "../lib/env-guard";
import { writeCsv } from "../clinical-backfill/report";
import { clusterByName } from "./lib/cluster";
import { planCluster } from "./lib/plan";
import type { PatientRow, ClusterPlan } from "./lib/types";
import { parseDedupArgs, type DedupArgs } from "./lib/args";
import { withLifecycleRetry } from "../../src/lib/patients/lifecycle-retry";

export function parseArgs(): DedupArgs {
  try {
    return parseDedupArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}

export function adminClient(): SupabaseClient<Database> {
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

export async function loadRows(admin: SupabaseClient<Database>): Promise<PatientRow[]> {
  const patients = await fetchAll(async (from, to) => {
    const { data, error } = await activePatients(
      admin
        .from("patients")
        .select("id, drm_id, first_name, last_name, middle_name, sex, phone, email, birthdate, address, created_at"),
    )
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
  // The dry-run reads live patient identities and dumps them to tmp/*.csv, so the
  // guard has to run before the first query — not only on the --commit path.
  requireLocalOrExplicitProd("dedup:patients", {
    readOnly: !args.commit,
    writes: args.commit
      ? "MERGES patient records through merge_patients_guarded (moves visits/appointments/results/consents/uploads, writes the undo ledger)"
      : "live patient identities (DRM-ID, name, DOB, phone) written to the tmp/ dedup CSVs",
  });
  // Merges are irreversible from the CLI, so --commit has to name the database
  // it is about to merge in — checked after the guard so the banner above has
  // already printed the project ref the operator needs to type.
  if (args.commit) requireTargetConfirmation("dedup:patients");

  const admin = adminClient();
  const rows = await loadRows(admin);
  console.log(`Loaded ${rows.length} live patients.`);

  const plans = clusterByName(rows).map(planCluster).filter((p) => p.auto.length + p.review.length > 0);
  summarize(plans);
  await writeReports(plans);

  if (!args.commit) {
    console.log(
      `\nDry-run. To commit against this target:\n` +
        `  npm run dedup:patients -- --commit --actor=<admin staff id> ${CONFIRM_FLAG}=${expectedConfirmToken()}` +
        `${process.argv.includes("--prod") ? " --prod" : ""}\n` +
        `\n${CONFIRM_FLAG} names the database above — it changes with the target.\n` +
        `--actor is recorded on every merge (audit log + undo ledger); it must be an active admin.\n`,
    );
    return;
  }

  await commitMerges(admin, plans, args.actor!); // non-null: --commit requires --actor (parseDedupArgs)
}

// One merge = one merge_patients_guarded call (0196): every move, the fill,
// chain flattening, the tombstone, the undo ledger and the audit row commit
// together or not at all, recorded against `actor`. CLI merges are therefore
// undoable from Admin Tools › Possible duplicates for 30 days.
export async function mergeOne(
  admin: SupabaseClient<Database>,
  canonical: PatientRow,
  source: PatientRow,
  tier: string,
  actor: string,
): Promise<"merged" | "skipped"> {
  const { error } = await withLifecycleRetry(() =>
    admin.rpc("merge_patients_guarded", {
      p_keep: canonical.id,
      p_source: source.id,
      p_actor: actor,
      p_context: { source: "dedup-cli", tier },
    }),
  );
  if (!error) return "merged";
  // P0058: either record is no longer active — already merged by an earlier
  // run of this plan, or deleted since the CSV was built. Re-run safe.
  if (error.code === "P0058") {
    console.log(`skip: ${source.drm_id} → ${canonical.drm_id}: ${error.message}`);
    return "skipped";
  }
  throw new Error(`merge ${source.drm_id} → ${canonical.drm_id}: ${error.message}`);
}

async function commitMerges(admin: SupabaseClient<Database>, plans: ClusterPlan[], actor: string): Promise<void> {
  let merged = 0;
  let skipped = 0;
  for (const plan of plans) {
    for (const m of plan.auto) {
      if ((await mergeOne(admin, plan.canonical, m.row, m.tier, actor)) === "merged") merged++;
      else skipped++;
    }
  }
  console.log(`\nCommitted ${merged} merge(s), skipped ${skipped}. Review pile left untouched (manual via admin UI).`);
}
