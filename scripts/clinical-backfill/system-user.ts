import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";

const SYSTEM_EMAIL = "legacy-import@system.drmed.ph";
const SYSTEM_NAME = "Legacy Import (system)";

/**
 * Ensure a dedicated inactive "Legacy Import" staff member exists and return
 * its uuid. staff_profiles.id FKs auth.users(id), so we create the auth user
 * first (reusing the create-local-admin pattern), then the profile row.
 * Idempotent: re-runs return the existing id.
 */
export async function ensureSystemUser(admin: SupabaseClient<Database>): Promise<string> {
  // 1. existing profile?
  const { data: existing } = await admin
    .from("staff_profiles").select("id").eq("full_name", SYSTEM_NAME).maybeSingle();
  if (existing?.id) return existing.id;

  // 2. find or create the auth user
  let userId: string | undefined;
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  userId = list?.users.find((u) => u.email === SYSTEM_EMAIL)?.id;
  if (!userId) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: SYSTEM_EMAIL, email_confirm: true,
      password: crypto.randomUUID() + "Aa1!",  // never used; system account
    });
    if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`);
    userId = created.user.id;
  }

  // 3. profile row (role admin, inactive — it never logs in)
  const { error: pErr } = await admin.from("staff_profiles").insert({
    id: userId, full_name: SYSTEM_NAME, role: "admin", is_active: false,
  });
  if (pErr) throw new Error(`staff_profiles insert failed: ${pErr.message}`);
  return userId;
}
