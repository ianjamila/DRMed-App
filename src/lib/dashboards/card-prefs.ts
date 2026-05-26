import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DashboardRole } from "./cards";

// Returns the set of card ids that admin has hidden for this role.
// The empty set is the default (everything visible). Each dashboard uses
// this to (a) skip the underlying query for hidden cards and (b) skip
// rendering those cards.
export async function loadHiddenCardIds(
  role: DashboardRole,
): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("dashboard_card_prefs")
    .select("card_id")
    .eq("role", role)
    .eq("visible", false);

  if (error) return new Set();
  return new Set((data ?? []).map((r) => r.card_id));
}
