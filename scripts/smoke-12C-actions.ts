import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

// NOTE: admin.ts imports "server-only" which throws outside Next.js server context.
// We inline the admin client here using the same env vars — behaviour is identical.
// Run via: npx tsx --env-file=.env.local scripts/smoke-12C-actions.ts
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function main() {
  const admin = createAdminClient();
  const { data: staff } = await admin
    .from("staff_profiles").select("id").eq("is_active", true).limit(1).single();
  const { data: shift } = await admin
    .from("cash_shifts").select("id").eq("code", "default").single();
  if (!staff || !shift) throw new Error("Need a staff_profile + default shift seeded");

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const { data, error } = await admin
    .from("eod_cash_adjustments")
    .insert({
      business_date: today,
      shift_id: shift.id,
      kind: "salary_advance",
      amount_php: 100,
      payee_staff_id: staff.id,
      recorded_by: staff.id,
    })
    .select("id")
    .single();
  if (error) throw error;

  const { data: je } = await admin
    .from("journal_entries").select("entry_number, status")
    .eq("source_kind", "cash_adjustment").eq("source_id", data.id).single();
  const { data: adv } = await admin
    .from("staff_advances").select("status, outstanding_balance_php")
    .eq("source_adjustment_id", data.id).single();
  console.log({ adjustment_id: data.id, je, advance: adv });

  // Cleanup
  await admin.from("eod_cash_adjustments").update({
    voided_at: new Date().toISOString(), voided_by: staff.id, void_reason: "tinker smoke",
  }).eq("id", data.id);
}

main().catch((e) => { console.error(e); process.exit(1); });
