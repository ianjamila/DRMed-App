// scripts/clinical-backfill/followups/repoint-services.ts
//
// Re-point the SAFE-AUTO unmapped lab rows from the generic LEGACY-LAB shell to
// their real catalog service. Matches by the remark the importer stamped
// ("legacy service: <NAME>") on rows still pinned to LEGACY-LAB.
//
// Only `service_id` (an FK) changes — base/final/discount/clinic_fee are untouched,
// so the ops P&L does not move; and because these rows carry legacy_import_run_id,
// the 0091 guard keeps the GL bridge silent. Idempotent: a re-run finds 0 (rows
// are no longer on LEGACY-LAB).
//
// Run (dry-run): tsx --env-file=.env.local scripts/clinical-backfill/followups/repoint-services.ts
// Run (commit):  ... --commit --confirm="I-mean-it" --prod
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/types/database";
import { requireLocalOrExplicitProd } from "../../lib/env-guard";
import { SAFE_AUTO } from "./service-aliases";

interface Args { commit: boolean; confirmed: boolean; }
function parseArgs(): Args {
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

async function main(): Promise<void> {
  const args = parseArgs();
  const admin = adminClient();

  // resolve LEGACY-LAB + every safe-auto target code to a service_id
  const { data: svc, error: svcErr } = await admin.from("services").select("id,code,name");
  if (svcErr || !svc) throw new Error(`load services: ${svcErr?.message}`);
  const idByCode = new Map(svc.map((s) => [s.code, s.id]));
  const nameById = new Map(svc.map((s) => [s.id, s.name]));
  const legacyId = idByCode.get("LEGACY-LAB");
  if (!legacyId) throw new Error("LEGACY-LAB service not found");

  const targets = new Map<string, { code: string; id: string }>();
  const missing: string[] = [];
  for (const [legacyName, code] of Object.entries(SAFE_AUTO)) {
    const id = idByCode.get(code);
    if (!id) { missing.push(`${legacyName} -> ${code}`); continue; }
    targets.set(legacyName, { code, id });
  }
  if (missing.length) { console.error("Target codes not in catalog:\n  " + missing.join("\n  ")); process.exit(4); }

  // count current LEGACY-LAB rows per safe-auto remark
  console.log(`SAFE-AUTO aliases: ${targets.size}`);
  let total = 0;
  const plan: { name: string; code: string; id: string; n: number }[] = [];
  for (const [legacyName, t] of targets) {
    const { count, error } = await admin.from("test_requests")
      .select("id", { count: "exact", head: true })
      .eq("service_id", legacyId)
      .eq("receptionist_remarks", `legacy service: ${legacyName}`);
    if (error) throw new Error(`count ${legacyName}: ${error.message}`);
    const n = count ?? 0;
    plan.push({ name: legacyName, code: t.code, id: t.id, n });
    total += n;
  }
  for (const p of plan.sort((a, b) => b.n - a.n))
    console.log(`  ${String(p.n).padStart(4)}  ${p.name}  ->  ${p.code} (${nameById.get(p.id)})`);
  const { count: legacyTotal } = await admin.from("test_requests")
    .select("id", { count: "exact", head: true }).eq("service_id", legacyId);
  console.log(`\nRows to re-point: ${total} (of ${legacyTotal ?? "?"} currently on LEGACY-LAB)`);

  if (!args.commit) {
    console.log(`\nDry-run. To re-point: ... --commit --confirm="I-mean-it" --prod`);
    return;
  }
  if (!args.confirmed) { console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3); }
  requireLocalOrExplicitProd("clinical-backfill:repoint-services");

  let moved = 0;
  const byAlias: Record<string, number> = {};
  for (const p of plan) {
    if (p.n === 0) continue;
    const { data, error } = await admin.from("test_requests")
      .update({ service_id: p.id })
      .eq("service_id", legacyId)
      .eq("receptionist_remarks", `legacy service: ${p.name}`)
      .select("id");
    if (error) throw new Error(`re-point ${p.name}: ${error.message}`);
    const n = data?.length ?? 0;
    byAlias[p.name] = n; moved += n;
    console.log(`  re-pointed ${String(n).padStart(4)}  ${p.name} -> ${p.code}`);
  }

  // one audit row for the whole bulk categorization fix
  const { error: auditErr } = await admin.from("audit_log").insert({
    actor_id: null, actor_type: "system",
    action: "service.repoint_legacy",
    resource_type: "test_requests", resource_id: legacyId,
    metadata: { operation: "clinical-backfill followup: unmapped safe-auto re-point", total_moved: moved, by_alias: byAlias },
    ip_address: null, user_agent: null,
  });
  if (auditErr) throw new Error(`audit: ${auditErr.message}`);

  console.log(`\nRe-point complete: ${moved} test_requests moved off LEGACY-LAB. Audit row written.`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
