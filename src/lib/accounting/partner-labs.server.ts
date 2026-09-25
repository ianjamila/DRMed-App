import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PartnerLab } from "./partner-labs";

/**
 * Active partner labs for the "Which lab?" picker. Takes whatever client the
 * caller already has — reception pages pass the RLS-scoped server client
 * (`createClient()` from `@/lib/supabase/server`); the `partner_labs()` RPC
 * (0164) checks the caller is admin or reception and returns id + name only.
 */
export async function loadPartnerLabs(
  client: SupabaseClient<Database>,
): Promise<PartnerLab[]> {
  // partner_labs() (0164) returns only id + name, and only to admin and
  // reception — the vendors table itself stays admin-only, because a row
  // policy cannot hide its TIN / contact / withholding columns.
  const { data, error } = await client.rpc("partner_labs");
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
