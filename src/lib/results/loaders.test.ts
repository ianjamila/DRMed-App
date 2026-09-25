import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isTemplateParamsLoadError, loadTemplateParams } from "./loaders";

// A failed range read must not quietly produce params with no age bands: every
// write path computes flags and critical alerts from them (Codex, 2026-09-25).
function fakeClient({ paramErr = false, rangeErr = false } = {}) {
  const param = {
    id: "p1", sort_order: 1, section: null, is_section_header: false, parameter_name: "K",
    input_type: "numeric", unit_si: "mmol/L", unit_conv: null, ref_low_si: 3.5, ref_high_si: 5.1,
    ref_low_conv: null, ref_high_conv: null, gender: null, si_to_conv_factor: null,
    allowed_values: null, abnormal_values: null, placeholder: null,
  };
  const range = {
    id: "g1", parameter_id: "p1", age_min_months: null, age_max_months: null, gender: null,
    band_label: null, ref_low_si: 3.5, ref_high_si: 5.1, ref_low_conv: null, ref_high_conv: null,
    critical_low_si: 2.5, critical_high_si: 6.5, critical_low_conv: null, critical_high_conv: null, sort_order: 1,
  };
  const table = (rows: unknown[], fail: boolean) => {
    const q = {
      select: () => q, eq: () => q, in: () => q,
      order: async () => (fail ? { data: null, error: { message: "timeout" } } : { data: rows, error: null }),
    };
    return q;
  };
  return {
    from: (t: string) =>
      t === "result_template_params" ? table([param], paramErr) : table([range], rangeErr),
  } as unknown as SupabaseClient<Database>;
}

describe("loadTemplateParams", () => {
  it("attaches the age bands (with critical thresholds) when both reads succeed", async () => {
    const [p] = await loadTemplateParams(fakeClient(), "tpl", { strict: true });
    expect(p.ranges?.[0]?.critical_high_si).toBe(6.5);
  });

  it("strict: a failed RANGE read throws instead of returning params with no bands", async () => {
    const err = await loadTemplateParams(fakeClient({ rangeErr: true }), "tpl", { strict: true }).catch((e) => e);
    expect(isTemplateParamsLoadError(err)).toBe(true);
  });

  it("strict: a failed PARAM read throws instead of returning no params", async () => {
    const err = await loadTemplateParams(fakeClient({ paramErr: true }), "tpl", { strict: true }).catch((e) => e);
    expect(isTemplateParamsLoadError(err)).toBe(true);
  });

  it("lenient (display pages): degrades as before", async () => {
    const [p] = await loadTemplateParams(fakeClient({ rangeErr: true }), "tpl");
    expect(p.ranges ?? []).toEqual([]);
    expect(await loadTemplateParams(fakeClient({ paramErr: true }), "tpl")).toEqual([]);
  });
});
