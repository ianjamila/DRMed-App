import { describe, expect, it } from "vitest";
import {
  deriveTemplateHealthFindings,
  isTemplateHealthStale,
  shouldEmailTemplateHealth,
  TEMPLATE_HEALTH_STALE_AFTER_HOURS,
  type TemplateHealthFinding,
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

describe("isTemplateHealthStale", () => {
  const now = new Date("2026-09-16T22:00:00Z");
  const thresholdMs = TEMPLATE_HEALTH_STALE_AFTER_HOURS * 60 * 60 * 1000;

  it("a fresh daily run is not stale", () => {
    expect(isTemplateHealthStale(new Date(now.getTime() - 24 * 60 * 60 * 1000), now)).toBe(false);
  });

  it("a run exactly at the threshold is not stale", () => {
    expect(isTemplateHealthStale(new Date(now.getTime() - thresholdMs), now)).toBe(false);
  });

  it("a run past the threshold is stale", () => {
    expect(isTemplateHealthStale(new Date(now.getTime() - thresholdMs - 1), now)).toBe(true);
  });

  it("no prior run is stale", () => {
    expect(isTemplateHealthStale(null, now)).toBe(true);
  });
});

describe("shouldEmailTemplateHealth", () => {
  const finding = (severity: TemplateHealthFinding["severity"]): TemplateHealthFinding => ({
    type: "stray_service_template",
    severity,
    group_id: "grp-1",
    group_code: "CHEMISTRY",
    group_name: "Chemistry",
    template_id: "stray-tpl",
    message: "Template finding",
  });

  it("keeps info-only findings silent daily but includes them in the weekly digest", () => {
    const findings = [finding("info")];
    expect(shouldEmailTemplateHealth(findings, "daily")).toBe(false);
    expect(shouldEmailTemplateHealth(findings, "weekly")).toBe(true);
  });

  it("does not email an empty scan in either mode", () => {
    expect(shouldEmailTemplateHealth([], "daily")).toBe(false);
    expect(shouldEmailTemplateHealth([], "weekly")).toBe(false);
  });

  it("a recovered daily gap overrides the info-only mute", () => {
    const findings = [finding("info")];
    expect(shouldEmailTemplateHealth(findings, "daily", true)).toBe(true);
    expect(shouldEmailTemplateHealth(findings, "daily", false)).toBe(false);
  });

  it.each(["daily", "weekly"] as const)("%s emails zero findings only when the daily heartbeat is stale", (mode) => {
    expect(shouldEmailTemplateHealth([], mode, true)).toBe(true);
    expect(shouldEmailTemplateHealth([], mode, false)).toBe(false);
  });

  it.each(["error", "warning"] as const)("emails %s findings in both modes, including alongside info", (severity) => {
    for (const findings of [[finding(severity)], [finding("info"), finding(severity)]]) {
      expect(shouldEmailTemplateHealth(findings, "daily")).toBe(true);
      expect(shouldEmailTemplateHealth(findings, "weekly")).toBe(true);
    }
  });
});

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

  it("flags an active stray per-service template as a warning on a service that belongs to the group (M17)", () => {
    const g = group({});
    const out = deriveTemplateHealthFindings({
      groups: [g],
      links: [{ service_id: "svc-1", parameter_id: "param-1" }],
      serviceTemplates: [{ service_id: "svc-1", template_id: "stray-tpl", is_active: true }],
    });
    const finding = out.find((f) => f.type === "stray_service_template");
    expect(finding).toMatchObject({
      severity: "warning",
      group_id: "grp-1",
      service_id: "svc-1",
      service_code: "FBS_RBS",
      template_id: "stray-tpl",
    });
  });

  it("reports an inactive stray per-service template as informational history", () => {
    const g = group({});
    const out = deriveTemplateHealthFindings({
      groups: [g],
      links: [{ service_id: "svc-1", parameter_id: "param-1" }],
      serviceTemplates: [{ service_id: "svc-1", template_id: "stray-tpl", is_active: false }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "stray_service_template",
      severity: "info",
      group_id: "grp-1",
      group_code: "CHEM",
      group_name: "Chemistry",
      template_id: "stray-tpl",
      service_id: "svc-1",
      service_code: "FBS_RBS",
    });
    expect(out[0].message).toContain("inactive leftover");
    expect(out[0].message).toContain("retained as history");
    expect(out[0].message).toContain("superseded by the Chemistry group's consolidated template");
  });

  it("a mapped chemistry group with inactive stray templates produces no errors or warnings", () => {
    const codes = [
      "BUA_URIC_ACID", "BUN", "CHOLESTEROL", "CREATININE", "FBS_RBS",
      "HBA1C", "HDL_LDL_VLDL", "LIPID_PROFILE", "LIPID_PROFILE_PACKAGE",
      "SGOT_AST", "SGPT_ALT", "TRIGLYCERIDES",
    ];
    const services = codes.map((code) => ({
      id: `svc-${code}`,
      code,
      name: code,
      is_active: true,
      kind: code === "LIPID_PROFILE_PACKAGE" ? "lab_package" : "lab_test",
    }));
    const orderableServices = services.filter((s) => s.kind !== "lab_package");
    const g = group({
      code: "CHEMISTRY",
      services,
      params: orderableServices.map((s) => ({
        id: `param-${s.code}`,
        parameter_name: s.name,
        gender: null,
      })),
    });
    const out = deriveTemplateHealthFindings({
      groups: [g],
      links: orderableServices.map((s) => ({
        service_id: s.id,
        parameter_id: `param-${s.code}`,
      })),
      serviceTemplates: services.map((s) => ({
        service_id: s.id,
        template_id: `stray-${s.code}`,
        is_active: false,
      })),
    });
    expect(out).toHaveLength(12);
    expect(out.filter((f) => f.severity === "error")).toHaveLength(0);
    expect(out.filter((f) => f.severity === "warning")).toHaveLength(0);
    expect(out.every((f) => f.type === "stray_service_template" && f.severity === "info")).toBe(
      true,
    );
  });

  it("stray per-service template still flags even when the group has no template of its own", () => {
    const g = group({ template: null, params: [] });
    const out = deriveTemplateHealthFindings({
      groups: [g],
      links: [],
      serviceTemplates: [{ service_id: "svc-1", template_id: "stray-tpl", is_active: false }],
    });
    expect(out).toEqual([
      expect.objectContaining({ type: "stray_service_template", service_id: "svc-1" }),
    ]);
  });

  it("no serviceTemplates input means no stray-template findings at all", () => {
    const g = group({});
    const out = deriveTemplateHealthFindings({
      groups: [g],
      links: [{ service_id: "svc-1", parameter_id: "param-1" }],
    });
    expect(out.some((f) => f.type === "stray_service_template")).toBe(false);
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
