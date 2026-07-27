import { describe, expect, it } from "vitest";
import {
  deriveTemplateHealthFindings,
  type TemplateHealthGroup,
} from "./template-health";

function group(overrides: Partial<TemplateHealthGroup>): TemplateHealthGroup {
  return {
    id: "grp-1",
    code: "CHEM",
    name: "Chemistry",
    template: { id: "tpl-1", is_active: true },
    params: [{ id: "param-1", parameter_name: "FBS", gender: null }],
    services: [
      { id: "svc-1", code: "FBS_RBS", name: "FBS", is_active: true, kind: "lab_test" },
    ],
    ...overrides,
  };
}

describe("deriveTemplateHealthFindings", () => {
  it("a fully healthy group produces no findings", () => {
    const g = group({});
    const links = [{ service_id: "svc-1", parameter_id: "param-1" }];
    const out = deriveTemplateHealthFindings({ groups: [g], links });
    expect(out).toEqual([]);
  });

  it("flags an active template with 0 parameters", () => {
    const g = group({ params: [] });
    const out = deriveTemplateHealthFindings({ groups: [g], links: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "template_zero_params",
      severity: "error",
      group_id: "grp-1",
      template_id: "tpl-1",
    });
  });

  it("params-but-zero-mappings where ONLY an inactive service has mappings still flags the group (the masking bug)", () => {
    // The active service (svc-1) has no mapping row; only a retired service
    // (svc-2, is_active: false) has a stale one left over from before it was
    // deactivated. Deactivating a service never clears its
    // report_group_service_params rows, so a naive "any member has a
    // mapping" check would incorrectly treat this group as healthy.
    const g = group({
      services: [
        { id: "svc-1", code: "FBS_RBS", name: "FBS", is_active: true, kind: "lab_test" },
        { id: "svc-2", code: "OLD_FBS", name: "Old FBS", is_active: false, kind: "lab_test" },
      ],
    });
    const links = [{ service_id: "svc-2", parameter_id: "param-1" }];
    const out = deriveTemplateHealthFindings({ groups: [g], links });
    const groupFinding = out.find((f) => f.type === "group_zero_mappings");
    expect(groupFinding).toBeDefined();
    expect(groupFinding).toMatchObject({
      severity: "error",
      group_id: "grp-1",
      template_id: "tpl-1",
    });
    // The unmapped active service also gets its own per-service warning.
    expect(out.some((f) => f.type === "service_zero_mappings" && f.service_id === "svc-1")).toBe(
      true,
    );
    // param-1 is technically mapped (by the retired service), so the
    // unreachable-param check does not also fire here — that check only
    // asks "does any service map to this param", regardless of the
    // service's active status.
    expect(out.some((f) => f.type === "unreachable_param" && f.param_id === "param-1")).toBe(
      false,
    );
  });

  it("flags an active, non-lab_package service that enables nothing, even when the group overall has mappings", () => {
    const g = group({
      params: [
        { id: "param-1", parameter_name: "FBS", gender: null },
        { id: "param-2", parameter_name: "BUN", gender: null },
      ],
      services: [
        { id: "svc-1", code: "FBS_RBS", name: "FBS", is_active: true, kind: "lab_test" },
        { id: "svc-2", code: "BUN", name: "BUN", is_active: true, kind: "lab_test" },
      ],
    });
    // Only svc-1 is mapped; svc-2 enables nothing despite being active and
    // orderable, and despite the group as a whole not being "zero mappings".
    const links = [{ service_id: "svc-1", parameter_id: "param-1" }];
    const out = deriveTemplateHealthFindings({ groups: [g], links });
    expect(out.some((f) => f.type === "group_zero_mappings")).toBe(false);
    const svcFinding = out.find(
      (f) => f.type === "service_zero_mappings" && f.service_id === "svc-2",
    );
    expect(svcFinding).toMatchObject({ severity: "warning", service_code: "BUN" });
    // param-2 is also unreachable (nothing maps to it).
    expect(out.some((f) => f.type === "unreachable_param" && f.param_id === "param-2")).toBe(
      true,
    );
  });

  it("excludes lab_package (billing header) services from the per-service check even when unmapped", () => {
    const g = group({
      services: [
        { id: "svc-1", code: "FBS_RBS", name: "FBS", is_active: true, kind: "lab_test" },
        {
          id: "svc-pkg",
          code: "LIPID_PROFILE_PACKAGE",
          name: "Lipid package",
          is_active: true,
          kind: "lab_package",
        },
      ],
    });
    const links = [{ service_id: "svc-1", parameter_id: "param-1" }];
    const out = deriveTemplateHealthFindings({ groups: [g], links });
    expect(out.some((f) => f.type === "service_zero_mappings" && f.service_id === "svc-pkg")).toBe(
      false,
    );
    expect(out).toEqual([]);
  });

  it("flags a template that is inactive while the group still has active services", () => {
    const g = group({ template: { id: "tpl-1", is_active: false } });
    const out = deriveTemplateHealthFindings({ groups: [g], links: [] });
    const finding = out.find((f) => f.type === "template_inactive_active_services");
    expect(finding).toMatchObject({ severity: "error", template_id: "tpl-1" });
    // An inactive template with 0 active services in the group should not
    // trigger this one.
    const gAllInactive = group({
      template: { id: "tpl-1", is_active: false },
      services: [
        { id: "svc-1", code: "FBS_RBS", name: "FBS", is_active: false, kind: "lab_test" },
      ],
    });
    const out2 = deriveTemplateHealthFindings({ groups: [gAllInactive], links: [] });
    expect(out2.some((f) => f.type === "template_inactive_active_services")).toBe(false);
  });

  it("flags an unreachable param (informational) enabled by no service", () => {
    const g = group({});
    const out = deriveTemplateHealthFindings({ groups: [g], links: [] });
    const finding = out.find((f) => f.type === "unreachable_param");
    expect(finding).toMatchObject({ severity: "info", param_id: "param-1" });
  });

  it("gendered twins: one twin mapped, the other not — only the unmapped twin is flagged", () => {
    const g = group({
      params: [
        { id: "param-uric-f", parameter_name: "Uric Acid", gender: "F" },
        { id: "param-uric-m", parameter_name: "Uric Acid", gender: "M" },
      ],
      services: [
        { id: "svc-bua", code: "BUA_URIC_ACID", name: "Uric Acid", is_active: true, kind: "lab_test" },
      ],
    });
    // Only the female-gendered row is mapped; the male-gendered row is not.
    const links = [{ service_id: "svc-bua", parameter_id: "param-uric-f" }];
    const out = deriveTemplateHealthFindings({ groups: [g], links });
    const unreachable = out.filter((f) => f.type === "unreachable_param");
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]).toMatchObject({ param_id: "param-uric-m" });
    // The group/service checks don't fire — svc-bua does enable a field.
    expect(out.some((f) => f.type === "group_zero_mappings")).toBe(false);
    expect(out.some((f) => f.type === "service_zero_mappings")).toBe(false);
  });

  it("a group with no template row produces no findings", () => {
    const g = group({ template: null });
    const out = deriveTemplateHealthFindings({ groups: [g], links: [] });
    expect(out).toEqual([]);
  });

  it("multiple groups are evaluated independently", () => {
    const healthy = group({});
    const broken = group({
      id: "grp-2",
      code: "URIN",
      name: "Urinalysis",
      template: { id: "tpl-2", is_active: true },
      params: [],
      services: [
        { id: "svc-2", code: "URINE", name: "Urinalysis", is_active: true, kind: "lab_test" },
      ],
    });
    const links = [{ service_id: "svc-1", parameter_id: "param-1" }];
    const out = deriveTemplateHealthFindings({ groups: [healthy, broken], links });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ group_id: "grp-2", type: "template_zero_params" });
  });
});
