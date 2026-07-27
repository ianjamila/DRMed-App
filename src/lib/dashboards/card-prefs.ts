import "server-only";
import { createClient } from "@/lib/supabase/server";
import { hiddenCardIdsFor, type DashboardRole } from "./cards";

// Returns the set of card ids that must not render for this role — admin's
// stored overrides resolved against the registry's `defaultHidden` flags. Each
// dashboard uses this to (a) skip the underlying query for hidden cards and
// (b) skip rendering those cards.
//
// Reads every stored row for the role (not just visible=false) because a
// stored `visible: true` is what turns a default-hidden card back ON.
export async function loadHiddenCardIds(
  role: DashboardRole,
): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("dashboard_card_prefs")
    .select("card_id, visible")
    .eq("role", role);

  // On a read failure fall back to the registry defaults rather than showing
  // everything — a hidden-by-default card should stay hidden.
  if (error) return hiddenCardIdsFor(role, []);
  return hiddenCardIdsFor(role, data ?? []);
}
