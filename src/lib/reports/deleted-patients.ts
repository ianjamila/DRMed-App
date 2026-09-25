/**
 * Admin Tools › Deleted Patients and its CSV — shared by the page and the
 * route handler. Reads `v_patients_directory_admin` (0167) through the
 * RLS-scoped client: the view returns rows only to admins, so no extra role
 * check is needed here beyond what the page/route already do. Not
 * `server-only` (kept vitest-testable, same as the other report loaders).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { SortSpec } from "@/lib/ui/table-params";
import { fetchAllRows } from "@/lib/reports/paging";
import { deleteReasonLabel, type KeptCounts } from "@/lib/patients/deletion";
import { manilaDateTime } from "@/lib/dates/manila";

type AnyClient = SupabaseClient<Database>;

export const DELETED_SORTABLE = ["deleted_at", "drm_id", "last_name", "deleted_by_name"] as const;
export type DeletedSortColumn = (typeof DELETED_SORTABLE)[number];

export const DELETED_SELECT =
  "id, drm_id, first_name, middle_name, last_name, deleted_at, deleted_by_name, delete_reason, delete_note";

export interface DeletedPatientRow {
  id: string;
  drm_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  deleted_at: string;
  deleted_by_name: string | null;
  delete_reason: string;
  delete_note: string | null;
}

/** Both consumers order the finished row set, before any range or export cap. */
export function deletedPatientsQuery(
  db: AnyClient,
  sort: SortSpec<DeletedSortColumn>,
  opts: { count?: "exact" } = {},
) {
  return db
    .from("v_patients_directory_admin")
    .select(DELETED_SELECT, opts.count ? { count: opts.count } : undefined)
    .not("deleted_at", "is", null)
    .order(sort.key, { ascending: sort.dir === "asc", nullsFirst: false })
    // Tie-break on id — without a total order, .range() can drop or repeat
    // rows across pages.
    .order("id", { ascending: true });
}

/** Fetch just the requested page; the total is never capped by the CSV ceiling. */
export async function loadDeletedPatientsPage(
  db: AnyClient,
  params: { sort: SortSpec<DeletedSortColumn>; from: number; to: number },
): Promise<{ rows: DeletedPatientRow[]; total: number; error: string | null }> {
  const { data, error, count } = await deletedPatientsQuery(db, params.sort, { count: "exact" })
    .range(params.from, params.to)
    .returns<DeletedPatientRow[]>();
  if (error) return { rows: [], total: 0, error: error.message };
  return { rows: data ?? [], total: count ?? 0, error: null };
}

/** CSV walks the same view in bounded chunks, retaining its truncation marker. */
export async function loadAllDeletedPatients(
  db: AnyClient,
  sort: SortSpec<DeletedSortColumn>,
  maxRows: number,
): Promise<{ rows: DeletedPatientRow[]; truncated: boolean }> {
  return fetchAllRows<DeletedPatientRow>(
    (from, to) =>
      deletedPatientsQuery(db, sort).range(from, to).returns<DeletedPatientRow[]>(),
    maxRows,
  );
}

export function deletedPatientsCsvRows(
  rows: readonly DeletedPatientRow[],
  kept: ReadonlyMap<string, KeptCounts>,
): unknown[][] {
  return [
    [
      "DRM-ID",
      "Last name",
      "First name",
      "Middle name",
      "Deleted on",
      "Deleted by",
      "Reason",
      "Note",
      "Visits",
      "Payments",
      "Appointments",
      "Consent records",
    ],
    ...rows.map((r) => {
      const k = kept.get(r.id);
      return [
        r.drm_id,
        r.last_name,
        r.first_name,
        r.middle_name ?? "",
        manilaDateTime(r.deleted_at),
        r.deleted_by_name ?? "",
        deleteReasonLabel(r.delete_reason),
        r.delete_note ?? "",
        k?.visits ?? 0,
        k?.payments ?? 0,
        k?.appointments ?? 0,
        k?.consents ?? 0,
      ];
    }),
  ];
}

export function deletedPatientsCsvFilename(today: string): string {
  return `deleted-patients-${today}.csv`;
}
