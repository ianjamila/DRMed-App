"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export type LookupResult =
  | {
      ok: true;
      patient: PatientPreview;
    }
  | { ok: false; error: string };

export interface PatientPreview {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
  birthdate: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  visit_count: number;
  appointment_count: number;
  merged_into_id: string | null;
}

export type MergeResult =
  | { ok: true; kept_drm_id: string; merged_drm_id: string; moved: { visits: number; appointments: number; audit_log: number; critical_alerts: number; patient_consents: number } }
  | { ok: false; error: string };

const LookupSchema = z.object({
  drm_id: z
    .string()
    .trim()
    .regex(/^DRM-\d{4,}$/i, "DRM-ID looks like DRM-0001."),
});

const MergeSchema = z.object({
  keep_id: z.string().uuid(),
  source_id: z.string().uuid(),
  confirm: z.literal("MERGE", { message: "Type MERGE to confirm." }),
});

async function previewByDrmId(drmId: string): Promise<PatientPreview | null> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, sex, phone, email, address, merged_into_id",
    )
    .eq("drm_id", drmId.toUpperCase())
    .maybeSingle();
  if (!row) return null;

  const [{ count: visits }, { count: appts }] = await Promise.all([
    admin
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("patient_id", row.id),
    admin
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("patient_id", row.id),
  ]);

  return {
    id: row.id,
    drm_id: row.drm_id,
    first_name: row.first_name,
    last_name: row.last_name,
    middle_name: row.middle_name,
    birthdate: row.birthdate,
    sex: row.sex,
    phone: row.phone,
    email: row.email,
    address: row.address,
    merged_into_id: row.merged_into_id,
    visit_count: visits ?? 0,
    appointment_count: appts ?? 0,
  };
}

export async function lookupPatientForMergeAction(
  _prev: LookupResult | null,
  formData: FormData,
): Promise<LookupResult> {
  await requireAdminStaff();
  const parsed = LookupSchema.safeParse({ drm_id: formData.get("drm_id") });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }
  const preview = await previewByDrmId(parsed.data.drm_id);
  if (!preview) {
    return { ok: false, error: `No patient with DRM-ID ${parsed.data.drm_id.toUpperCase()}.` };
  }
  return { ok: true, patient: preview };
}

export async function mergePatientsAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const session = await requireAdminStaff();
  const parsed = MergeSchema.safeParse({
    keep_id: formData.get("keep_id"),
    source_id: formData.get("source_id"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }
  const { keep_id, source_id } = parsed.data;
  if (keep_id === source_id) {
    return { ok: false, error: "Pick two different patients." };
  }

  const admin = createAdminClient();

  // Both rows must exist and not already be merged.
  const { data: rows } = await admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, sex, phone, email, address, merged_into_id",
    )
    .in("id", [keep_id, source_id]);
  const keep = rows?.find((r) => r.id === keep_id);
  const source = rows?.find((r) => r.id === source_id);
  if (!keep || !source) {
    return { ok: false, error: "One of the patients was not found." };
  }
  if (keep.merged_into_id || source.merged_into_id) {
    return {
      ok: false,
      error: "One of the patients has already been merged. Refresh and try again.",
    };
  }

  // Reassign FK rows. We do these as separate updates rather than a
  // transaction because Supabase JS doesn't expose explicit transactions
  // — at this row volume the operations are independently idempotent
  // and a partial failure leaves a recoverable state (re-run the merge
  // and the second pass is a no-op for already-moved rows).
  const { data: visits } = await admin
    .from("visits")
    .update({ patient_id: keep_id })
    .eq("patient_id", source_id)
    .select("id");
  const { data: appts } = await admin
    .from("appointments")
    .update({ patient_id: keep_id })
    .eq("patient_id", source_id)
    .select("id");
  const { data: auditRows } = await admin
    .from("audit_log")
    .update({ patient_id: keep_id })
    .eq("patient_id", source_id)
    .select("id");
  const { data: criticalAlerts } = await admin
    .from("critical_alerts")
    .update({ patient_id: keep_id })
    .eq("patient_id", source_id)
    .select("id");
  const { data: consents } = await admin
    .from("patient_consents")
    .update({ patient_id: keep_id })
    .eq("patient_id", source_id)
    .select("id");

  // Fill missing fields on the kept row from the source row — never
  // overwrite a non-null value.
  const fill: {
    middle_name?: string;
    sex?: string;
    phone?: string;
    email?: string;
    address?: string;
  } = {};
  if (!keep.middle_name && source.middle_name) fill.middle_name = source.middle_name;
  if (!keep.sex && source.sex) fill.sex = source.sex;
  if (!keep.phone && source.phone) fill.phone = source.phone;
  if (!keep.email && source.email) fill.email = source.email;
  if (!keep.address && source.address) fill.address = source.address;
  if (Object.keys(fill).length > 0) {
    await admin.from("patients").update(fill).eq("id", keep_id);
  }

  // Tombstone the source row.
  const mergedAt = new Date().toISOString();
  const { error: tombErr } = await admin
    .from("patients")
    .update({ merged_into_id: keep_id, merged_at: mergedAt })
    .eq("id", source_id);
  if (tombErr) {
    return { ok: false, error: tombErr.message };
  }

  // Record the merge for reversibility (exact moved IDs + filled fields).
  const movedIds = {
    visits: (visits ?? []).map((r) => r.id),
    appointments: (appts ?? []).map((r) => r.id),
    audit_log: (auditRows ?? []).map((r) => r.id),
    critical_alerts: (criticalAlerts ?? []).map((r) => r.id),
    patient_consents: (consents ?? []).map((r) => r.id),
  };
  await admin.from("patient_merges").insert({
    keep_id,
    source_id,
    merged_by: session.user_id,
    moved: movedIds,
    filled_from_source: Object.keys(fill),
  });

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: keep_id,
    action: "patient.merged",
    resource_type: "patient",
    resource_id: keep_id,
    metadata: {
      kept_drm_id: keep.drm_id,
      merged_drm_id: source.drm_id,
      merged_patient_id: source_id,
      moved: {
        visits: visits?.length ?? 0,
        appointments: appts?.length ?? 0,
        audit_log: auditRows?.length ?? 0,
        critical_alerts: criticalAlerts?.length ?? 0,
        patient_consents: consents?.length ?? 0,
      },
      filled_from_source: Object.keys(fill),
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/patients");

  return {
    ok: true,
    kept_drm_id: keep.drm_id,
    merged_drm_id: source.drm_id,
    moved: {
      visits: visits?.length ?? 0,
      appointments: appts?.length ?? 0,
      audit_log: auditRows?.length ?? 0,
      critical_alerts: criticalAlerts?.length ?? 0,
      patient_consents: consents?.length ?? 0,
    },
  };
}

export const MERGE_UNDO_WINDOW_DAYS = 30;

export interface RecentMerge {
  id: string;
  keep_id: string;
  source_id: string;
  keep_drm_id: string | null;
  source_drm_id: string | null;
  merged_at: string;
  undoable: boolean;
}

export async function loadRecentMerges(): Promise<RecentMerge[]> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - MERGE_UNDO_WINDOW_DAYS * 86400_000).toISOString();
  const { data } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, undone_at")
    .is("undone_at", null)
    .gte("merged_at", cutoff)
    .order("merged_at", { ascending: false })
    .limit(50);
  if (!data) return [];
  const ids = Array.from(new Set(data.flatMap((m) => [m.keep_id, m.source_id])));
  const { data: pts } = await admin.from("patients").select("id, drm_id").in("id", ids);
  const drm = new Map((pts ?? []).map((p) => [p.id, p.drm_id]));
  return data.map((m) => ({
    id: m.id,
    keep_id: m.keep_id,
    source_id: m.source_id,
    keep_drm_id: drm.get(m.keep_id) ?? null,
    source_drm_id: drm.get(m.source_id) ?? null,
    merged_at: m.merged_at,
    undoable: true,
  }));
}

export type UndoResult = { ok: true } | { ok: false; error: string };

export async function undoMergeAction(
  _prev: UndoResult | null,
  formData: FormData,
): Promise<UndoResult> {
  const session = await requireAdminStaff();
  const mergeId = z.string().uuid().safeParse(formData.get("merge_id"));
  if (!mergeId.success) return { ok: false, error: "Invalid merge id." };

  const admin = createAdminClient();
  const { data: m } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, moved, filled_from_source, undone_at")
    .eq("id", mergeId.data)
    .maybeSingle();
  if (!m) return { ok: false, error: "Merge record not found." };
  if (m.undone_at) return { ok: false, error: "This merge was already undone." };

  const ageDays = (Date.now() - new Date(m.merged_at).getTime()) / 86400_000;
  if (ageDays > MERGE_UNDO_WINDOW_DAYS) {
    return { ok: false, error: `Merges can only be undone within ${MERGE_UNDO_WINDOW_DAYS} days.` };
  }

  const moved = (m.moved ?? {}) as Record<string, string[]>;
  // Re-point each recorded row back to the source patient. Explicit per-table
  // calls (literal table names) so each .update keeps its typed row shape.
  const visitIds = moved["visits"] ?? [];
  if (visitIds.length > 0) {
    await admin.from("visits").update({ patient_id: m.source_id }).in("id", visitIds);
  }
  const apptIds = moved["appointments"] ?? [];
  if (apptIds.length > 0) {
    await admin.from("appointments").update({ patient_id: m.source_id }).in("id", apptIds);
  }
  // audit_log.id is bigserial (number), not uuid — cast from the JSON string values.
  const auditIds = (moved["audit_log"] ?? []).map(Number);
  if (auditIds.length > 0) {
    await admin.from("audit_log").update({ patient_id: m.source_id }).in("id", auditIds);
  }
  const alertIds = moved["critical_alerts"] ?? [];
  if (alertIds.length > 0) {
    await admin.from("critical_alerts").update({ patient_id: m.source_id }).in("id", alertIds);
  }
  const consentIds = moved["patient_consents"] ?? [];
  if (consentIds.length > 0) {
    await admin.from("patient_consents").update({ patient_id: m.source_id }).in("id", consentIds);
  }

  // Null out exactly the fields the merge filled (merge only fills NULL keep
  // fields, and only from this known set). Typed to those columns.
  const filled = (m.filled_from_source ?? []) as string[];
  const clear: Partial<Record<"middle_name" | "sex" | "phone" | "email" | "address", null>> = {};
  for (const f of filled) {
    if (f === "middle_name" || f === "sex" || f === "phone" || f === "email" || f === "address") {
      clear[f] = null;
    }
  }
  if (Object.keys(clear).length > 0) {
    await admin.from("patients").update(clear).eq("id", m.keep_id);
  }

  // Restore the source row.
  await admin.from("patients").update({ merged_into_id: null, merged_at: null }).eq("id", m.source_id);

  // Mark the ledger row undone.
  await admin
    .from("patient_merges")
    .update({ undone_at: new Date().toISOString(), undone_by: session.user_id })
    .eq("id", m.id);

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: m.keep_id,
    action: "patient.merge.undone",
    resource_type: "patient",
    resource_id: m.source_id,
    metadata: { merge_id: m.id, keep_id: m.keep_id, source_id: m.source_id, restored: moved, cleared_fields: filled },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return { ok: true };
}
