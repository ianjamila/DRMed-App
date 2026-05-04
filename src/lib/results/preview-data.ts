import type {
  ParamValue,
  ResultFlag,
  TemplateParam,
} from "./types";

// Synthesises plausible placeholder values for an admin preview run. Picks
// in-range numbers for most rows and forces a few to be high so the abnormal
// flag column actually demonstrates colour. Free-text rows fall back to their
// `placeholder`; select rows pick the first allowed value, except every third
// select row which is forced to an abnormal value to verify the 'A' flag
// rendering.
//
// Mirrors the DB-side `compute_result_flag` trigger so the preview matches
// what real finalised results would render.
export function buildPreviewValues(
  params: TemplateParam[],
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  let numericIdx = 0;
  let selectIdx = 0;

  for (const p of params) {
    if (p.is_section_header) continue;

    if (p.input_type === "numeric") {
      const value = pickNumericValue(p, numericIdx);
      const flag = computeNumericFlag(p, value);
      out[p.id] = {
        numeric_value_si: value.si,
        numeric_value_conv: value.conv,
        text_value: null,
        select_value: null,
        flag,
        is_blank: false,
      };
      numericIdx += 1;
      continue;
    }

    if (p.input_type === "select") {
      const allowed = p.allowed_values ?? [];
      const abnormal = p.abnormal_values ?? [];
      const forceAbnormal = selectIdx % 3 === 2 && abnormal.length > 0;
      const chosen = forceAbnormal
        ? abnormal[0]
        : (allowed[0] ?? null);
      out[p.id] = {
        numeric_value_si: null,
        numeric_value_conv: null,
        text_value: null,
        select_value: chosen,
        flag: forceAbnormal ? "A" : null,
        is_blank: chosen == null,
      };
      selectIdx += 1;
      continue;
    }

    // free_text — use the placeholder so blank textareas read meaningfully.
    out[p.id] = {
      numeric_value_si: null,
      numeric_value_conv: null,
      text_value: p.placeholder ?? "(sample text)",
      select_value: null,
      flag: null,
      is_blank: false,
    };
  }

  return out;
}

function pickNumericValue(
  p: TemplateParam,
  idx: number,
): { si: number | null; conv: number | null } {
  // Force every 5th numeric row to be slightly above the high range so the
  // preview demonstrates the abnormal-flag styling.
  const forceHigh = idx % 5 === 4;

  const si = pickInRange(
    p.ref_low_si,
    p.ref_high_si,
    forceHigh ? "above" : "mid",
  );
  let conv: number | null = null;
  if (p.unit_conv != null) {
    if (p.si_to_conv_factor != null && si != null) {
      conv = round2(si * p.si_to_conv_factor);
    } else {
      conv = pickInRange(
        p.ref_low_conv,
        p.ref_high_conv,
        forceHigh ? "above" : "mid",
      );
    }
  }
  return { si, conv };
}

function pickInRange(
  low: number | null,
  high: number | null,
  pos: "mid" | "above",
): number | null {
  if (low == null && high == null) return null;
  if (pos === "above" && high != null) return round2(high * 1.15);
  if (low == null && high != null) return round2(high * 0.7);
  if (high == null && low != null) return round2(low * 1.1);
  if (low != null && high != null) return round2((low + high) / 2);
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeNumericFlag(
  p: TemplateParam,
  value: { si: number | null; conv: number | null },
): ResultFlag {
  const v = value.si ?? value.conv;
  if (v == null) return null;
  if (p.ref_low_si != null && v < p.ref_low_si) return "L";
  if (p.ref_high_si != null && v > p.ref_high_si) return "H";
  return null;
}
