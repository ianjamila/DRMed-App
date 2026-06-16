import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface PublicPhysicianListItem {
  slug: string;
  full_name: string;
  updated_at: string;
}

/** Active physicians for the sitemap + per-doctor static params, ordered for display. */
export async function listActivePhysicians(): Promise<PublicPhysicianListItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("physicians")
    .select("slug, full_name, updated_at")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });
  if (error) {
    console.error("listActivePhysicians failed", error);
    return [];
  }
  return data ?? [];
}
