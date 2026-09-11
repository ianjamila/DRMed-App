import { describe, expect, it } from "vitest";
import {
  calculateAge,
  calculateAgeMonths,
  computeFlag,
  detectCritical,
  filterParamsForPatient,
  formatRefRange,
  normalisePatientSex,
  pickRangeForPatient,
  type EffectiveRange,
  type ParamRange,
  type TemplateParam,
} from "./types";

// Shared by both the single-test structured-result path
// (queue/[id]/actions.ts) and the consolidated chemistry path
// (lib/actions/results/finalise-consolidated.ts) — this module is the ONE
// place flag / critical-value logic may live so the two call sites can
// never drift. Exercise every boundary hard.

function numericParam(overrides: Partial<TemplateParam> = {}): TemplateParam {
  return {
    id: "param-1",
    sort_order: 1,
    section: null,
    is_section_header: false,
    parameter_name: "Glucose",
    input_type: "numeric",
    unit_si: "mmol/L",
    unit_conv: "mg/dL",
    ref_low_si: 3.9,
    ref_high_si: 6.1,
    ref_low_conv: 70,
    ref_high_conv: 110,
    gender: null,
    si_to_conv_factor: 18,
    allowed_values: null,
    abnormal_values: null,
    placeholder: null,
    ranges: [],
    ...overrides,
  };
}

function selectParam(overrides: Partial<TemplateParam> = {}): TemplateParam {
  return {
    ...numericParam(),
    id: "param-select",
    input_type: "select",
    allowed_values: ["negative", "trace", "positive"],
    abnormal_values: ["trace", "positive"],
    ...overrides,
  };
}

function fallbackRange(param: TemplateParam): EffectiveRange {
  return {
    ref_low_si: param.ref_low_si,
    ref_high_si: param.ref_high_si,
    ref_low_conv: param.ref_low_conv,
    ref_high_conv: param.ref_high_conv,
    critical_low_si: null,
    critical_high_si: null,
    band_label: null,
  };
}

describe("normalisePatientSex", () => {
  it("maps DB 'male'/'female' to F/M", () => {
    expect(normalisePatientSex("male")).toBe("M");
    expect(normalisePatientSex("female")).toBe("F");
  });
  it("passes through already-normalised F/M", () => {
    expect(normalisePatientSex("F")).toBe("F");
    expect(normalisePatientSex("M")).toBe("M");
  });
  it("returns null for null or unrecognised input", () => {
    expect(normalisePatientSex(null)).toBeNull();
    expect(normalisePatientSex("unknown")).toBeNull();
    expect(normalisePatientSex("")).toBeNull();
  });
});

describe("calculateAge / calculateAgeMonths", () => {
  it("returns null for a null birthdate", () => {
    expect(calculateAge(null)).toBeNull();
    expect(calculateAgeMonths(null)).toBeNull();
  });
  it("returns null for an unparseable birthdate", () => {
    expect(calculateAge("not-a-date")).toBeNull();
    expect(calculateAgeMonths("not-a-date")).toBeNull();
  });
  it("computes whole years, not yet had this year's birthday", () => {
    const asOf = new Date("2026-03-01T00:00:00Z");
    expect(calculateAge("2000-06-15", asOf)).toBe(25);
  });
  it("computes whole years, birthday already passed this year", () => {
    const asOf = new Date("2026-09-01T00:00:00Z");
    expect(calculateAge("2000-06-15", asOf)).toBe(26);
  });
  it("computes age in months, clamped to zero for a newborn", () => {
    const asOf = new Date("2026-01-01T00:00:00Z");
    expect(calculateAgeMonths("2026-01-01", asOf)).toBe(0);
  });
  it("computes age in months for an infant", () => {
    const asOf = new Date("2026-09-11T00:00:00Z");
    expect(calculateAgeMonths("2026-03-11", asOf)).toBe(6);
  });
  it("never goes negative when the day-of-month hasn't arrived yet", () => {
    const asOf = new Date("2026-09-01T00:00:00Z");
    // ~5 months, 10 days short of 6 full months.
    expect(calculateAgeMonths("2026-03-11", asOf)).toBe(5);
  });
});

describe("filterParamsForPatient", () => {
  const male = numericParam({ id: "p-m", gender: "M" });
  const female = numericParam({ id: "p-f", gender: "F" });
  const either = numericParam({ id: "p-either", gender: null });
  const params = [male, female, either];

  it("keeps only the matching gendered row plus gender-null rows for a known sex", () => {
    expect(filterParamsForPatient(params, "M").map((p) => p.id)).toEqual([
      "p-m",
      "p-either",
    ]);
    expect(filterParamsForPatient(params, "F").map((p) => p.id)).toEqual([
      "p-f",
      "p-either",
    ]);
  });

  it("falls back to the F row when sex is unknown (preview / unset)", () => {
    expect(filterParamsForPatient(params, null).map((p) => p.id)).toEqual([
      "p-f",
      "p-either",
    ]);
  });
});

describe("pickRangeForPatient", () => {
  it("falls back to the param's own ref_*_si/conv when there are no age bands", () => {
    const param = numericParam();
    const range = pickRangeForPatient(param, "F", 300);
    expect(range).toEqual(fallbackRange(param));
  });

  const infantBand: ParamRange = {
    id: "range-infant",
    age_min_months: 0,
    age_max_months: 12,
    gender: null,
    band_label: "0-12mo",
    ref_low_si: 2.5,
    ref_high_si: 5.5,
    ref_low_conv: 45,
    ref_high_conv: 99,
    critical_low_si: 2.0,
    critical_high_si: 8.0,
    critical_low_conv: 36,
    critical_high_conv: 144,
    sort_order: 1,
  };
  const adultFemaleBand: ParamRange = {
    id: "range-adult-f",
    age_min_months: 216, // 18y
    age_max_months: null,
    gender: "F",
    band_label: "adult-F",
    ref_low_si: 3.9,
    ref_high_si: 6.0,
    ref_low_conv: 70,
    ref_high_conv: 108,
    critical_low_si: 2.2,
    critical_high_si: 22.0,
    critical_low_conv: 40,
    critical_high_conv: 396,
    sort_order: 2,
  };
  const adultAnyBand: ParamRange = {
    id: "range-adult-any",
    age_min_months: 216,
    age_max_months: null,
    gender: null,
    band_label: "adult-any",
    ref_low_si: 3.8,
    ref_high_si: 6.2,
    ref_low_conv: 68,
    ref_high_conv: 112,
    critical_low_si: 2.1,
    critical_high_si: 23.0,
    critical_low_conv: 38,
    critical_high_conv: 414,
    sort_order: 3,
  };

  it("picks the age-matching band when no gender-specific row exists", () => {
    const param = numericParam({ ranges: [infantBand] });
    const range = pickRangeForPatient(param, "F", 6);
    expect(range.band_label).toBe("0-12mo");
    expect(range.critical_low_si).toBe(2.0);
  });

  it("prefers an exact-sex band over a gender-null band of the same age tier", () => {
    const param = numericParam({ ranges: [adultAnyBand, adultFemaleBand] });
    const range = pickRangeForPatient(param, "F", 300);
    expect(range.band_label).toBe("adult-F");
  });

  it("falls back to the gender-null band when sex doesn't match any exact row", () => {
    const param = numericParam({ ranges: [adultAnyBand, adultFemaleBand] });
    const range = pickRangeForPatient(param, "M", 300);
    expect(range.band_label).toBe("adult-any");
  });

  it("falls back to the param default when no band's age window matches", () => {
    const param = numericParam({ ranges: [infantBand] });
    const range = pickRangeForPatient(param, "F", 300);
    expect(range).toEqual(fallbackRange(param));
  });

  it("treats a null ageMonths as matching only fully-open (null/null) bands", () => {
    const openBand: ParamRange = { ...adultAnyBand, age_min_months: null, age_max_months: null, band_label: "open" };
    const param = numericParam({ ranges: [infantBand, openBand] });
    const range = pickRangeForPatient(param, "F", null);
    expect(range.band_label).toBe("open");
  });

  it("age window is inclusive of the lower bound and exclusive of the upper bound", () => {
    const param = numericParam({ ranges: [infantBand] });
    expect(pickRangeForPatient(param, "F", 0).band_label).toBe("0-12mo");
    expect(pickRangeForPatient(param, "F", 12).band_label).toBeNull(); // 12 falls OUT of [0,12)
  });
});

describe("computeFlag", () => {
  const param = numericParam();
  const range = fallbackRange(param);

  it("returns null for a blank value", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: 100,
        numeric_value_conv: null,
        select_value: null,
        is_blank: true,
      }),
    ).toBeNull();
  });

  it("returns null for a value inside the reference range", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: 5.0,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("flags L strictly below ref_low_si", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: 3.8,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBe("L");
  });

  it("does NOT flag a value exactly at ref_low_si (inclusive boundary)", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: 3.9,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("flags H strictly above ref_high_si", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: 6.2,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBe("H");
  });

  it("does NOT flag a value exactly at ref_high_si (inclusive boundary)", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: 6.1,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("falls back to numeric_value_conv when SI is missing", () => {
    // conventional-only entry still evaluated against the SI range in the
    // fallback path (mirrors the single-test finalise behaviour).
    const convOnlyRange: EffectiveRange = {
      ref_low_si: 70,
      ref_high_si: 110,
      ref_low_conv: 70,
      ref_high_conv: 110,
      critical_low_si: null,
      critical_high_si: null,
      band_label: null,
    };
    expect(
      computeFlag(param, convOnlyRange, {
        numeric_value_si: null,
        numeric_value_conv: 150,
        select_value: null,
        is_blank: false,
      }),
    ).toBe("H");
  });

  it("returns null when both numeric values are missing", () => {
    expect(
      computeFlag(param, range, {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("returns null when the range has no bounds configured (both null)", () => {
    const openRange: EffectiveRange = {
      ref_low_si: null,
      ref_high_si: null,
      ref_low_conv: null,
      ref_high_conv: null,
      critical_low_si: null,
      critical_high_si: null,
      band_label: null,
    };
    expect(
      computeFlag(param, openRange, {
        numeric_value_si: 999,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("select type: flags A when the value is in abnormal_values", () => {
    const sp = selectParam();
    expect(
      computeFlag(sp, fallbackRange(sp), {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: "positive",
        is_blank: false,
      }),
    ).toBe("A");
  });

  it("select type: returns null when the value is not in abnormal_values", () => {
    const sp = selectParam();
    expect(
      computeFlag(sp, fallbackRange(sp), {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: "negative",
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("select type: returns null when select_value is empty", () => {
    const sp = selectParam();
    expect(
      computeFlag(sp, fallbackRange(sp), {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: null,
        is_blank: false,
      }),
    ).toBeNull();
    expect(
      computeFlag(sp, fallbackRange(sp), {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: "",
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("select type: treats a missing abnormal_values list as never abnormal", () => {
    const sp = selectParam({ abnormal_values: null });
    expect(
      computeFlag(sp, fallbackRange(sp), {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: "positive",
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("free_text type: always returns null", () => {
    const ft = numericParam({ id: "p-ft", input_type: "free_text" });
    expect(
      computeFlag(ft, fallbackRange(ft), {
        numeric_value_si: null,
        numeric_value_conv: null,
        select_value: "anything",
        is_blank: false,
      }),
    ).toBeNull();
  });
});

describe("detectCritical", () => {
  const param = numericParam();
  const range: EffectiveRange = {
    ref_low_si: 3.9,
    ref_high_si: 6.1,
    ref_low_conv: 70,
    ref_high_conv: 110,
    critical_low_si: 2.2,
    critical_high_si: 22.2,
    band_label: null,
  };

  it("returns null for a blank value", () => {
    expect(
      detectCritical(param, range, {
        numeric_value_si: 1.0,
        numeric_value_conv: null,
        is_blank: true,
      }),
    ).toBeNull();
  });

  it("returns null for a non-numeric param", () => {
    const sp = selectParam();
    expect(
      detectCritical(sp, range, {
        numeric_value_si: 1.0,
        numeric_value_conv: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("returns null when no threshold is configured", () => {
    const openRange: EffectiveRange = { ...range, critical_low_si: null, critical_high_si: null };
    expect(
      detectCritical(param, openRange, {
        numeric_value_si: 0.1,
        numeric_value_conv: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("returns null for a value inside both critical bounds", () => {
    expect(
      detectCritical(param, range, {
        numeric_value_si: 5.0,
        numeric_value_conv: null,
        is_blank: false,
      }),
    ).toBeNull();
  });

  it("fires low, inclusive of the exact threshold", () => {
    const hit = detectCritical(param, range, {
      numeric_value_si: 2.2,
      numeric_value_conv: null,
      is_blank: false,
    });
    expect(hit).toEqual({ direction: "low", threshold_si: 2.2, observed_si: 2.2 });
  });

  it("fires low below the threshold", () => {
    const hit = detectCritical(param, range, {
      numeric_value_si: 1.5,
      numeric_value_conv: null,
      is_blank: false,
    });
    expect(hit?.direction).toBe("low");
  });

  it("fires high, inclusive of the exact threshold", () => {
    const hit = detectCritical(param, range, {
      numeric_value_si: 22.2,
      numeric_value_conv: null,
      is_blank: false,
    });
    expect(hit).toEqual({ direction: "high", threshold_si: 22.2, observed_si: 22.2 });
  });

  it("fires high above the threshold", () => {
    const hit = detectCritical(param, range, {
      numeric_value_si: 50,
      numeric_value_conv: null,
      is_blank: false,
    });
    expect(hit?.direction).toBe("high");
  });

  it("falls back to numeric_value_conv when SI is missing", () => {
    const hit = detectCritical(param, range, {
      numeric_value_si: null,
      numeric_value_conv: 999,
      is_blank: false,
    });
    expect(hit?.direction).toBe("high");
    expect(hit?.observed_si).toBe(999);
  });

  it("returns null when both numeric values are missing", () => {
    expect(
      detectCritical(param, range, {
        numeric_value_si: null,
        numeric_value_conv: null,
        is_blank: false,
      }),
    ).toBeNull();
  });
});

describe("formatRefRange", () => {
  it("renders empty string when both bounds are null", () => {
    expect(formatRefRange(null, null)).toBe("");
  });
  it("renders a ≤ high when only high is set", () => {
    expect(formatRefRange(null, 10)).toBe("≤ 10");
  });
  it("renders a ≥ low when only low is set", () => {
    expect(formatRefRange(5, null)).toBe("≥ 5");
  });
  it("renders low – high when both are set", () => {
    expect(formatRefRange(5, 10)).toBe("5 – 10");
  });
});
