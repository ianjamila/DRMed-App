"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  DeletePatientSchema,
  parseBlockerDetail,
  parseBlockers,
  parseKeptCounts,
  parseLifecycleResult,
  type DeleteBlocker,
  type DeletePatientInput,
  type KeptCounts,
} from "@/lib/patients/deletion";

// Admin-only delete/restore of a patient record (0167). The database does the
// work and the audit row in one transaction (delete_patient/restore_patient);
// these actions only gate, validate and pass the server-derived actor and
// request context. They never audit a second time.

export interface DeletePreview {
  patient: {
    id: string;
    drm_id: string;
    first_name: string;
    last_name: string;
    middle_name: string | null;
    birthdate: string | null;
  };
  blockers: DeleteBlocker[];
  kept: KeptCounts;
}

export type PreviewResult = { ok: true; data: DeletePreview } | { ok: false; error: string };
export type DeleteResult =
  | { ok: true; data: { patientId: string; drmId: string } }
  | { ok: false; error: string; blockers?: DeleteBlocker[] };
export type RestoreResult =
  | { ok: true; data: { patientId: string; drmId: string } }
  | { ok: false; error: string };

const IdSchema = z.string().uuid();

function revalidatePatient(patientId: string) {
  revalidatePath("/staff/patients");
  revalidatePath(`/staff/patients/${patientId}`);
  revalidatePath("/staff/admin/deleted-patients");
}

/** What the confirm dialog shows. Advisory: delete_patient re-checks under lock. */
export async function previewPatientDeleteAction(patientId: string): Promise<PreviewResult> {
  await requireAdminStaff();
  const id = IdSchema.safeParse(patientId);
  if (!id.success) return { ok: false, error: "We couldn't find that patient." };

  const admin = createAdminClient();
  const [patientRes, blockersRes, keptRes] = await Promise.all([
    admin
      .from("patients")
      .select("id, drm_id, first_name, last_name, middle_name, birthdate, deleted_at, merged_into_id")
      .eq("id", id.data)
      .maybeSingle(),
    admin.rpc("patient_delete_blockers", { p_patient_id: id.data }),
    admin.rpc("patient_kept_counts", { p_patient_ids: [id.data] }),
  ]);
  if (patientRes.error || blockersRes.error || keptRes.error) {
    return { ok: false, error: "Could not load this patient's open items. Try again." };
  }
  const p = patientRes.data;
  if (!p) return { ok: false, error: "We couldn't find that patient." };
  if (p.deleted_at || p.merged_into_id) {
    return { ok: false, error: "This patient record is already deleted or merged." };
  }
  return {
    ok: true,
    data: {
      patient: {
        id: p.id,
        drm_id: p.drm_id,
        first_name: p.first_name,
        last_name: p.last_name,
        middle_name: p.middle_name,
        birthdate: p.birthdate,
      },
      blockers: parseBlockers(blockersRes.data),
      kept: parseKeptCounts((keptRes.data ?? [])[0]),
    },
  };
}

export async function deletePatientAction(input: DeletePatientInput): Promise<DeleteResult> {
  const session = await requireAdminStaff();
  const parsed = DeletePatientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("delete_patient", {
    p_patient_id: parsed.data.patientId,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note ?? "",
    p_actor: session.user_id,
    p_context: { ip, user_agent: ua },
  });
  if (error) {
    if (error.code === "P0059") {
      return { ok: false, error: translatePgError(error), blockers: parseBlockerDetail(error.details) };
    }
    return { ok: false, error: translatePgError(error) };
  }
  const result = parseLifecycleResult(data);
  if (!result) return { ok: false, error: "The patient was deleted, but the result could not be read. Refresh the page." };
  revalidatePatient(result.patientId);
  return { ok: true, data: result };
}

export async function restorePatientAction(patientId: string): Promise<RestoreResult> {
  const session = await requireAdminStaff();
  const id = IdSchema.safeParse(patientId);
  if (!id.success) return { ok: false, error: "We couldn't find that patient." };

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("restore_patient", {
    p_patient_id: id.data,
    p_actor: session.user_id,
    p_context: { ip, user_agent: ua },
  });
  if (error) return { ok: false, error: translatePgError(error) };
  const result = parseLifecycleResult(data);
  if (!result) return { ok: false, error: "The patient was restored, but the result could not be read. Refresh the page." };
  revalidatePatient(result.patientId);
  return { ok: true, data: result };
}
