/** Patients with no current RA 10173 consent — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { formatPatientName } from "@/lib/patients/format-name";
import { chunk, fetchAllRows, IN_CHUNK } from "./paging";

type AnyClient = SupabaseClient<Database>;

/**
 * Ceiling on live visits walked per IN_CHUNK of patients. 200 patients would
 * need 500 visits each to reach it; if they ever do, the report is flagged
 * truncated rather than quietly under-counting.
 */
const VISITS_PER_CHUNK_CEILING = 100_000;

export interface PatientWithoutConsentRow {
  id: string;
  drm_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  pre_registered: boolean;
}

export interface PatientsWithoutConsentReport {
  /** Ordered: most recently active first, never-visited last. */
  rows: PatientWithoutConsentRow[];
  visitCount: ReadonlyMap<string, number>;
  lastVisit: ReadonlyMap<string, string>;
  truncated: boolean;
}

/** Most recently active first; patients with no visits sink to the bottom. Stable. */
export function orderByLastVisit(
  rows: readonly PatientWithoutConsentRow[],
  lastVisit: ReadonlyMap<string, string>,
): PatientWithoutConsentRow[] {
  return [...rows].sort((a, b) =>
    (lastVisit.get(b.id) ?? "").localeCompare(lastVisit.get(a.id) ?? ""),
  );
}

export async function loadPatientsWithoutConsent(
  client: AnyClient,
  maxRows: number,
): Promise<PatientsWithoutConsentReport> {
  // Active patients (not merged tombstones) with no current data-privacy
  // consent on file — exactly the rows whose releases will block once the
  // consent gate is switched ON.
  const { rows: patients, truncated } = await fetchAllRows<PatientWithoutConsentRow>(
    (from, to) =>
      client
        .from("patients")
        .select("id, drm_id, first_name, last_name, phone, email, pre_registered")
        .eq("consent_current", false)
        .is("merged_into_id", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<PatientWithoutConsentRow[]>(),
    maxRows,
  );

  // Visit stats, folded onto each patient. Chunked ids and paged visits so a
  // frequent flyer can't push the batch past PostgREST's cap; live visits
  // only (0125).
  const visitCount = new Map<string, number>();
  const lastVisit = new Map<string, string>();
  let visitsTruncated = false;
  for (const ids of chunk(patients.map((p) => p.id), IN_CHUNK)) {
    const { rows: visits, truncated: chunkTruncated } = await fetchAllRows<{ patient_id: string | null; visit_date: string | null }>(
      (from, to) =>
        client
          .from("visits")
          .select("patient_id, visit_date")
          .in("patient_id", ids)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to),
      VISITS_PER_CHUNK_CEILING,
    );
    visitsTruncated ||= chunkTruncated;
    for (const v of visits) {
      if (!v.patient_id) continue;
      visitCount.set(v.patient_id, (visitCount.get(v.patient_id) ?? 0) + 1);
      if (v.visit_date) {
        const prev = lastVisit.get(v.patient_id);
        if (!prev || v.visit_date > prev) lastVisit.set(v.patient_id, v.visit_date);
      }
    }
  }

  return {
    rows: orderByLastVisit(patients, lastVisit),
    visitCount,
    lastVisit,
    truncated: truncated || visitsTruncated,
  };
}

export const PATIENTS_WITHOUT_CONSENT_CSV_HEADER = [
  "Patient",
  "DRM-ID",
  "Pre-registered",
  "Visits",
  "Last visit",
  "Phone",
  "Email",
] as const;

export function patientsWithoutConsentCsvRows(
  rows: readonly PatientWithoutConsentRow[],
  visitCount: ReadonlyMap<string, number>,
  lastVisit: ReadonlyMap<string, string>,
): unknown[][] {
  return [
    [...PATIENTS_WITHOUT_CONSENT_CSV_HEADER],
    ...rows.map((p) => [
      formatPatientName(p) || "(no name on file)",
      p.drm_id,
      p.pre_registered ? "yes" : "no",
      visitCount.get(p.id) ?? 0,
      lastVisit.get(p.id) ?? "",
      p.phone ?? "",
      p.email ?? "",
    ]),
  ];
}

export function patientsWithoutConsentCsvHref(): string {
  return "/api/admin/reports/patients-without-consent.csv";
}

export function patientsWithoutConsentCsvFilename(today: string): string {
  return `patients-without-consent-${today}.csv`;
}
