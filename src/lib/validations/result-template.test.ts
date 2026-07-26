import { describe, expect, it } from "vitest";
import {
  TemplateEditorPayloadSchema,
  TemplateTargetSchema,
} from "./result-template";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const baseParam = {
  id: null,
  parameter_name: "FBS",
  input_type: "numeric",
  section: null,
  is_section_header: false,
  unit_si: "mmol/L",
  unit_conv: "mg/dL",
  ref_low_si: 4.1,
  ref_high_si: 5.9,
  ref_low_conv: null,
  ref_high_conv: null,
  gender: null,
  si_to_conv_factor: 18.0182,
  allowed_values: null,
  abnormal_values: null,
  placeholder: null,
  ranges: [],
};

describe("TemplateTargetSchema", () => {
  it("accepts a service target", () => {
    expect(
      TemplateTargetSchema.parse({ kind: "service", id: UUID_A }),
    ).toEqual({ kind: "service", id: UUID_A });
  });

  it("accepts a group target", () => {
    expect(TemplateTargetSchema.parse({ kind: "group", id: UUID_A })).toEqual({
      kind: "group",
      id: UUID_A,
    });
  });

  it("rejects an unknown kind", () => {
    expect(
      TemplateTargetSchema.safeParse({ kind: "panel", id: UUID_A }).success,
    ).toBe(false);
  });
});

describe("TemplateEditorPayloadSchema", () => {
  const payload = {
    target: { kind: "group", id: UUID_A },
    layout: "dual_unit",
    header_notes: null,
    footer_notes: null,
    is_active: true,
    params: [baseParam],
  };

  it("parses a group payload; service_ids defaults to null", () => {
    const out = TemplateEditorPayloadSchema.parse(payload);
    expect(out.target).toEqual({ kind: "group", id: UUID_A });
    expect(out.params[0].service_ids).toBeNull();
  });

  it("carries service_ids through when provided", () => {
    const out = TemplateEditorPayloadSchema.parse({
      ...payload,
      params: [{ ...baseParam, service_ids: [UUID_B] }],
    });
    expect(out.params[0].service_ids).toEqual([UUID_B]);
  });

  it("rejects non-uuid service_ids", () => {
    const res = TemplateEditorPayloadSchema.safeParse({
      ...payload,
      params: [{ ...baseParam, service_ids: ["not-a-uuid"] }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects a payload still using the old service_id key", () => {
    const legacy = { ...payload, target: undefined, service_id: UUID_A };
    expect(TemplateEditorPayloadSchema.safeParse(legacy).success).toBe(false);
  });
});
