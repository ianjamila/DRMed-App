"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
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

  // Verify the service exists.
  const { data: svc } = await admin
    .from("services")
    .select("id, code, name")
    .eq("id", data.service_id)
    .maybeSingle();
  if (!svc) return { ok: false, error: "Service not found." };

  // Upsert the template row (one per service_id).
  const { data: existing } = await admin
    .from("result_templates")
    .select("id")
    .eq("service_id", data.service_id)
    .maybeSingle();

  let templateId = existing?.id ?? null;
  if (!templateId) {
    const { data: created, error: insErr } = await admin
      .from("result_templates")
      .insert({
        service_id: data.service_id,
        layout: data.layout,
        header_notes: data.header_notes,
        footer_notes: data.footer_notes,
        is_active: data.is_active,
      })
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
    const { error: delErr } = await admin
      .from("result_template_params")
      .delete()
      .in("id", toDelete);
    if (delErr) {
      return { ok: false, error: `Could not delete params: ${delErr.message}` };
    }
  }

  // Walk the payload in order; sort_order = array index. After the param's
  // own row is upserted we reconcile its age-banded ranges (Slice 4c).
  let totalRangesInserted = 0;
  let totalRangesUpdated = 0;
  let totalRangesDeleted = 0;

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
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result_template.saved",
    resource_type: "result_template",
    resource_id: templateId,
    metadata: {
      service_id: data.service_id,
      service_code: svc.code,
      layout: data.layout,
      param_count: data.params.length,
      params_deleted: toDelete.length,
      ranges_inserted: totalRangesInserted,
      ranges_updated: totalRangesUpdated,
      ranges_deleted: totalRangesDeleted,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/result-templates");
  revalidatePath(`/staff/admin/result-templates/${data.service_id}/edit`);
  return { ok: true, templateId };
}
