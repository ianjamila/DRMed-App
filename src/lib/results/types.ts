// Shared types for structured result rendering. Keep this file framework-free
// (no React, no @react-pdf/renderer imports) so it can be used from Server
// Components, Server Actions, and the @react-pdf/renderer document alike.

export type ResultLayout =
  | "simple"
  | "dual_unit"
  | "multi_section"
  | "imaging_report";

export type ParamInputType = "numeric" | "free_text" | "select";

export type ResultFlag = "H" | "L" | "A" | null;

export type PatientSex = "F" | "M" | null;

export interface TemplateParam {
  id: string;
  sort_order: number;
  section: string | null;
  is_section_header: boolean;
  parameter_name: string;
  input_type: ParamInputType;
  unit_si: string | null;
  unit_conv: string | null;
  ref_low_si: number | null;
  ref_high_si: number | null;
  ref_low_conv: number | null;
  ref_high_conv: number | null;
  gender: PatientSex;
  si_to_conv_factor: number | null;
  allowed_values: string[] | null;
  abnormal_values: string[] | null;
  placeholder: string | null;
}

export interface ParamValue {
  numeric_value_si: number | null;
  numeric_value_conv: number | null;
  text_value: string | null;
  select_value: string | null;
  flag: ResultFlag;
  is_blank: boolean;
}

export interface ResultDocumentInput {
  template: {
    layout: ResultLayout;
    header_notes: string | null;
    footer_notes: string | null;
  };
  params: TemplateParam[];
  values: Record<string, ParamValue>; // keyed by param.id
  service: { code: string; name: string };
  patient: {
    drm_id: string;
    last_name: string;
    first_name: string;
    sex: PatientSex;
    birthdate: string | null; // ISO date
  };
  visit: { visit_number: string };
  controlNo: number | null;
  finalisedAt: Date | null;
  medtech: {
    full_name: string;
    prc_license_kind: string | null;
    prc_license_no: string | null;
  } | null;
  isPreview?: boolean;
}

// Pick the param row that applies to a given patient sex. When a parameter
// has gender-specific rows (e.g. Hemoglobin F + Hemoglobin M), keep only the
// one matching `sex`; gender-null rows always pass through. Falls back to
// the F row when sex is unknown so preview / unknown-sex visits still render.
export function filterParamsForPatient(
  params: TemplateParam[],
  sex: PatientSex,
): TemplateParam[] {
  const target: PatientSex = sex ?? "F";
  return params.filter((p) => p.gender === null || p.gender === target);
}

// Patients.sex is stored as 'male' | 'female' | null in the DB. Result
// template gender flags use 'F' | 'M'. Normalise at the boundary so the
// rendering / filtering code only deals with one shape.
export function normalisePatientSex(raw: string | null): PatientSex {
  if (raw === "male") return "M";
  if (raw === "female") return "F";
  if (raw === "M" || raw === "F") return raw;
  return null;
}

export function calculateAge(
  birthdateIso: string | null,
  asOf: Date = new Date(),
): number | null {
  if (!birthdateIso) return null;
  const b = new Date(birthdateIso);
  if (Number.isNaN(b.getTime())) return null;
  let age = asOf.getFullYear() - b.getFullYear();
  const mDiff = asOf.getMonth() - b.getMonth();
  if (mDiff < 0 || (mDiff === 0 && asOf.getDate() < b.getDate())) age -= 1;
  return age;
}

export function formatRefRange(
  low: number | null,
  high: number | null,
): string {
  if (low == null && high == null) return "";
  if (low == null) return `≤ ${high}`;
  if (high == null) return `≥ ${low}`;
  return `${low} – ${high}`;
}
