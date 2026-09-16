import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  deriveTemplateHealthFindings,
  type TemplateHealthFinding,
  type TemplateHealthGroup,
} from "./template-health";

/** Weekly summaries must not mask a missing daily heartbeat. */
export async function getLastTemplateHealthDailyRun(
  client: SupabaseClient<Database>,
): Promise<Date | null> {
  const { data, error } = await client
    .from("audit_log")
    .select("created_at")
    .eq("action", "result_template.health_alert")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? new Date(data.created_at) : null;
}

/** Shared live scan for the cron and admin health page. The caller supplies its server client. */
export async function collectTemplateHealthFindings(
  admin: SupabaseClient<Database>,
): Promise<{ findings: TemplateHealthFinding[]; counts: Record<string, number> }> {
  const { data: groups } = await admin
    .from("report_groups")
    .select("id, code, name, is_active");
  const groupList = groups ?? [];
  if (groupList.length === 0) {
    return { findings: [], counts: {} };
  }
  const groupIds = groupList.map((g) => g.id);

  const { data: services } = await admin
    .from("services")
    .select("id, code, name, kind, is_active, report_group_id")
    .in("report_group_id", groupIds);
  const serviceList = services ?? [];

  const { data: groupTemplates } = await admin
    .from("result_templates")
    .select("id, report_group_id, is_active")
    .in("report_group_id", groupIds);
  const templateList = groupTemplates ?? [];
  const templateByGroup = new Map(templateList.map((t) => [t.report_group_id!, t]));
  const templateIds = templateList.map((t) => t.id);

  const { data: paramRows } = templateIds.length
    ? await admin
        .from("result_template_params")
        .select("id, template_id, parameter_name, gender")
        .in("template_id", templateIds)
    : {
        data: [] as {
          id: string;
          template_id: string;
          parameter_name: string;
          gender: string | null;
        }[],
      };
  const paramsByTemplate = new Map<
    string,
    { id: string; parameter_name: string; gender: string | null }[]
  >();
  for (const p of paramRows ?? []) {
    const arr = paramsByTemplate.get(p.template_id) ?? [];
    arr.push({ id: p.id, parameter_name: p.parameter_name, gender: p.gender });
    paramsByTemplate.set(p.template_id, arr);
  }
  const paramIds = (paramRows ?? []).map((p) => p.id);

  const { data: mapRows } = paramIds.length
    ? await admin
        .from("report_group_service_params")
        .select("service_id, parameter_id")
        .in("parameter_id", paramIds)
    : { data: [] as { service_id: string; parameter_id: string }[] };

  // M17: per-service templates on a grouped service are dead on arrival
  // (the queue always redirects a grouped service to the consolidated
  // form). serviceList is already scoped to services in one of the groups
  // fetched above, so this only needs to look up templates for THOSE
  // service ids.
  const serviceIds = serviceList.map((s) => s.id);
  const { data: serviceTemplateRows } = serviceIds.length
    ? await admin
        .from("result_templates")
        .select("service_id, is_active, id")
        .in("service_id", serviceIds)
    : { data: [] as { service_id: string | null; is_active: boolean; id: string }[] };

  const groupsInput: TemplateHealthGroup[] = groupList.map((g) => {
    const tpl = templateByGroup.get(g.id) ?? null;
    return {
      id: g.id,
      code: g.code,
      name: g.name,
      template: tpl ? { id: tpl.id, is_active: tpl.is_active } : null,
      params: tpl ? (paramsByTemplate.get(tpl.id) ?? []) : [],
      services: serviceList
        .filter((s) => s.report_group_id === g.id)
        .map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          is_active: s.is_active,
          kind: s.kind,
        })),
    };
  });

  const serviceTemplates = (serviceTemplateRows ?? [])
    .filter((t): t is { service_id: string; is_active: boolean; id: string } => !!t.service_id)
    .map((t) => ({ service_id: t.service_id, template_id: t.id, is_active: t.is_active }));

  const findings = deriveTemplateHealthFindings({
    groups: groupsInput,
    links: mapRows ?? [],
    serviceTemplates,
  });

  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;


  return { findings, counts };
}
