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

export interface PublicPhysicianDetail {
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  bio: string | null;
}

/** Active physicians with bio/specialty — for llms-full.txt. Public-readable per RLS. */
export async function listActivePhysiciansDetailed(): Promise<PublicPhysicianDetail[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("physicians")
    .select("slug, full_name, specialty, group_label, bio")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });
  if (error) {
    console.error("listActivePhysiciansDetailed failed", error);
    return [];
  }
  return data ?? [];
}
