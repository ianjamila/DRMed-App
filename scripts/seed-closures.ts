/**
 * Seeds Philippine public holidays into clinic_closures so the booking slot
 * picker greys them out. Idempotent — upserts on closed_on (the primary key).
 *
 *   npm run seed:closures
 *
 * Movable feast dates (Maundy Thursday, Good Friday, Black Saturday, Eid'l
 * Fitr, Eid'l Adha, Chinese New Year) shift each year per the annual
 * Malacañang Proclamation. Confirm them against the official proclamation
 * before adding. This seed only includes fixed-date holidays and a few
 * movable ones that have already been proclaimed for 2026; the admin
 * Closures page (/staff/admin/closures) is the canonical way to add the rest.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface ClosureSeed {
  closed_on: string; // YYYY-MM-DD, Asia/Manila
  reason: string;
}

const closures: ClosureSeed[] = [
  // 2026
  { closed_on: "2026-06-12", reason: "Independence Day" },
  { closed_on: "2026-08-21", reason: "Ninoy Aquino Day" },
  { closed_on: "2026-08-31", reason: "National Heroes Day" },
  { closed_on: "2026-11-01", reason: "All Saints' Day" },
  { closed_on: "2026-11-02", reason: "All Souls' Day (special non-working)" },
  { closed_on: "2026-11-30", reason: "Bonifacio Day" },
  { closed_on: "2026-12-08", reason: "Feast of the Immaculate Conception" },
  { closed_on: "2026-12-24", reason: "Christmas Eve (special non-working)" },
  { closed_on: "2026-12-25", reason: "Christmas Day" },
  { closed_on: "2026-12-30", reason: "Rizal Day" },
  { closed_on: "2026-12-31", reason: "New Year's Eve (special non-working)" },

  // 2027 (fixed dates only — movable holidays must be added once the annual
  // proclamation is published)
  { closed_on: "2027-01-01", reason: "New Year's Day" },
  { closed_on: "2027-02-25", reason: "EDSA People Power Revolution Anniversary" },
  { closed_on: "2027-04-09", reason: "Araw ng Kagitingan" },
  { closed_on: "2027-05-01", reason: "Labor Day" },
];

async function main() {
  console.log(`Seeding ${closures.length} clinic closures...`);
  const { error } = await admin
    .from("clinic_closures")
    .upsert(closures, { onConflict: "closed_on" });
  if (error) {
    console.error("upsert clinic_closures failed", error);
    process.exit(1);
  }
  console.log("✓ Done. Closures upserted (idempotent).");
  console.log(
    "Reminder: add movable holidays (Holy Week, Eid'l Fitr, Eid'l Adha,",
  );
  console.log(
    "Chinese New Year) via /staff/admin/closures once each year's",
  );
  console.log("Malacañang Proclamation is published.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
