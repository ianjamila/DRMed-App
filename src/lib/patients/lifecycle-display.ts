import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Banner data for a deleted or merged record (0167). History pages call it
// only when the record they show is inactive. Reads regardless of lifecycle —
// that is the point.

export interface PatientLifecycleDisplay {
  patientId: string;
  drmId: string;
  deletedAt: string | null;
  deletedByName: string | null;
  deleteReason: string | null;
  deleteNote: string | null;
  mergedIntoId: string | null;
  mergedIntoDrmId: string | null;
  mergedAt: string | null;
}

export async function loadPatientLifecycle(
  db: SupabaseClient<Database>,
  patientId: string,
): Promise<PatientLifecycleDisplay | null> {
  const { data: p } = await db
    .from("patients")
    .select("id, drm_id, deleted_at, deleted_by, delete_reason, delete_note, merged_into_id, merged_at")
    .eq("id", patientId)
    .maybeSingle();
  if (!p) return null;

  const [staff, kept] = await Promise.all([
    p.deleted_by
      ? db.from("staff_profiles").select("full_name").eq("id", p.deleted_by).maybeSingle()
      : Promise.resolve({ data: null }),
    p.merged_into_id
      ? db.from("patients").select("drm_id, deleted_at, merged_into_id").eq("id", p.merged_into_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    patientId: p.id,
    drmId: p.drm_id,
    deletedAt: p.deleted_at,
    deletedByName: staff.data?.full_name ?? null,
    deleteReason: p.delete_reason,
    deleteNote: p.delete_note,
    mergedIntoId: p.merged_into_id,
    mergedIntoDrmId: kept.data?.drm_id ?? null,
    mergedAt: p.merged_at,
  };
}
