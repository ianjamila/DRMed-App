/**
 * Seeds the eleven HMO providers reception is using as of mid-2026, lifted
 * from the live ops Sheet's "HMO contract management" tab. Idempotent:
 * upserts on `name`. Admin can extend / edit via /staff/admin/hmo-providers
 * after this runs.
 *
 *   npm run seed:hmo
 */
import { createClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

requireLocalOrExplicitProd("seed:hmo");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PROVIDERS: TablesInsert<"hmo_providers">[] = [
  { name: "Maxicare", is_active: true, due_days_for_invoice: 30 },
  { name: "Intellicare", is_active: true, due_days_for_invoice: 30 },
  { name: "Etiqa", is_active: true, due_days_for_invoice: 30 },
  { name: "Avega", is_active: true, due_days_for_invoice: 30 },
  { name: "Valucare", is_active: true, due_days_for_invoice: 30 },
  { name: "iCare", is_active: true, due_days_for_invoice: 30 },
  { name: "Cocolife", is_active: true, due_days_for_invoice: 30 },
  { name: "Med Asia", is_active: true, due_days_for_invoice: 30 },
  { name: "Generali", is_active: true, due_days_for_invoice: 30 },
  { name: "Amaphil", is_active: true, due_days_for_invoice: 30 },
  { name: "Pacific Cross", is_active: true, due_days_for_invoice: 30 },
];

async function main() {
  console.log("Seeding HMO providers…");
  const { error } = await admin
    .from("hmo_providers")
    .upsert(PROVIDERS, { onConflict: "name", ignoreDuplicates: false });
  if (error) throw new Error(`upsert failed: ${error.message}`);
  console.log(`✓ ${PROVIDERS.length} providers seeded`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
