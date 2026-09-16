/** Patients with no current RA 10173 consent — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { formatPatientName } from "@/lib/patients/format-name";
import type { SortSpec } from "@/lib/ui/table-params";
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
  /**
   * Ordered by `orderByLastVisit` (most recently active first, never-visited
   * last) over the FULL candidate set — nothing here is trimmed. The page
   * re-sorts this set again by whichever column its `sort` param picks
   * (default matches this order) and pages it; the CSV export takes it as-is.
   */
  rows: PatientWithoutConsentRow[];
  visitCount: ReadonlyMap<string, number>;
  lastVisit: ReadonlyMap<string, string>;
  /**
   * True when more patients matched than `maxRows` could hold — the
   * candidate SET itself is incomplete, so even the correctly-ordered list
   * above may be missing patients no amount of re-sorting can recover.
   */
  truncated: boolean;
}

/**
 * Most recently active first; patients with no visits sink to the bottom in
 * EITHER direction. Stable. This is also the report's default column sort —
 * `comparePatientsWithoutConsent`'s `last_visit` case applies the identical
 * null-last rule when a reader clicks that header, so a never-visited patient
 * stays pinned to the bottom no matter which direction they pick.
 */
export function orderByLastVisit(
  rows: readonly PatientWithoutConsentRow[],
  lastVisit: ReadonlyMap<string, string>,
): PatientWithoutConsentRow[] {
  return [...rows].sort((a, b) =>
    (lastVisit.get(b.id) ?? "").localeCompare(lastVisit.get(a.id) ?? ""),
  );
}

/**
 * M15: `maxRows` bounds the CANDIDATE set (every patient lacking consent,
 * fetched `created_at desc` — an arbitrary but stable order, since nothing
 * meaningful can be known before visits are joined in below). `orderByLastVisit`
 * then re-orders the FULL candidate set most-recently-active-first before this
 * function returns anything — there used to be a `displayLimit` here that
 * trimmed the ordered list for on-screen rendering, but that trim is now the
 * report page's pager (a plain array slice over the same full, sorted set;
 * see the page's `rows` computation), so this loader itself never trims.
 *
 * Getting sort-then-trim backwards was the original bug: a page that fetched
 * only the first N patients by `created_at desc` and sorted THAT short list
 * by last-visit could drop a patient who registered years ago but walked in
 * yesterday, while keeping a patient who registered last week and never
 * returned. `maxRows` must stay generous enough to cover the true candidate
 * population (the report library's `REPORT_EXPORT_MAX_ROWS`, same ceiling the
 * CSV export already proves comfortably covers this table) so the ordering
 * below is never working from an already-wrong set — and since nothing here
 * trims anymore, there is no later step that could quietly re-introduce the
 * bug by trimming before sorting.
 */
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

  const ordered = orderByLastVisit(patients, lastVisit);

  return {
    rows: ordered,
    visitCount,
    lastVisit,
    truncated: truncated || visitsTruncated,
  };
}

/**
 * Sortable columns for the on-screen table. `contact` is this report's own
 * invention (see `comparePatientsWithoutConsent` below) — a triage ordering
 * that has no equivalent on the CSV export, where a reader can just look at
 * the Phone/Email cells directly.
 */
export const PATIENTS_WITHOUT_CONSENT_SORTABLE_COLUMNS = [
  "patient",
  "drm_id",
  "visits",
  "last_visit",
  "contact",
] as const;
export type PatientsWithoutConsentSortColumn =
  (typeof PATIENTS_WITHOUT_CONSENT_SORTABLE_COLUMNS)[number];

// Most-recently-active first is the useful default for a "who do we still
// need consent from" worklist: it surfaces the patients most likely to walk
// back in soon (and so hit the consent gate soonest) ahead of patients who
// registered but may never return. Matches `orderByLastVisit`'s order.
export const PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT: SortSpec<PatientsWithoutConsentSortColumn> =
  { key: "last_visit", dir: "desc" };

/** How much contact info is on file: both > one > none. Never negative. */
function contactScore(p: PatientWithoutConsentRow): number {
  return (p.phone ? 1 : 0) + (p.email ? 1 : 0);
}

export function comparePatientsWithoutConsent(
  a: PatientWithoutConsentRow,
  b: PatientWithoutConsentRow,
  sort: SortSpec<PatientsWithoutConsentSortColumn>,
  visitCount: ReadonlyMap<string, number>,
  lastVisit: ReadonlyMap<string, string>,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp: number;

  switch (sort.key) {
    case "patient": {
      // A patient with neither name on file sinks to the bottom regardless of
      // direction — same convention "patient" columns follow everywhere else
      // in these reports (see users/page.tsx's NULLS_LAST_COLUMNS). The row
      // is still reachable by DRM-ID; it just shouldn't crowd the top of an
      // ascending sort because "" collates before every real name.
      const an = formatPatientName(a);
      const bn = formatPatientName(b);
      if (an === "" && bn === "") cmp = 0;
      else if (an === "") return 1;
      else if (bn === "") return -1;
      else cmp = dirMul * an.localeCompare(bn);
      break;
    }
    case "drm_id":
      cmp = dirMul * a.drm_id.localeCompare(b.drm_id);
      break;
    case "visits":
      cmp = dirMul * ((visitCount.get(a.id) ?? 0) - (visitCount.get(b.id) ?? 0));
      break;
    case "last_visit": {
      // Null last in BOTH directions — see `orderByLastVisit`'s doc comment.
      const av = lastVisit.get(a.id) ?? null;
      const bv = lastVisit.get(b.id) ?? null;
      if (av === null && bv === null) cmp = 0;
      else if (av === null) return 1;
      else if (bv === null) return -1;
      else cmp = dirMul * av.localeCompare(bv);
      break;
    }
    case "contact":
      // "Who can we even reach" ordering: both phone and email on file
      // outranks one, which outranks neither. Deliberately not alphabetical
      // (there's nothing to alphabetise) — this column is a triage signal,
      // not a lookup key, so the useful order is by how contactable the row is.
      cmp = dirMul * (contactScore(a) - contactScore(b));
      break;
    default:
      cmp = 0;
  }

  // Tie-break on id, ascending, same convention every comparator here follows
  // (see users/page.tsx) — keeps paging deterministic rather than depending
  // on Array#sort's stability as an implementation detail.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
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
