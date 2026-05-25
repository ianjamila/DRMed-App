import { createClient } from "@/lib/supabase/server";

export interface ReferralSourceOption {
  id: string;
  label: string;
}

export async function listActiveReferralSources(): Promise<ReferralSourceOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("referral_sources")
    .select("id, label")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("listActiveReferralSources failed; falling back to empty:", error);
    return [];
  }
  return data ?? [];
}
