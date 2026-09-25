import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

// Records that the patient downloaded these result PDFs (0176,
// result_note_patient_download — service_role only, so the caller passes the
// admin client it already holds for Storage signing). This is what lets the
// portal show "Result updated" only to a patient who has the OLD file.
//
// Pass the exact storage_path each download handed out, read BEFORE signing:
// the function compares it with the current PDF, so a download that raced an
// edit (old file served, new one committed a moment later) keeps the marker.
//
// Never fails the download: the patient already has the file, and the audit
// row is the record of access. A failed write only means a marker that should
// have cleared stays up until the next download — logged, not surfaced.

export interface ServedResultFile {
  resultId: string;
  storagePath: string;
}

export function servedPayload(files: readonly ServedResultFile[]): Json {
  const seen = new Set<string>();
  const out: { result_id: string; storage_path: string }[] = [];
  for (const f of files) {
    const key = `${f.resultId}|${f.storagePath}`;
    if (!f.resultId || !f.storagePath || seen.has(key)) continue;
    seen.add(key);
    out.push({ result_id: f.resultId, storage_path: f.storagePath });
  }
  return out;
}

export async function notePatientDownload(
  admin: SupabaseClient<Database>,
  files: readonly ServedResultFile[],
): Promise<void> {
  const payload = servedPayload(files);
  if ((payload as unknown[]).length === 0) return;
  try {
    const { error } = await admin.rpc("result_note_patient_download", {
      p_served: payload,
    });
    if (error) {
      console.error("result_note_patient_download failed:", error.message);
    }
  } catch (err) {
    console.error("result_note_patient_download threw:", err);
  }
}
