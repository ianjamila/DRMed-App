// The portal's "Result updated" marker (owner decision 2026-09-25). A patient
// sees it ONLY when they had already downloaded the file before its latest
// edit; downloading again hides it. Never downloaded → never shown (their first
// download is already the corrected file). No reason is ever shown to patients.
//
// Both inputs are columns on `results` the patient-scoped client can read:
// `amended_at` (set by every edit, 0172) and `patient_last_downloaded_at`
// (written by result_note_patient_download on every portal download, 0176).
// Pure, so it can be tested without a database.

export interface PatientUpdateMarkerInput {
  amended_at: string | null;
  patient_last_downloaded_at: string | null;
}

export function isUpdatedSinceDownload(
  r: PatientUpdateMarkerInput | null | undefined,
): boolean {
  if (!r || !r.amended_at || !r.patient_last_downloaded_at) return false;
  const edited = epochMicros(r.amended_at);
  const downloaded = epochMicros(r.patient_last_downloaded_at);
  if (edited === null || downloaded === null) return false;
  return downloaded < edited;
}

/**
 * A Postgres timestamptz (as PostgREST sends it) in MICROseconds since the
 * epoch. Date.parse keeps milliseconds only, and 0176 records a download that
 * raced an edit as amended_at minus ONE microsecond — at millisecond precision
 * the two would compare equal and the marker would wrongly hide.
 */
export function epochMicros(ts: string): number | null {
  const m = /^(.*?\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)?$/i.exec(ts.trim());
  if (!m) return null;
  // "2026-09-25 10:00:00+00" (psql) and "…T10:00:00+00:00" (PostgREST) alike.
  const zone = m[3] ?? "Z";
  const ms = Date.parse(m[1].replace(" ", "T") + (/^[+-]\d\d$/.test(zone) ? `${zone}:00` : zone));
  if (Number.isNaN(ms)) return null;
  const micros = Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
  return ms * 1000 + micros;
}

/** What the patient reads — kept here so every surface says the same thing. */
export const RESULT_UPDATED_LABEL = "Result updated";
export const RESULT_UPDATED_HINT =
  "The clinic has updated this result since you downloaded it. Download it again for the latest copy.";
