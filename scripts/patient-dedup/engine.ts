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

// Tables that carry patients(id) FKs — ALL of them. The admin merge Server Action
// currently misses critical_alerts + patient_consents; this pass must not.
const FK_TABLES = ["visits", "appointments", "audit_log", "critical_alerts", "patient_consents"] as const;
const FILL_FIELDS = ["middle_name", "sex", "phone", "email", "address", "birthdate"] as const;

export async function mergeOne(
  admin: SupabaseClient<Database>,
  canonical: PatientRow,
  source: PatientRow,
  tier: string,
): Promise<void> {
  // Idempotent: skip a source already tombstoned (re-run safe).
  const { data: cur, error: curErr } = await admin
    .from("patients").select("merged_into_id").eq("id", source.id).maybeSingle();
  if (curErr) throw new Error(`recheck ${source.id}: ${curErr.message}`);
  if (!cur || cur.merged_into_id) return;

  // 1. Reassign every patient_id FK. `as never` because the payload type differs
  //    per table in the generated union; patient_id is uuid on all of them.
  const moved: Record<string, number> = {};
  for (const table of FK_TABLES) {
    const { data, error } = await admin.from(table)
      .update({ patient_id: canonical.id } as never)
      .eq("patient_id", source.id)
      .select("id");
    if (error) throw new Error(`reassign ${table} (${source.drm_id}): ${error.message}`);
    moved[table] = data?.length ?? 0;
  }

  // 2. Collapse any existing tombstone chain pointing at the source.
  const { error: chainErr } = await admin.from("patients")
    .update({ merged_into_id: canonical.id })
    .eq("merged_into_id", source.id);
  if (chainErr) throw new Error(`repoint chain (${source.drm_id}): ${chainErr.message}`);

  // 3. Fill missing fields on the canonical from the source — never overwrite.
  const fill: Record<string, string> = {};
  for (const f of FILL_FIELDS) {
    if (!canonical[f] && source[f]) fill[f] = source[f] as string;
  }
  if (Object.keys(fill).length > 0) {
    const { error } = await admin.from("patients").update(fill as never).eq("id", canonical.id);
    if (error) throw new Error(`fill canonical (${canonical.drm_id}): ${error.message}`);
    Object.assign(canonical, fill); // keep in-memory canonical current for the next source in the cluster
  }

  // 4. Tombstone the source.
  const { error: tombErr } = await admin.from("patients")
    .update({ merged_into_id: canonical.id, merged_at: new Date().toISOString() })
    .eq("id", source.id);
  if (tombErr) throw new Error(`tombstone (${source.drm_id}): ${tombErr.message}`);

  // 5. Audit (audit() is server-only, so insert directly with the AuditEntry shape).
  const { error: auditErr } = await admin.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    patient_id: canonical.id,
    action: "patient.merged",
    resource_type: "patient",
    resource_id: canonical.id,
    metadata: { kept_drm_id: canonical.drm_id, merged_drm_id: source.drm_id, merged_patient_id: source.id, tier, moved },
    ip_address: null,
    user_agent: null,
  });
  if (auditErr) throw new Error(`audit (${source.drm_id}): ${auditErr.message}`);
}

async function commitMerges(admin: SupabaseClient<Database>, plans: ClusterPlan[]): Promise<void> {
  let merged = 0;
  for (const plan of plans) {
    for (const m of plan.auto) {
      await mergeOne(admin, plan.canonical, m.row, m.tier);
      merged++;
    }
  }
  console.log(`\nCommitted ${merged} merge(s). Review pile left untouched (manual via admin UI).`);
}
