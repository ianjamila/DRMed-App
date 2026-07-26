"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export type DeleteSupersededResult =
  | { ok: true }
  | { ok: false; error: string };

// Deletes an unreachable per-service template that a group template
// supersedes. Refuses if any finalised result still references its params
// (same FK protection as the Save action) or if the template is somehow
// still active / not actually superseded.
export async function deleteSupersededTemplateAction(input: {
  templateId: string;
  groupId: string;
}): Promise<DeleteSupersededResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, service_id, is_active")
    .eq("id", input.templateId)
    .maybeSingle();
  if (!tpl || !tpl.service_id) {
    return { ok: false, error: "Template not found (or not a per-service template)." };
  }
  if (tpl.is_active) {
    return { ok: false, error: "Template is still active — deactivate it first." };
  }

  const { data: svc } = await admin
    .from("services")
    .select("id, code, report_group_id")
    .eq("id", tpl.service_id)
    .maybeSingle();
  if (!svc || svc.report_group_id !== input.groupId) {
    return { ok: false, error: "Service is not part of this report group." };
  }

  const { data: params } = await admin
    .from("result_template_params")
    .select("id")
    .eq("template_id", tpl.id);
  const paramIds = (params ?? []).map((r) => r.id);
  if (paramIds.length > 0) {
    const { count: refCount } = await admin
      .from("result_values")
      .select("id", { count: "exact", head: true })
      .in("parameter_id", paramIds);
    if ((refCount ?? 0) > 0) {
      return {
        ok: false,
        error: `Cannot delete: ${refCount} finalised result values still reference this template's params.`,
      };
    }
  }

  const { error: delErr } = await admin.rpc("admin_delete_result_template", {
    p_template_id: tpl.id,
  });
  if (delErr) {
    return { ok: false, error: `Could not delete: ${delErr.message}` };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result_template.superseded_deleted",
    resource_type: "result_template",
    resource_id: tpl.id,
    metadata: {
      service_id: svc.id,
      service_code: svc.code,
      report_group_id: input.groupId,
      param_count: paramIds.length,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/admin/result-templates/group/${input.groupId}/edit`);
  revalidatePath("/staff/admin/result-templates");
  return { ok: true };
}
