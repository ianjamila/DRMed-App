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
  | "imaging_ecg"
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
  fasting_required: boolean;
  requires_time_slot: boolean;
  specialty_code: string | null;
  image_url: string | null;
};

const PUBLIC_SELECT =
  "id, code, name, description, price_php, hmo_price_php, senior_discount_php, turnaround_hours, kind, section, is_send_out, send_out_lab, fasting_required, requires_time_slot, specialty_code, image_url" as const;

// Default listing image per package code, served from /public/photos/packages.
// Every active lab_package has an entry so Merchant/Shopping + Product JSON-LD
// listings never fall back to the generic brand image. A non-null
// services.image_url (set by staff on /staff/services) takes precedence — see
// packageImageFor(). Photos are real package shots; the four executive tiers
// plus lipid/kidney/iron use generated two-tone logo cards.
const PACKAGE_IMAGE_BY_CODE: Record<string, string> = {
  BASIC_PACKAGE: "/photos/packages/basic-package.jpg",
  ROUTINE_PACKAGE: "/photos/packages/routine-checkup.webp",
  ANNUAL_PHYSICAL_EXAM: "/photos/packages/annual-physical-exam.png",
  PREGNANCY_CARE_PACKAGE: "/photos/packages/pregnancy-care.jpg",
  STANDARD_CHEMISTRY: "/photos/packages/standard-chemistry.jpg",
  DIABETIC_HEALTH_PACKAGE: "/photos/packages/diabetic-health.jpg",
  DENGUE_PACKAGE: "/photos/packages/dengue-package.jpg",
  THYROID_HEALTH_PACKAGE: "/photos/packages/thyroid-health.jpg",
  LIVER_FUNCTION_PACKAGE: "/photos/packages/liver-health.jpg",
  LIPID_PROFILE_PACKAGE: "/photos/packages/lipid-profile.png",
  KIDNEY_FUNCTION_PACKAGE: "/photos/packages/kidney-function.png",
  IRON_DEFICIENCY_PACKAGE: "/photos/packages/iron-deficiency.png",
  EXECUTIVE_PACKAGE_STANDARD: "/photos/packages/exec-standard.png",
  EXECUTIVE_PACKAGE_COMPREHENSIVE: "/photos/packages/exec-comprehensive.png",
  EXECUTIVE_PACKAGE_DELUXE_MEN_S: "/photos/packages/exec-deluxe-mens.png",
  EXECUTIVE_PACKAGE_DELUXE_WOMEN_S: "/photos/packages/exec-deluxe-womens.png",
};

/**
 * Resolves a package's listing image. A staff-set services.image_url always
 * wins; otherwise the per-code default map fills in. Returns null for codes
 * with neither (e.g. non-package services), so callers keep their own fallback.
 */
export function packageImageFor(
  code: string,
  dbImageUrl: string | null,
): string | null {
  return dbImageUrl ?? PACKAGE_IMAGE_BY_CODE[code] ?? null;
}

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
  fasting_required: boolean;
  requires_time_slot: boolean;
  specialty_code: string | null;
  image_url: string | null;
}): PublicService {
  return {
    ...s,
    kind: s.kind as ServiceKind,
    section: (s.section as ServiceSection | null) ?? null,
    image_url: packageImageFor(s.code, s.image_url),
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
