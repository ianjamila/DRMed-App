import "server-only";
import { createClient } from "@/lib/supabase/server";

export type ServiceKind = "lab_test" | "lab_package" | "doctor_consultation";

export type PublicService = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  turnaround_hours: number | null;
  kind: ServiceKind;
};

export async function listActiveServices(): Promise<PublicService[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(
      "id, code, name, description, price_php, turnaround_hours, kind",
    )
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) {
    console.error("listActiveServices failed", error);
    return [];
  }
  return (data ?? []).map((s) => ({
    ...s,
    kind: s.kind as ServiceKind,
  }));
}

export async function getServiceByCode(
  code: string,
): Promise<PublicService | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(
      "id, code, name, description, price_php, turnaround_hours, kind",
    )
    .eq("code", code.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("getServiceByCode failed", error);
    return null;
  }
  return data ? { ...data, kind: data.kind as ServiceKind } : null;
}

export { formatPhp } from "./format";
