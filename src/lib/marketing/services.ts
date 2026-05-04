import "server-only";
import { createClient } from "@/lib/supabase/server";

export type ServiceKind =
  | "lab_test"
  | "lab_package"
  | "doctor_consultation"
  | "doctor_procedure"
  | "home_service"
  | "vaccine";

export type ServiceSection =
  | "package"
  | "chemistry"
  | "hematology"
  | "immunology"
  | "urinalysis"
  | "microbiology"
  | "imaging_xray"
  | "imaging_ultrasound"
  | "vaccine"
  | "send_out"
  | "consultation"
  | "procedure"
  | "home_service";

export type PublicService = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  turnaround_hours: number | null;
  kind: ServiceKind;
  section: ServiceSection | null;
  is_send_out: boolean;
  send_out_lab: string | null;
};

const PUBLIC_SELECT =
  "id, code, name, description, price_php, hmo_price_php, senior_discount_php, turnaround_hours, kind, section, is_send_out, send_out_lab" as const;

function rowToPublic(s: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  turnaround_hours: number | null;
  kind: string;
  section: string | null;
  is_send_out: boolean;
  send_out_lab: string | null;
}): PublicService {
  return {
    ...s,
    kind: s.kind as ServiceKind,
    section: (s.section as ServiceSection | null) ?? null,
  };
}

export async function listActiveServices(): Promise<PublicService[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(PUBLIC_SELECT)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) {
    console.error("listActiveServices failed", error);
    return [];
  }
  return (data ?? []).map(rowToPublic);
}

export async function getServiceByCode(
  code: string,
): Promise<PublicService | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(PUBLIC_SELECT)
    .eq("code", code.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("getServiceByCode failed", error);
    return null;
  }
  return data ? rowToPublic(data) : null;
}

export type PackageGroup =
  | "Basic & Routine"
  | "Diabetic & Specialized"
  | "Executive Packages"
  | "More Lab Test Packages";

export const PACKAGE_GROUPS_ORDERED: PackageGroup[] = [
  "Basic & Routine",
  "Diabetic & Specialized",
  "Executive Packages",
  "More Lab Test Packages",
];

// Maps services.code → display group on /packages.
// Codes here are the canonical ones from the April 2026 import + drmed.ph.
const PACKAGE_GROUP_BY_CODE: Record<string, PackageGroup> = {
  BASIC_PACKAGE: "Basic & Routine",
  ROUTINE_PACKAGE: "Basic & Routine",
  ANNUAL_PHYSICAL_EXAM: "Basic & Routine",
  PRE_EMPLOYMENT_PACKAGE: "Basic & Routine",
  PREGNANCY_CARE_PACKAGE: "Basic & Routine",
  STANDARD_CHEMISTRY: "Diabetic & Specialized",
  DIABETIC_HEALTH_PACKAGE: "Diabetic & Specialized",
  DENGUE_PACKAGE: "Diabetic & Specialized",
  EXECUTIVE_PACKAGE_STANDARD: "Executive Packages",
  EXECUTIVE_PACKAGE_COMPREHENSIVE: "Executive Packages",
  EXECUTIVE_PACKAGE_DELUXE_MEN_S: "Executive Packages",
  EXECUTIVE_PACKAGE_DELUXE_WOMEN_S: "Executive Packages",
  THYROID_HEALTH_PACKAGE: "More Lab Test Packages",
  LIPID_PROFILE_PACKAGE: "More Lab Test Packages",
  LIVER_FUNCTION_PACKAGE: "More Lab Test Packages",
  KIDNEY_FUNCTION_PACKAGE: "More Lab Test Packages",
  IRON_DEFICIENCY_PACKAGE: "More Lab Test Packages",
};

export interface PackageWithGroup extends PublicService {
  group: PackageGroup;
  inclusions: string[];
}

function splitIncludes(desc: string): string[] {
  return desc
    .split(/[;,]+|\s+and\s+/i)
    .map((s) => s.replace(/[.\s]+$/g, "").trim())
    .filter((s) => s.length > 0);
}

export async function listActivePackages(): Promise<PackageWithGroup[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(PUBLIC_SELECT)
    .eq("is_active", true)
    .eq("kind", "lab_package")
    .order("price_php", { ascending: true });

  if (error) {
    console.error("listActivePackages failed", error);
    return [];
  }
  return (data ?? []).map((s) => {
    const base = rowToPublic(s);
    return {
      ...base,
      // Codes outside the known map fall through to the catch-all bucket so
      // new packages still show up; admin can add a mapping when ready.
      group: PACKAGE_GROUP_BY_CODE[base.code] ?? "More Lab Test Packages",
      inclusions: base.description ? splitIncludes(base.description) : [],
    };
  });
}

export { formatPhp } from "./format";
