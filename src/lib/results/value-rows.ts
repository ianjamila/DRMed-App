/**
 * Pure: structured values → the rows the 0172 RPCs write, the values the PDF
 * renders, and the critical-value crossings. Every structured write path —
 * single-test draft / finalise / edit and the consolidated finalise / edit —
 * builds its payload here, so flags and crossings can never drift between
 * the PDF and the database (flags are computed in TypeScript since 0010).
 */

import {
  computeFlag,
  detectCritical,
  pickRangeForPatient,
  type ParamValue,
  type PatientSex,
  type ResultFlag,
  type TemplateParam,
} from "./types";

/** A value as a form submits it (no flag — that is computed here). */
export interface SubmittedValue {
  numeric_value_si: number | null;
  numeric_value_conv: number | null;
  text_value: string | null;
  select_value: string | null;
  is_blank: boolean;
}

/** One `result_values` row as the RPCs take it (`p_values`). */
export interface ValueRow extends SubmittedValue {
  parameter_id: string;
  flag: ResultFlag;
}

/** One desired `critical_alerts` row as the RPCs take it (`p_alerts`). */
export interface AlertRow {
  test_request_id: string;
  parameter_id: string;
  parameter_name: string;
  direction: "low" | "high";
  observed_value_si: number;
  threshold_si: number;
}

export interface PatientForRanges {
  sex: PatientSex;
  ageMonths: number | null;
}

/**
 * Flag every submitted value against the patient's range. A value for a
 * parameter missing from `paramsById` keeps a null flag (callers reject
 * unknown parameters before this point).
 */
export function buildValueRows(
  values: Readonly<Record<string, SubmittedValue>>,
  paramsById: ReadonlyMap<string, TemplateParam>,
  patient: PatientForRanges,
): ValueRow[] {
  return Object.entries(values).map(([parameterId, v]) => {
    const param = paramsById.get(parameterId);
    const flag = param
      ? computeFlag(param, pickRangeForPatient(param, patient.sex, patient.ageMonths), v)
      : null;
    return {
      parameter_id: parameterId,
      numeric_value_si: v.numeric_value_si,
      numeric_value_conv: v.numeric_value_conv,
      text_value: v.text_value,
      select_value: v.select_value,
      is_blank: v.is_blank,
      flag,
    };
  });
}

/** The same rows keyed for `ResultDocumentInput.values`. */
export function valueRowsToDocValues(rows: readonly ValueRow[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const r of rows) {
    out[r.parameter_id] = {
      numeric_value_si: r.numeric_value_si,
      numeric_value_conv: r.numeric_value_conv,
      text_value: r.text_value,
      select_value: r.select_value,
      flag: r.flag,
      is_blank: r.is_blank,
    };
  }
  return out;
}

/**
 * Overlay `next` on `base` by parameter id: the complete value set a finalise
 * writes when the form sent only part of it (a draft row the form did not
 * resend is kept, as the old upsert did).
 */
export function mergeValueRows(base: readonly ValueRow[], next: readonly ValueRow[]): ValueRow[] {
  const byId = new Map<string, ValueRow>();
  for (const r of base) byId.set(r.parameter_id, r);
  for (const r of next) byId.set(r.parameter_id, r);
  return [...byId.values()];
}

/**
 * Critical crossings of `rows`. `testRequestFor` names the test each alert is
 * filed under (null = skip — e.g. a chemistry parameter no member enables);
 * only parameters in `paramsById` are considered, so a caller that wants the
 * patient-visible set passes only those.
 */
export function detectCrossings(
  rows: readonly ValueRow[],
  paramsById: ReadonlyMap<string, TemplateParam>,
  patient: PatientForRanges,
  testRequestFor: (parameterId: string) => string | null,
): AlertRow[] {
  const alerts: AlertRow[] = [];
  for (const r of rows) {
    const param = paramsById.get(r.parameter_id);
    if (!param || param.is_section_header) continue;
    const testRequestId = testRequestFor(r.parameter_id);
    if (!testRequestId) continue;
    const hit = detectCritical(
      param,
      pickRangeForPatient(param, patient.sex, patient.ageMonths),
      r,
    );
    if (hit) {
      alerts.push({
        test_request_id: testRequestId,
        parameter_id: param.id,
        parameter_name: param.parameter_name,
        direction: hit.direction,
        observed_value_si: hit.observed_si,
        threshold_si: hit.threshold_si,
      });
    }
  }
  return alerts;
}

/** Which visible, non-header parameters have no usable value. */
export function missingParams(
  visibleParams: readonly TemplateParam[],
  values: Readonly<Record<string, SubmittedValue>>,
): TemplateParam[] {
  return visibleParams
    .filter((p) => !p.is_section_header)
    .filter((p) => {
      const v = values[p.id];
      if (!v) return true;
      if (v.is_blank) return false;
      if (p.input_type === "numeric") {
        return v.numeric_value_si == null && v.numeric_value_conv == null;
      }
      if (p.input_type === "select") return !v.select_value;
      return !v.text_value || !v.text_value.trim();
    });
}

export function missingParamsError(missing: readonly TemplateParam[]): string {
  return `Missing values for: ${missing
    .slice(0, 5)
    .map((p) => p.parameter_name)
    .join(", ")}${missing.length > 5 ? "…" : ""}. Mark blank if you didn't run the sub-test.`;
}
