import { describe, expect, it } from "vitest";
import {
  buildValueRows,
  detectCrossings,
  mergeValueRows,
  missingParams,
  missingParamsError,
  valueRowsToDocValues,
  type SubmittedValue,
  type ValueRow,
} from "./value-rows";
import type { ParamRange, TemplateParam } from "./types";

// Pure module — no server-only imports. Every export of value-rows.ts is the
// ONE place structured writes (single-test + consolidated, draft/finalise/
// edit) build flags, doc values and critical crossings, so drift here would
// drift the PDF away from the database. Exercise every boundary hard.

function submitted(overrides: Partial<SubmittedValue> = {}): SubmittedValue {
  return {
    numeric_value_si: null,
    numeric_value_conv: null,
    text_value: null,
    select_value: null,
    is_blank: false,
    ...overrides,
  };
}

function childRange(overrides: Partial<ParamRange> = {}): ParamRange {
  return {
    id: "range-child",
    age_min_months: 0,
    age_max_months: 144, // < 12y
    gender: null,
    band_label: "Child",
    ref_low_si: 3.3,
    ref_high_si: 5.5,
    ref_low_conv: 60,
    ref_high_conv: 99,
    critical_low_si: 2.2,
    critical_high_si: 8.0,
    critical_low_conv: null,
    critical_high_conv: null,
    sort_order: 1,
    ...overrides,
  };
}

function adultRange(overrides: Partial<ParamRange> = {}): ParamRange {
  return {
    id: "range-adult",
    age_min_months: 144,
    age_max_months: null,
    gender: null,
    band_label: "Adult",
    ref_low_si: 3.9,
    ref_high_si: 6.1,
    ref_low_conv: 70,
    ref_high_conv: 110,
    critical_low_si: 2.5,
    critical_high_si: 22.2,
    critical_low_conv: null,
    critical_high_conv: null,
    sort_order: 2,
    ...overrides,
  };
}

function numericParam(overrides: Partial<TemplateParam> = {}): TemplateParam {
  return {
    id: "param-glucose",
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
    ranges: [childRange(), adultRange()],
    ...overrides,
  };
}

function selectParam(overrides: Partial<TemplateParam> = {}): TemplateParam {
  return {
    ...numericParam(),
    id: "param-urine-protein",
    parameter_name: "Urine protein",
    input_type: "select",
    ranges: [],
    allowed_values: ["negative", "trace", "positive"],
    abnormal_values: ["trace", "positive"],
    ...overrides,
  };
}

function sectionHeader(overrides: Partial<TemplateParam> = {}): TemplateParam {
  return {
    ...numericParam(),
    id: "param-header",
    parameter_name: "Lipid Panel",
    is_section_header: true,
    input_type: "free_text",
    ranges: [],
    ...overrides,
  };
}

function freeTextParam(overrides: Partial<TemplateParam> = {}): TemplateParam {
  return {
    ...numericParam(),
    id: "param-notes",
    parameter_name: "Notes",
    input_type: "free_text",
    ranges: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildValueRows
// ---------------------------------------------------------------------------

describe("buildValueRows", () => {
  it("flags the SAME value differently at two ages via age-banded ranges", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);
    // 6.5 is inside the child band's ref_high (5.5)? no — above it (H). It is
    // inside the adult band (3.9-6.1)? also above (still H at 6.1)... pick a
    // value that is genuinely flagged one way at one age and normal at the
    // other: 5.8 is ABOVE the child high (5.5) but WITHIN the adult range
    // (3.9-6.1).
    const values = { [param.id]: submitted({ numeric_value_si: 5.8 }) };

    const childRows = buildValueRows(values, paramsById, {
      sex: null,
      ageMonths: 60, // 5 years old -> child band
    });
    const adultRows = buildValueRows(values, paramsById, {
      sex: null,
      ageMonths: 300, // 25 years old -> adult band
    });

    expect(childRows[0].flag).toBe("H");
    expect(adultRows[0].flag).toBeNull();
  });

  it("flags a select param's abnormal value as 'A'", () => {
    const param = selectParam();
    const paramsById = new Map([[param.id, param]]);
    const values = {
      [param.id]: submitted({ select_value: "trace" }),
    };

    const rows = buildValueRows(values, paramsById, { sex: "F", ageMonths: 300 });

    expect(rows[0].flag).toBe("A");
  });

  it("gives a blank value a null flag", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);
    const values = {
      [param.id]: submitted({ is_blank: true }),
    };

    const rows = buildValueRows(values, paramsById, { sex: null, ageMonths: 300 });

    expect(rows[0].flag).toBeNull();
  });

  it("gives an unknown parameter (not in paramsById) a null flag", () => {
    const paramsById = new Map<string, TemplateParam>(); // empty — param-x is unknown
    const values = {
      "param-x": submitted({ numeric_value_si: 999 }),
    };

    const rows = buildValueRows(values, paramsById, { sex: null, ageMonths: 300 });

    expect(rows).toHaveLength(1);
    expect(rows[0].parameter_id).toBe("param-x");
    expect(rows[0].flag).toBeNull();
  });

  it("preserves every submitted field alongside the computed flag", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);
    const sv = submitted({ numeric_value_si: 5.0, numeric_value_conv: 90, is_blank: false });
    const rows = buildValueRows({ [param.id]: sv }, paramsById, { sex: null, ageMonths: 300 });

    expect(rows[0]).toEqual({
      parameter_id: param.id,
      numeric_value_si: 5.0,
      numeric_value_conv: 90,
      text_value: null,
      select_value: null,
      is_blank: false,
      flag: null,
    });
  });
});

// ---------------------------------------------------------------------------
// valueRowsToDocValues
// ---------------------------------------------------------------------------

describe("valueRowsToDocValues", () => {
  it("keys the same rows by parameter_id, dropping parameter_id from the value", () => {
    const rows: ValueRow[] = [
      {
        parameter_id: "p1",
        numeric_value_si: 5,
        numeric_value_conv: 90,
        text_value: null,
        select_value: null,
        is_blank: false,
        flag: "H",
      },
      {
        parameter_id: "p2",
        numeric_value_si: null,
        numeric_value_conv: null,
        text_value: "note",
        select_value: null,
        is_blank: false,
        flag: null,
      },
    ];

    const out = valueRowsToDocValues(rows);

    expect(Object.keys(out)).toEqual(["p1", "p2"]);
    expect(out.p1).toEqual({
      numeric_value_si: 5,
      numeric_value_conv: 90,
      text_value: null,
      select_value: null,
      flag: "H",
      is_blank: false,
    });
    expect(out.p2.text_value).toBe("note");
  });

  it("returns an empty object for an empty input", () => {
    expect(valueRowsToDocValues([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mergeValueRows
// ---------------------------------------------------------------------------

function row(parameterId: string, numeric: number | null): ValueRow {
  return {
    parameter_id: parameterId,
    numeric_value_si: numeric,
    numeric_value_conv: null,
    text_value: null,
    select_value: null,
    is_blank: false,
    flag: null,
  };
}

describe("mergeValueRows", () => {
  it("overrides a base row with next's row for the same id", () => {
    const base = [row("p1", 1)];
    const next = [row("p1", 2)];

    const merged = mergeValueRows(base, next);

    expect(merged).toHaveLength(1);
    expect(merged[0].numeric_value_si).toBe(2);
  });

  it("keeps a base-only row the form did not resend", () => {
    const base = [row("p1", 1), row("p2", 2)];
    const next = [row("p1", 99)];

    const merged = mergeValueRows(base, next);

    expect(merged.map((r) => r.parameter_id).sort()).toEqual(["p1", "p2"]);
    expect(merged.find((r) => r.parameter_id === "p2")?.numeric_value_si).toBe(2);
  });

  it("keeps insertion order: overridden ids stay at their base position, new ids append", () => {
    const base = [row("p1", 1), row("p2", 2), row("p3", 3)];
    const next = [row("p2", 20), row("p4", 4)];

    const merged = mergeValueRows(base, next);

    expect(merged.map((r) => r.parameter_id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(merged.find((r) => r.parameter_id === "p2")?.numeric_value_si).toBe(20);
  });

  it("returns next's rows unchanged when base is empty", () => {
    const merged = mergeValueRows([], [row("p1", 1)]);
    expect(merged).toEqual([row("p1", 1)]);
  });
});

// ---------------------------------------------------------------------------
// detectCrossings
// ---------------------------------------------------------------------------

describe("detectCrossings", () => {
  const patient = { sex: null, ageMonths: 300 }; // adult band: critical 2.5 / 22.2

  it("detects a critical LOW crossing at the threshold (inclusive)", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);
    const rows: ValueRow[] = [row(param.id, 2.5)];

    const alerts = detectCrossings(rows, paramsById, patient, () => "tr-1");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      test_request_id: "tr-1",
      parameter_id: param.id,
      direction: "low",
      observed_value_si: 2.5,
      threshold_si: 2.5,
    });
  });

  it("detects a critical HIGH crossing at the threshold (inclusive)", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);
    const rows: ValueRow[] = [row(param.id, 22.2)];

    const alerts = detectCrossings(rows, paramsById, patient, () => "tr-1");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ direction: "high", observed_value_si: 22.2, threshold_si: 22.2 });
  });

  it("does not fire just inside the thresholds", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);

    const alerts = detectCrossings([row(param.id, 2.6)], paramsById, patient, () => "tr-1");

    expect(alerts).toHaveLength(0);
  });

  it("skips a row when testRequestFor returns null", () => {
    const param = numericParam();
    const paramsById = new Map([[param.id, param]]);
    const rows: ValueRow[] = [row(param.id, 2.5)]; // would otherwise be critical

    const alerts = detectCrossings(rows, paramsById, patient, () => null);

    expect(alerts).toHaveLength(0);
  });

  it("skips a section header row", () => {
    const header = sectionHeader();
    const paramsById = new Map([[header.id, header]]);
    const rows: ValueRow[] = [row(header.id, 2.5)];

    const alerts = detectCrossings(rows, paramsById, patient, () => "tr-1");

    expect(alerts).toHaveLength(0);
  });

  it("skips a row whose parameter is not in paramsById", () => {
    const paramsById = new Map<string, TemplateParam>();
    const rows: ValueRow[] = [row("unknown-param", 2.5)];

    const alerts = detectCrossings(rows, paramsById, patient, () => "tr-1");

    expect(alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// missingParams / missingParamsError
// ---------------------------------------------------------------------------

describe("missingParams", () => {
  it("flags a numeric param with no value as missing", () => {
    const p = numericParam();
    const missing = missingParams([p], {});
    expect(missing).toEqual([p]);
  });

  it("does not flag a numeric param with a numeric_value_conv but no _si", () => {
    const p = numericParam();
    const values = { [p.id]: submitted({ numeric_value_conv: 90 }) };
    expect(missingParams([p], values)).toEqual([]);
  });

  it("flags a select param with no select_value as missing", () => {
    const p = selectParam();
    const values = { [p.id]: submitted({ select_value: null }) };
    expect(missingParams([p], values)).toEqual([p]);
  });

  it("does not flag a select param with a select_value", () => {
    const p = selectParam();
    const values = { [p.id]: submitted({ select_value: "negative" }) };
    expect(missingParams([p], values)).toEqual([]);
  });

  it("flags a free_text param with an empty/whitespace-only text_value as missing", () => {
    const p = freeTextParam();
    expect(missingParams([p], { [p.id]: submitted({ text_value: "   " }) })).toEqual([p]);
    expect(missingParams([p], { [p.id]: submitted({ text_value: "" }) })).toEqual([p]);
  });

  it("does not flag a free_text param with real text", () => {
    const p = freeTextParam();
    const values = { [p.id]: submitted({ text_value: "unremarkable" }) };
    expect(missingParams([p], values)).toEqual([]);
  });

  it("counts is_blank as filled for every input type", () => {
    const numeric = numericParam();
    const select = selectParam();
    const text = freeTextParam();
    const values = {
      [numeric.id]: submitted({ is_blank: true }),
      [select.id]: submitted({ is_blank: true }),
      [text.id]: submitted({ is_blank: true }),
    };

    expect(missingParams([numeric, select, text], values)).toEqual([]);
  });

  it("skips section headers entirely", () => {
    const header = sectionHeader();
    expect(missingParams([header], {})).toEqual([]);
  });
});

describe("missingParamsError", () => {
  it("lists up to 5 missing parameter names with no ellipsis", () => {
    const missing = ["A", "B", "C"].map((n) =>
      numericParam({ id: n, parameter_name: n }),
    );
    const msg = missingParamsError(missing);
    expect(msg).toBe(
      "Missing values for: A, B, C. Mark blank if you didn't run the sub-test.",
    );
  });

  it("truncates to the first 5 names and appends an ellipsis past 5", () => {
    const missing = ["A", "B", "C", "D", "E", "F", "G"].map((n) =>
      numericParam({ id: n, parameter_name: n }),
    );
    const msg = missingParamsError(missing);
    expect(msg).toBe(
      "Missing values for: A, B, C, D, E…. Mark blank if you didn't run the sub-test.",
    );
  });

  it("shows exactly 5 names with no ellipsis at the boundary", () => {
    const missing = ["A", "B", "C", "D", "E"].map((n) =>
      numericParam({ id: n, parameter_name: n }),
    );
    const msg = missingParamsError(missing);
    expect(msg).not.toContain("…");
    expect(msg).toContain("A, B, C, D, E.");
  });
});
