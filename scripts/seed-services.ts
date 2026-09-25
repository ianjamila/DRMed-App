/**
 * Seeds a baseline service catalog so /services has real content before
 * Phase 4 ships the admin UI. Idempotent — upserts by `code`.
 *
 *   npm run seed:services
 *
 * Replace prices to match the actual lab list whenever ready.
 */
import "./lib/load-env";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { SEED_SERVICES as services } from "./lib/seed-services-catalog";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

requireLocalOrExplicitProd("seed:services", {
  writes: "upserts `services` rows by code — names, prices, turnaround, kind, section",
});

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log(`Seeding ${services.length} services...`);
  const { error } = await admin
    .from("services")
    .upsert(services, { onConflict: "code" });
  if (error) {
    console.error("upsert services failed", error);
    process.exit(1);
  }
  console.log("✓ Done. Services upserted (idempotent).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
