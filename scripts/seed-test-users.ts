/**
 * One-off seed for Phase 2 manual verification.
 *
 *   npm run seed:test
 *
 * Idempotent: re-running upserts based on email / drm_id / visit_number.
 * Prints test credentials at the end.
 */
import { createClient } from "@supabase/supabase-js";
import { generatePin, hashPin } from "../src/lib/auth/pin";
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

async function ensureStaffUser(opts: {
  email: string;
  password: string;
  fullName: string;
  role: "reception" | "medtech" | "pathologist" | "admin";
  isActive: boolean;
}) {
  // Look up existing user by email.
  const { data: existing } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  let user = existing.users.find((u) => u.email === opts.email);

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: opts.email,
      password: opts.password,
      email_confirm: true,
    });
    if (error) throw new Error(`create staff user failed: ${error.message}`);
    user = data.user;
  }
  if (!user) throw new Error("user not resolved");

  const { error: profileErr } = await admin
    .from("staff_profiles")
    .upsert(
      {
        id: user.id,
        full_name: opts.fullName,
        role: opts.role,
        is_active: opts.isActive,
      },
      { onConflict: "id" },
    );
  if (profileErr) throw new Error(`upsert staff_profile: ${profileErr.message}`);

  return user.id;
}

async function ensureTestPatient(opts: {
  drmId: string;
  firstName: string;
  lastName: string;
  birthdate: string;
}) {
  const { data: existing } = await admin
    .from("patients")
    .select("id")
    .eq("drm_id", opts.drmId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data, error } = await admin
    .from("patients")
    .insert({
      drm_id: opts.drmId,
      first_name: opts.firstName,
      last_name: opts.lastName,
      birthdate: opts.birthdate,
      pre_registered: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`create patient: ${error.message}`);
  return data.id;
}

async function ensureTestVisit(opts: {
  patientId: string;
  visitNumber: string;
}) {
  const { data: existing } = await admin
    .from("visits")
    .select("id")
    .eq("visit_number", opts.visitNumber)
    .maybeSingle();
  if (existing) return existing.id;

  const { data, error } = await admin
    .from("visits")
    .insert({
      patient_id: opts.patientId,
      visit_number: opts.visitNumber,
      total_php: 0,
    })
    .select("id")
    .single();
  if (error) throw new Error(`create visit: ${error.message}`);
  return data.id;
}

async function ensureFreshPin(visitId: string) {
  const pin = generatePin();
  const pinHash = await hashPin(pin);

  // Wipe any existing pin for this visit and create a fresh one.
  await admin.from("visit_pins").delete().eq("visit_id", visitId);

  const { error } = await admin.from("visit_pins").insert({
    visit_id: visitId,
    pin_hash: pinHash,
  });
  if (error) throw new Error(`create visit_pin: ${error.message}`);

  return pin;
}

async function main() {
  console.log("Seeding test users...\n");

  // 1) Active admin
  const adminId = await ensureStaffUser({
    email: "admin@drmed.ph",
    password: "AdminPass123!",
    fullName: "Test Admin",
    role: "admin",
    isActive: true,
  });
  console.log(`✓ admin staff user: admin@drmed.ph / AdminPass123!`);
  console.log(`  user_id: ${adminId}\n`);

  // 2) Deactivated medtech (for the inactive-rejection test)
  const inactiveId = await ensureStaffUser({
    email: "inactive@drmed.ph",
    password: "InactivePass123!",
    fullName: "Inactive Medtech",
    role: "medtech",
    isActive: false,
  });
  console.log(
    `✓ inactive medtech: inactive@drmed.ph / InactivePass123! (is_active=false)`,
  );
  console.log(`  user_id: ${inactiveId}\n`);

  // 3) Patient + visit + fresh PIN
  const patientId = await ensureTestPatient({
    drmId: "DRM-9999",
    firstName: "Test",
    lastName: "Patient",
    birthdate: "1990-01-01",
  });
  console.log(`✓ patient: DRM-9999 (Test Patient)`);
  console.log(`  patient_id: ${patientId}`);

  const visitId = await ensureTestVisit({
    patientId,
    visitNumber: "9999",
  });
  console.log(`  visit_id: ${visitId}`);

  const pin = await ensureFreshPin(visitId);
  console.log(`✓ visit_pin generated (fresh, plaintext below)`);
  console.log(`\n  *** TEST PIN: ${pin} ***\n`);

  console.log(
    "Sign in at /portal/login with DRM-9999 + the PIN above (60-day expiry).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
