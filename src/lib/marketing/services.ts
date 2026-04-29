import "server-only";
import { createClient } from "@/lib/supabase/server";

export type PublicService = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  turnaround_hours: number | null;
};

export async function listActiveServices(): Promise<PublicService[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, code, name, description, price_php, turnaround_hours")
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) {
    console.error("listActiveServices failed", error);
    return [];
  }
  return data ?? [];
}

export async function getServiceByCode(
  code: string,
): Promise<PublicService | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, code, name, description, price_php, turnaround_hours")
    .eq("code", code.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("getServiceByCode failed", error);
    return null;
  }
  return data;
}

export function formatPhp(amount: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}
