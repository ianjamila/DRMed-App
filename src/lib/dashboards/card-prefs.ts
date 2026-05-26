import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DashboardRole } from "./cards";

interface PrefRow {
  card_id: string;
}

// Returns the set of card ids that admin has hidden for this role.
// The empty set is the default (everything visible). Each dashboard uses
// this to (a) skip the underlying query for hidden cards and (b) skip
// rendering those cards.
//
// Wrapped in try/catch so the dashboard still works before migration 0068
// is applied — pre-migration we return an empty set (nothing hidden).
// The `as never` cast falls away once `npm run db:types` regenerates the
// table types after the migration lands.
export async function loadHiddenCardIds(
  role: DashboardRole,
): Promise<Set<string>> {
  try {
    const supabase = await createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = supabase as any;
    const { data, error } = (await client
      .from("dashboard_card_prefs")
      .select("card_id")
      .eq("role", role)
      .eq("visible", false)) as { data: PrefRow[] | null; error: unknown };
    if (error) return new Set();
    return new Set((data ?? []).map((r) => r.card_id));
  } catch {
    return new Set();
  }
}
