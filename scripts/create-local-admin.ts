/**
 * One-off: create admin@drmed.ph on local Supabase with a known password,
 * plus a staff_profiles row with role='admin'. Used so the partner can log in
 * to view 12.B imported history on the local stack.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_SERVICE_ROLE_KEY=<from supabase status> \
 *   ADMIN_EMAIL=admin@drmed.ph ADMIN_PASSWORD=... \
 *   npx tsx scripts/create-local-admin.ts
 */
import { createClient } from "@supabase/supabase-js";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const FULL_NAME = process.env.ADMIN_FULL_NAME ?? "Admin";

if (!URL || !KEY || !EMAIL || !PASSWORD) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD.");
  process.exit(2);
}
requireLocalOrExplicitProd("create-local-admin");

const admin = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // Idempotent: if user exists, update password and ensure staff profile.
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = existing?.users?.find((u) => u.email?.toLowerCase() === EMAIL!.toLowerCase());

  let userId: string;
  if (found) {
    console.log(`User exists: ${found.id}`);
    const { error } = await admin.auth.admin.updateUserById(found.id, {
      password: PASSWORD!,
      email_confirm: true,
    });
    if (error) {
      console.error("Update failed:", error.message);
      process.exit(3);
    }
    userId = found.id;
    console.log("Password reset.");
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL!,
      password: PASSWORD!,
      email_confirm: true,
    });
    if (error || !data?.user) {
      console.error("Create failed:", error?.message);
      process.exit(3);
    }
    userId = data.user.id;
    console.log(`Created auth.users id=${userId}`);
  }

  // Ensure staff_profiles row.
  const { error: spErr } = await admin
    .from("staff_profiles")
    .upsert({ id: userId, full_name: FULL_NAME, role: "admin", is_active: true });
  if (spErr) {
    console.error("staff_profiles upsert failed:", spErr.message);
    process.exit(4);
  }
  console.log(`staff_profiles set: role=admin, full_name=${FULL_NAME}, is_active=true`);
  console.log(`\nLog in at http://localhost:3001/staff/login with ${EMAIL}.`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
