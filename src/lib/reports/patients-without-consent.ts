/** Patients with no current RA 10173 consent — shared by the page and CSV. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { formatPatientName } from "@/lib/patients/format-name";
import { rangeFor, type SortSpec } from "@/lib/ui/table-params";
import { fetchAllRows } from "./paging";

type AnyClient = SupabaseClient<Database>;

export interface PatientWithoutConsentRow {
  id: string;
  drm_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  pre_registered: boolean;
  visit_count: number;
  /** Manila calendar date (YYYY-MM-DD), not a timestamp. */
  last_visit_at: string | null;
}

export const PATIENTS_WITHOUT_CONSENT_SORTABLE_COLUMNS = [
  "patient",
  "drm_id",
  "visits",
  "last_visit",
  "contact",
] as const;
export type PatientsWithoutConsentSortColumn =
  (typeof PATIENTS_WITHOUT_CONSENT_SORTABLE_COLUMNS)[number];

export const PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT: SortSpec<PatientsWithoutConsentSortColumn> =
  { key: "last_visit", dir: "desc" };

const SORT_COLUMNS = {
  patient: "patient_name",
  drm_id: "drm_id",
  visits: "visit_count",
  last_visit: "last_visit_at",
  contact: "contact_score",
} as const satisfies Record<PatientsWithoutConsentSortColumn, string>;

const SELECT = "id, drm_id, first_name, last_name, phone, email, pre_registered, visit_count, last_visit_at";

/** Both consumers order the finished row set, before any range or export cap. */
function reportQuery(
  client: AnyClient,
  sort: SortSpec<PatientsWithoutConsentSortColumn>,
  count?: "exact",
) {
  return client
    .from("v_patients_without_consent")
    .select(SELECT, { count })
    .order(SORT_COLUMNS[sort.key], {
      ascending: sort.dir === "asc",
      nullsFirst: false,
    })
    // Direction-independent: equal primary values never swap when toggled.
    .order("id", { ascending: true });
}

/** Fetch just the requested page; the total is never capped by the CSV ceiling. */
export async function loadPatientsWithoutConsentPage(
  client: AnyClient,
  params: { sort: SortSpec<PatientsWithoutConsentSortColumn>; page: number; size: number },
): Promise<{ rows: PatientWithoutConsentRow[]; total: number }> {
  const [from, to] = rangeFor(params.page, params.size);
  const { data, error, count } = await reportQuery(client, params.sort, "exact")
    .range(from, to)
    .returns<PatientWithoutConsentRow[]>();

  // A bookmarked page can become out of range as consents are captured.
  // PostgREST returns 416/PGRST103; retain the exact total and an empty page.
  if (error?.code === "PGRST103") {
    const result = await client
      .from("v_patients_without_consent")
      .select("id", { count: "exact", head: true });
    if (result.error) throw new Error(result.error.message);
    if (result.count === null) throw new Error("Consent report count missing");
    return { rows: [], total: result.count };
  }
  if (error) throw new Error(error.message);
  if (count === null) throw new Error("Consent report count missing");
  return { rows: data ?? [], total: count };
}

/** CSV walks the same view in bounded chunks, retaining its truncation marker. */
export async function loadPatientsWithoutConsent(
  client: AnyClient,
  maxRows: number,
): Promise<{ rows: PatientWithoutConsentRow[]; truncated: boolean }> {
  return fetchAllRows<PatientWithoutConsentRow>(
    (from, to) => reportQuery(client, PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT)
      .range(from, to)
      .returns<PatientWithoutConsentRow[]>(),
    maxRows,
  );
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
): unknown[][] {
  return [
    [...PATIENTS_WITHOUT_CONSENT_CSV_HEADER],
    ...rows.map((p) => [
      formatPatientName(p) || "(no name on file)",
      p.drm_id,
      p.pre_registered ? "yes" : "no",
      p.visit_count,
      p.last_visit_at ?? "",
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
