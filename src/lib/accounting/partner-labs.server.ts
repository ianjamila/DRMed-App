import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PartnerLab } from "./partner-labs";

/**
 * Active partner labs for the "Which lab?" picker. Takes whatever client the
 * caller already has — reception pages read this with the RLS-scoped server
 * client (`createClient()` from `@/lib/supabase/server`), since migration
 * 0164 lets reception SELECT active partner-lab vendors directly; admin
 * surfaces may pass the admin client instead.
 */
export async function loadPartnerLabs(
  client: SupabaseClient<Database>,
): Promise<PartnerLab[]> {
  const { data, error } = await client
    .from("vendors")
    .select("id, name")
    .eq("is_partner_lab", true)
    .eq("is_active", true)
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Server-side check that a picked `vendor_id` is really a usable partner lab
 * — the client-side select only ever offers active partner labs, but the id
 * still arrives over the wire and must be re-verified before it's written to
 * `eod_cash_adjustments.vendor_id` / `journal_lines.vendor_id`. Uses the admin
 * client so this works from every calling surface regardless of RLS.
 *
 * Returns a user-facing error, or null when the vendor checks out.
 */
export async function verifyPartnerLab(vendorId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendors")
    .select("is_partner_lab, is_active")
    .eq("id", vendorId)
    .maybeSingle();
  if (error) return "Could not verify the lab. Try again.";
  if (!data) return "That lab could not be found.";
  if (!data.is_partner_lab || !data.is_active) {
    return "That is not an active partner lab.";
  }
  return null;
}
