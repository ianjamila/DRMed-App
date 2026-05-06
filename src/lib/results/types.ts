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

export interface ParamRange {
  id: string;
  age_min_months: number | null;
  age_max_months: number | null;
  gender: PatientSex;
  band_label: string;
  ref_low_si: number | null;
  ref_high_si: number | null;
  ref_low_conv: number | null;
  ref_high_conv: number | null;
  // Critical thresholds (added in 0027). Optional — most bands won't
  // configure them. When a value crosses one of these bounds at finalise
  // time the structured-result flow inserts a critical_alerts row that
  // pages pathologist + admin via the notification bell.
  critical_low_si: number | null;
  critical_high_si: number | null;
  critical_low_conv: number | null;
  critical_high_conv: number | null;
  sort_order: number;
}

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
  // Age-banded reference range overrides (added in migration 0009). Empty
  // array when the param has no per-age overrides — render falls back to the
  // ref_*_si / ref_*_conv columns above.
  ranges: ParamRange[];
}

// The reference range that applies to a specific patient. Returned by
// pickRangeForPatient. `band_label` is null when we fell back to the param's
// default range (no age-banded overrides matched).
export interface EffectiveRange {
  ref_low_si: number | null;
  ref_high_si: number | null;
  ref_low_conv: number | null;
  ref_high_conv: number | null;
  critical_low_si: number | null;
  critical_high_si: number | null;
  band_label: string | null;
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

export function calculateAgeMonths(
  birthdateIso: string | null,
  asOf: Date = new Date(),
): number | null {
  if (!birthdateIso) return null;
  const b = new Date(birthdateIso);
  if (Number.isNaN(b.getTime())) return null;
  let months =
    (asOf.getFullYear() - b.getFullYear()) * 12 +
    (asOf.getMonth() - b.getMonth());
  if (asOf.getDate() < b.getDate()) months -= 1;
  return Math.max(0, months);
}

// Pick the matching age/sex range row for a patient. Preference order:
//   1. Most specific match: age band fits AND gender matches the patient's
//      sex exactly.
//   2. Age band fits AND row gender is null (applies to either).
//   3. No row matches → fall back to the param's own ref_*_si / ref_*_conv.
// Within an equal-specificity tier, sort_order breaks ties.
export function pickRangeForPatient(
  param: TemplateParam,
  sex: PatientSex,
  ageMonths: number | null,
): EffectiveRange {
  const fallback: EffectiveRange = {
    ref_low_si: param.ref_low_si,
    ref_high_si: param.ref_high_si,
    ref_low_conv: param.ref_low_conv,
    ref_high_conv: param.ref_high_conv,
    critical_low_si: null,
    critical_high_si: null,
    band_label: null,
  };

  if (param.ranges.length === 0) return fallback;

  const ageOK = (r: ParamRange) =>
    ageMonths == null
      ? r.age_min_months == null && r.age_max_months == null
      : (r.age_min_months == null || ageMonths >= r.age_min_months) &&
        (r.age_max_months == null || ageMonths < r.age_max_months);

  const candidates = param.ranges.filter(ageOK);
  if (candidates.length === 0) return fallback;

  const exactSex = candidates
    .filter((r) => r.gender !== null && r.gender === sex)
    .sort((a, b) => a.sort_order - b.sort_order);
  if (exactSex.length > 0) return toEffective(exactSex[0]);

  const eitherSex = candidates
    .filter((r) => r.gender === null)
    .sort((a, b) => a.sort_order - b.sort_order);
  if (eitherSex.length > 0) return toEffective(eitherSex[0]);

  return fallback;
}

// Compute the abnormal flag for a single value. Mirrors what the original
// (now-dropped) compute_result_flag trigger did, but uses the picked
// EffectiveRange so age-banded ranges produce correct flags. Called from
// the Server Action upsert path.
export function computeFlag(
  param: TemplateParam,
  range: EffectiveRange,
  v: {
    numeric_value_si: number | null;
    numeric_value_conv: number | null;
    select_value: string | null;
    is_blank: boolean;
  },
): ResultFlag {
  if (v.is_blank) return null;

  if (param.input_type === "numeric") {
    const x = v.numeric_value_si ?? v.numeric_value_conv;
    if (x == null) return null;
    if (range.ref_low_si != null && x < range.ref_low_si) return "L";
    if (range.ref_high_si != null && x > range.ref_high_si) return "H";
    return null;
  }

  if (param.input_type === "select") {
    if (!v.select_value) return null;
    return (param.abnormal_values ?? []).includes(v.select_value) ? "A" : null;
  }

  return null;
}

function toEffective(r: ParamRange): EffectiveRange {
  return {
    ref_low_si: r.ref_low_si,
    ref_high_si: r.ref_high_si,
    ref_low_conv: r.ref_low_conv,
    ref_high_conv: r.ref_high_conv,
    critical_low_si: r.critical_low_si,
    critical_high_si: r.critical_high_si,
    band_label: r.band_label,
  };
}

// Critical-value detection: returns a directional hit when the value is
// at or beyond a critical threshold. Direction is the side that fired
// (low or high). Critical thresholds are intentionally inclusive — a
// value exactly at threshold is critical.
export function detectCritical(
  param: TemplateParam,
  range: EffectiveRange,
  v: {
    numeric_value_si: number | null;
    numeric_value_conv: number | null;
    is_blank: boolean;
  },
): { direction: "low" | "high"; threshold_si: number; observed_si: number } | null {
  if (param.input_type !== "numeric") return null;
  if (v.is_blank) return null;
  const x = v.numeric_value_si ?? v.numeric_value_conv;
  if (x == null) return null;
  if (range.critical_low_si != null && x <= range.critical_low_si) {
    return { direction: "low", threshold_si: range.critical_low_si, observed_si: x };
  }
  if (range.critical_high_si != null && x >= range.critical_high_si) {
    return { direction: "high", threshold_si: range.critical_high_si, observed_si: x };
  }
  return null;
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
