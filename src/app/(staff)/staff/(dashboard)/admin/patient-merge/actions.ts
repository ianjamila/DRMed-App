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
  birthdate: string;
  sex: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  visit_count: number;
  appointment_count: number;
  merged_into_id: string | null;
}

export type MergeResult =
  | { ok: true; kept_drm_id: string; merged_drm_id: string; moved: { visits: number; appointments: number; audit_log: number } }
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
    },
  };
}
