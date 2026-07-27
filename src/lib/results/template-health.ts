// Pure derivation of report-group template drift findings — the class of
// failure that let the CHEMISTRY consolidated template silently lose 13 of
// 14 params and sit broken for ~2 months (0115/0121/0122 all trace back to
// that incident). Used by the daily cron (src/app/api/cron/template-health)
// but kept free of "server-only" imports so it is unit-testable, same split
// as deriveEnabledParamIds.

export interface TemplateHealthFinding {
  type:
    | "template_zero_params"
    | "group_zero_mappings"
    | "service_zero_mappings"
    | "template_inactive_active_services"
    | "unreachable_param";
  severity: "error" | "warning" | "info";
  group_id: string;
  group_code: string;
  group_name: string;
  template_id: string | null;
  service_id?: string;
  service_code?: string;
  param_id?: string;
  param_name?: string;
  message: string;
}

export interface TemplateHealthParam {
  id: string;
  parameter_name: string;
  gender: string | null;
}

export interface TemplateHealthService {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  kind: string;
}

export interface TemplateHealthGroup {
  id: string;
  code: string;
  name: string;
  // null when the group has no template row yet — nothing to check.
  template: { id: string; is_active: boolean } | null;
  params: TemplateHealthParam[];
  services: TemplateHealthService[];
}

export interface TemplateHealthLink {
  service_id: string;
  parameter_id: string;
}

export interface TemplateHealthInput {
  groups: TemplateHealthGroup[];
  links: TemplateHealthLink[];
}

export function deriveTemplateHealthFindings(
  input: TemplateHealthInput,
): TemplateHealthFinding[] {
  const mappedServiceIdsByParam = new Map<string, Set<string>>();
  const mappedParamCountByService = new Map<string, number>();
  for (const link of input.links) {
    const set = mappedServiceIdsByParam.get(link.parameter_id) ?? new Set<string>();
    set.add(link.service_id);
    mappedServiceIdsByParam.set(link.parameter_id, set);
    mappedParamCountByService.set(
      link.service_id,
      (mappedParamCountByService.get(link.service_id) ?? 0) + 1,
    );
  }

  const findings: TemplateHealthFinding[] = [];

  for (const g of input.groups) {
    const tpl = g.template;
    const members = g.services;
    const activeMembers = members.filter((s) => s.is_active);
    const params = g.params;
    // Orderable members: active, non-lab_package. Billing headers (lab
    // packages) enable no fields themselves and never carry mapping rows —
    // and a deactivated service keeps its stale report_group_service_params
    // rows forever (deactivating a service never clears them), so it must
    // not count as "this group has a working mapping" either. Checks 2 and 3
    // both scope to this same set for that reason.
    const orderableMembers = members.filter(
      (s) => s.is_active && s.kind !== "lab_package",
    );

    // 1. Active template, 0 params — encoding form broken.
    if (tpl && tpl.is_active && params.length === 0) {
      findings.push({
        type: "template_zero_params",
        severity: "error",
        group_id: g.id,
        group_code: g.code,
        group_name: g.name,
        template_id: tpl.id,
        message: `${g.name}: active group template has 0 parameters — the encoding form is broken.`,
      });
    }

    // 2. Active template with params but zero mappings across the whole
    // group's orderable services. Scoped to orderableMembers (not all
    // members) so a retired service's leftover mapping rows can't mask a
    // group that has actually gone fully unmapped.
    const groupHasAnyMapping = orderableMembers.some(
      (m) => (mappedParamCountByService.get(m.id) ?? 0) > 0,
    );
    if (tpl && tpl.is_active && params.length > 0 && !groupHasAnyMapping) {
      findings.push({
        type: "group_zero_mappings",
        severity: "error",
        group_id: g.id,
        group_code: g.code,
        group_name: g.name,
        template_id: tpl.id,
        message: `${g.name}: no service is mapped to this template's fields — every field on the consolidated encoding form is disabled.`,
      });
    }

    // 3. Individual active, non-lab_package service with zero mappings to
    // its group's active template. Only meaningful once the template itself
    // has params and is active — checks 1/2 already cover the fully-broken
    // cases and would otherwise be redundant with this one.
    if (tpl && tpl.is_active && params.length > 0) {
      for (const svc of orderableMembers) {
        const enabledCount = mappedParamCountByService.get(svc.id) ?? 0;
        if (enabledCount === 0) {
          findings.push({
            type: "service_zero_mappings",
            severity: "warning",
            group_id: g.id,
            group_code: g.code,
            group_name: g.name,
            template_id: tpl.id,
            service_id: svc.id,
            service_code: svc.code,
            message: `${svc.code} (${g.name}): this orderable service enables no fields on the consolidated form.`,
          });
        }
      }
    }

    // 4. Template inactive while the group still has active services.
    if (tpl && !tpl.is_active && activeMembers.length > 0) {
      findings.push({
        type: "template_inactive_active_services",
        severity: "error",
        group_id: g.id,
        group_code: g.code,
        group_name: g.name,
        template_id: tpl.id,
        message: `${g.name}: template is inactive but ${activeMembers.length} service(s) in the group are active — the consolidated queue form will not load.`,
      });
    }

    // 5. Informational: a param of an active template enabled by no
    // service. Gendered twins (e.g. Creatinine-F / Creatinine-M) are
    // separate param rows with separate ids — each is checked independently,
    // so one twin being mapped never hides the other twin going unmapped.
    if (tpl && tpl.is_active && params.length > 0) {
      for (const p of params) {
        const enabledBy = mappedServiceIdsByParam.get(p.id)?.size ?? 0;
        if (enabledBy === 0) {
          findings.push({
            type: "unreachable_param",
            severity: "info",
            group_id: g.id,
            group_code: g.code,
            group_name: g.name,
            template_id: tpl.id,
            param_id: p.id,
            param_name: p.parameter_name,
            message: `${g.name}: "${p.parameter_name}" is not enabled by any service — unreachable field.`,
          });
        }
      }
    }
  }

  return findings;
}
