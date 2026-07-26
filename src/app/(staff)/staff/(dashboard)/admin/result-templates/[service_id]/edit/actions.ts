"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  TemplateEditorPayloadSchema,
  type TemplateEditorPayload,
} from "@/lib/validations/result-template";

export type SaveTemplateResult =
  | { ok: true; templateId: string }
  | { ok: false; error: string };

export async function saveTemplateAndParamsAction(
  payload: TemplateEditorPayload,
): Promise<SaveTemplateResult> {
  const session = await requireAdminStaff();

  const parsed = TemplateEditorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid template payload.",
    };
  }
  const data = parsed.data;

  const admin = createAdminClient();

  // Resolve the target — a service or a report group. groupServiceIds doubles
  // as the validation set for per-param service_ids.
  let targetLabel: { code: string; name: string };
  let groupServiceIds: Set<string> | null = null;

  if (data.target.kind === "service") {
    const { data: svc } = await admin
      .from("services")
      .select("id, code, name")
      .eq("id", data.target.id)
      .maybeSingle();
    if (!svc) return { ok: false, error: "Service not found." };
    targetLabel = { code: svc.code, name: svc.name };
  } else {
    const { data: grp } = await admin
      .from("report_groups")
      .select("id, code, name")
      .eq("id", data.target.id)
      .maybeSingle();
    if (!grp) return { ok: false, error: "Report group not found." };
    targetLabel = { code: grp.code, name: grp.name };

    const { data: groupSvcs } = await admin
      .from("services")
      .select("id, kind")
      .eq("report_group_id", data.target.id);
    // Billing headers (lab_package) can't enable fields — the UI already
    // excludes them from the mappable-services list, so exclude them here
    // too or a hand-crafted payload could map a service_id that isn't a
    // real encoding target.
    groupServiceIds = new Set(
      (groupSvcs ?? []).filter((s) => s.kind !== "lab_package").map((s) => s.id),
    );
    for (const p of data.params) {
      for (const sid of p.service_ids ?? []) {
        if (!groupServiceIds.has(sid)) {
          return {
            ok: false,
            error: `"${p.parameter_name}" maps a service that is not in the ${grp.name} group.`,
          };
        }
      }
    }
  }

  // Upsert the template row — keyed by service_id or report_group_id.
  const targetColumn =
    data.target.kind === "service" ? "service_id" : "report_group_id";
  const { data: existing } = await admin
    .from("result_templates")
    .select("id")
    .eq(targetColumn, data.target.id)
    .maybeSingle();

  let templateId = existing?.id ?? null;
  if (!templateId) {
    const { data: created, error: insErr } = await admin
      .from("result_templates")
      .insert(
        data.target.kind === "service"
          ? {
              service_id: data.target.id,
              layout: data.layout,
              header_notes: data.header_notes,
              footer_notes: data.footer_notes,
              is_active: data.is_active,
            }
          : {
              report_group_id: data.target.id,
              layout: data.layout,
              header_notes: data.header_notes,
              footer_notes: data.footer_notes,
              is_active: data.is_active,
            },
      )
      .select("id")
      .single();
    if (insErr || !created) {
      return {
        ok: false,
        error: `Could not create template: ${insErr?.message ?? "unknown"}`,
      };
    }
    templateId = created.id;
  } else {
    const { error: updErr } = await admin
      .from("result_templates")
      .update({
        layout: data.layout,
        header_notes: data.header_notes,
        footer_notes: data.footer_notes,
        is_active: data.is_active,
      })
      .eq("id", templateId);
    if (updErr) {
      return { ok: false, error: `Could not update template: ${updErr.message}` };
    }
  }

  // Reconcile params:
  //   - rows with `id` get UPDATE'd in place (preserves FKs from result_values)
  //   - rows without `id` get INSERTed
  //   - rows that existed in DB but are absent from the payload get DELETE'd
  //     (cascade-deleting their result_template_param_ranges)
  const incomingIds = new Set(
    data.params.map((p) => p.id).filter((id): id is string => !!id),
  );

  const { data: dbParams } = await admin
    .from("result_template_params")
    .select("id")
    .eq("template_id", templateId);
  const dbIds = new Set((dbParams ?? []).map((r) => r.id));

  const toDelete = [...dbIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length > 0) {
    // result_values has FK to result_template_params.parameter_id without
    // cascade — block delete if any historical results reference these
    // params, so admins don't break audit history.
    const { count: refCount } = await admin
      .from("result_values")
      .select("id", { count: "exact", head: true })
      .in("parameter_id", toDelete);
    if ((refCount ?? 0) > 0) {
      return {
        ok: false,
        error: `Cannot delete params already used in finalised results (${refCount} value rows reference them). Mark the template inactive instead.`,
      };
    }
    // critical_alerts.parameter_id cascades on delete (unlike result_values,
    // which is a plain FK the DB blocks) — block explicitly so acknowledged
    // critical-value alert history isn't silently destroyed.
    const { count: alertCount } = await admin
      .from("critical_alerts")
      .select("id", { count: "exact", head: true })
      .in("parameter_id", toDelete);
    if ((alertCount ?? 0) > 0) {
      return {
        ok: false,
        error: `Cannot delete params with critical-value alert history (${alertCount} alert(s) reference them). Mark the template inactive instead.`,
      };
    }
    // 0119 guard: raw deletes are blocked; the RPC sets the opt-in flag and
    // deletes in one transaction. Mapping rows cascade away with the param.
    const { error: delErr } = await admin.rpc("admin_delete_template_params", {
      param_ids: toDelete,
    });
    if (delErr) {
      return { ok: false, error: translatePgError(delErr) };
    }
  }

  // Walk the payload in order; sort_order = array index. After the param's
  // own row is upserted we reconcile its age-banded ranges (Slice 4c).
  let totalRangesInserted = 0;
  let totalRangesUpdated = 0;
  let totalRangesDeleted = 0;
  let mappingsAdded = 0;
  let mappingsRemoved = 0;

  for (let i = 0; i < data.params.length; i++) {
    const p = data.params[i];
    const row = {
      template_id: templateId,
      sort_order: i,
      parameter_name: p.parameter_name,
      input_type: p.input_type,
      section: p.section,
      is_section_header: p.is_section_header,
      unit_si: p.unit_si,
      unit_conv: p.unit_conv,
      ref_low_si: p.ref_low_si,
      ref_high_si: p.ref_high_si,
      ref_low_conv: p.ref_low_conv,
      ref_high_conv: p.ref_high_conv,
      gender: p.gender,
      si_to_conv_factor: p.si_to_conv_factor,
      allowed_values: p.allowed_values,
      abnormal_values: p.abnormal_values,
      placeholder: p.placeholder,
    };
    let paramId: string;
    if (p.id) {
      const { error } = await admin
        .from("result_template_params")
        .update(row)
        .eq("id", p.id);
      if (error) {
        return {
          ok: false,
          error: `Could not update "${p.parameter_name}": ${error.message}`,
        };
      }
      paramId = p.id;
    } else {
      const { data: inserted, error } = await admin
        .from("result_template_params")
        .insert(row)
        .select("id")
        .single();
      if (error || !inserted) {
        return {
          ok: false,
          error: `Could not insert "${p.parameter_name}": ${error?.message ?? "unknown"}`,
        };
      }
      paramId = inserted.id;
    }

    // Reconcile age-banded ranges for this param. Same diff strategy as
    // params: update by id, insert new, delete obsolete. Ranges have no
    // FK referrers (they're metadata only), so deletion is always safe.
    const incoming = p.ranges ?? [];
    const incomingIds = new Set(
      incoming.map((r) => r.id).filter((id): id is string => !!id),
    );
    const { data: dbRanges } = await admin
      .from("result_template_param_ranges")
      .select("id")
      .eq("parameter_id", paramId);
    const dbRangeIds = new Set((dbRanges ?? []).map((r) => r.id));
    const rangesToDelete = [...dbRangeIds].filter((id) => !incomingIds.has(id));
    if (rangesToDelete.length > 0) {
      const { error: rDelErr } = await admin
        .from("result_template_param_ranges")
        .delete()
        .in("id", rangesToDelete);
      if (rDelErr) {
        return {
          ok: false,
          error: `Could not delete ranges for "${p.parameter_name}": ${rDelErr.message}`,
        };
      }
      totalRangesDeleted += rangesToDelete.length;
    }
    for (let j = 0; j < incoming.length; j++) {
      const r = incoming[j];
      const rangeRow = {
        parameter_id: paramId,
        sort_order: j,
        band_label: r.band_label,
        age_min_months: r.age_min_months,
        age_max_months: r.age_max_months,
        gender: r.gender,
        ref_low_si: r.ref_low_si,
        ref_high_si: r.ref_high_si,
        ref_low_conv: r.ref_low_conv,
        ref_high_conv: r.ref_high_conv,
      };
      if (r.id) {
        const { error: rUpdErr } = await admin
          .from("result_template_param_ranges")
          .update(rangeRow)
          .eq("id", r.id);
        if (rUpdErr) {
          return {
            ok: false,
            error: `Could not update range "${r.band_label}" on "${p.parameter_name}": ${rUpdErr.message}`,
          };
        }
        totalRangesUpdated += 1;
      } else {
        const { error: rInsErr } = await admin
          .from("result_template_param_ranges")
          .insert(rangeRow);
        if (rInsErr) {
          return {
            ok: false,
            error: `Could not insert range "${r.band_label}" on "${p.parameter_name}": ${rInsErr.message}`,
          };
        }
        totalRangesInserted += 1;
      }
    }

    // Group targets: reconcile report_group_service_params for this param.
    if (data.target.kind === "group") {
      const desired = new Set(p.service_ids ?? []);
      const { data: existingMap } = await admin
        .from("report_group_service_params")
        .select("service_id")
        .eq("parameter_id", paramId);
      const have = new Set((existingMap ?? []).map((r) => r.service_id));
      const removeIds = [...have].filter((id) => !desired.has(id));
      const addIds = [...desired].filter((id) => !have.has(id));
      if (removeIds.length > 0) {
        const { error: mDelErr } = await admin
          .from("report_group_service_params")
          .delete()
          .eq("parameter_id", paramId)
          .in("service_id", removeIds);
        if (mDelErr) {
          return {
            ok: false,
            error: `Could not unmap services from "${p.parameter_name}": ${mDelErr.message}`,
          };
        }
        mappingsRemoved += removeIds.length;
      }
      if (addIds.length > 0) {
        const { error: mInsErr } = await admin
          .from("report_group_service_params")
          .insert(addIds.map((service_id) => ({ service_id, parameter_id: paramId })));
        if (mInsErr) {
          return {
            ok: false,
            error: `Could not map services to "${p.parameter_name}": ${mInsErr.message}`,
          };
        }
        mappingsAdded += addIds.length;
      }
    }
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result_template.saved",
    resource_type: "result_template",
    resource_id: templateId,
    metadata: {
      target_kind: data.target.kind,
      target_id: data.target.id,
      target_code: targetLabel.code,
      layout: data.layout,
      param_count: data.params.length,
      params_deleted: toDelete.length,
      ranges_inserted: totalRangesInserted,
      ranges_updated: totalRangesUpdated,
      ranges_deleted: totalRangesDeleted,
      mappings_added: mappingsAdded,
      mappings_removed: mappingsRemoved,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/result-templates");
  if (data.target.kind === "service") {
    revalidatePath(`/staff/admin/result-templates/${data.target.id}/edit`);
  } else {
    revalidatePath(`/staff/admin/result-templates/group/${data.target.id}/edit`);
  }
  return { ok: true, templateId };
}
