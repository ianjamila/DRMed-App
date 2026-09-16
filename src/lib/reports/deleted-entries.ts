/** Deleted queue entries (0125 audit trail) — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import type { SortSpec } from "@/lib/ui/table-params";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { asRecord, csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export const DELETE_ACTIONS = ["visit.deleted", "test_request.deleted"] as const;
export const RESTORE_ACTIONS = ["visit.restored", "test_request.restored"] as const;
const ALL_ACTIONS = [...DELETE_ACTIONS, ...RESTORE_ACTIONS];

export interface DeletedEntriesParams {
  start: string;
  end: string;
}

/** Deletion is a corrective event, not routine — default to a wide 90-day window. */
export function parseDeletedEntriesParams(
  sp: { start?: string; end?: string },
  today: string = todayManilaISODate(),
): DeletedEntriesParams {
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -90),
    end: isISODate(sp.end) ? sp.end : today,
  };
}

export interface AuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Json | null;
}

export interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

export interface VisitRow {
  id: string;
  visit_number: string;
  deleted_at: string | null;
  total_php: number;
  patients: PatientEmbed | PatientEmbed[] | null;
}

type TrVisitEmbed = {
  visit_number: string;
  deleted_at: string | null;
  patients: PatientEmbed | PatientEmbed[] | null;
};

export interface TestRequestRow {
  id: string;
  deleted_at: string | null;
  visit_id: string;
  services: { name: string; code: string } | { name: string; code: string }[] | null;
  visits: TrVisitEmbed | TrVisitEmbed[] | null;
}

/** One rendered/exported row — everything the table needs, resolved once. */
export interface DeletedEntry {
  id: number;
  createdAt: string;
  isDelete: boolean;
  isVisit: boolean;
  patient: PatientEmbed | null;
  visitNumber: string | null;
  visitHref: string | null;
  /** Visit deletes: how many live tests went with it. */
  activeTestCount: number | null;
  /** Test deletes: the service, from the row or (if gone) the audit metadata. */
  serviceName: string | null;
  serviceCode: string | null;
  isPackageHeader: boolean;
  actorName: string | null;
  reason: string | null;
  amount: number | null;
  currentlyDeleted: boolean;
}

export interface DeletedEntriesSummary {
  deleteEvents: number;
  restoreEvents: number;
  stillDeleted: number;
  deletedValue: number;
}

export interface DeletedEntriesReport {
  entries: DeletedEntry[];
  summary: DeletedEntriesSummary;
  truncated: boolean;
}

export function deriveDeletedEntry(
  r: AuditRow,
  visitById: ReadonlyMap<string, VisitRow>,
  trById: ReadonlyMap<string, TestRequestRow>,
  staffNameById: ReadonlyMap<string, string>,
): DeletedEntry {
  const meta = asRecord(r.metadata);
  const isDelete = (DELETE_ACTIONS as readonly string[]).includes(r.action);
  const isVisit = r.resource_type === "visit";
  const visitRow = isVisit && r.resource_id ? visitById.get(r.resource_id) : undefined;
  const trRow = !isVisit && r.resource_id ? trById.get(r.resource_id) : undefined;
  const trVisit = pluckOne(trRow?.visits ?? null);
  const patient = isVisit
    ? pluckOne(visitRow?.patients ?? null)
    : pluckOne(trVisit?.patients ?? null);
  const svc = pluckOne(trRow?.services ?? null);
  const metaVisitNumber =
    typeof meta.visit_number === "string" || typeof meta.visit_number === "number"
      ? String(meta.visit_number)
      : null;
  const visitId = isVisit
    ? r.resource_id
    : (trRow?.visit_id ?? (typeof meta.visit_id === "string" ? meta.visit_id : null));
  const amount = isVisit
    ? typeof meta.total_php === "number" ? meta.total_php : null
    : typeof meta.final_price_php === "number" ? meta.final_price_php : null;
  const currentlyDeleted = isVisit
    ? (visitRow?.deleted_at ?? null) != null
    : (trRow?.deleted_at ?? null) != null || (trVisit?.deleted_at ?? null) != null;

  return {
    id: r.id,
    createdAt: r.created_at,
    isDelete,
    isVisit,
    patient,
    visitNumber: isVisit ? (visitRow?.visit_number ?? metaVisitNumber) : (trVisit?.visit_number ?? null),
    visitHref: visitId ? `/staff/visits/${visitId}` : null,
    activeTestCount: typeof meta.active_test_count === "number" ? meta.active_test_count : null,
    serviceName: svc?.name ?? (typeof meta.service_name === "string" ? meta.service_name : null),
    serviceCode: svc?.code ?? (typeof meta.service_code === "string" ? meta.service_code : null),
    isPackageHeader: meta.is_package_header === true,
    actorName: staffNameById.get(r.actor_id ?? "") ?? null,
    reason: typeof meta.reason === "string" ? meta.reason : null,
    amount,
    currentlyDeleted,
  };
}

export function summariseDeletedEntries(entries: readonly DeletedEntry[]): DeletedEntriesSummary {
  const deletes = entries.filter((e) => e.isDelete);
  return {
    deleteEvents: deletes.length,
    restoreEvents: entries.length - deletes.length,
    stillDeleted: deletes.filter((e) => e.currentlyDeleted).length,
    deletedValue: deletes.reduce((sum, e) => sum + (e.amount ?? 0), 0),
  };
}

/**
 * Sortable columns for the deleted-entries table.
 *
 * Same in-memory situation as `users/page.tsx`: `loadDeletedEntries` already
 * pulls the whole date-windowed set into memory (there's a resolved-name/
 * visit-lookup pass over it before a row can even be rendered), so this never
 * reaches a PostgREST `.order()`. It still goes through `parseSort`'s
 * allow-list rather than trusting the raw param, so a hand-edited `?sort=`
 * falls back to the default instead of hitting `compareDeletedEntries`'s
 * `switch` with a key it doesn't handle.
 */
export const DELETED_ENTRIES_SORTABLE_COLUMNS = [
  "when",
  "event",
  "patient",
  "visit",
  "what",
  "by",
  "amount",
  "outcome",
] as const;
export type DeletedEntriesSortColumn = (typeof DELETED_ENTRIES_SORTABLE_COLUMNS)[number];

// Most-recent-deletion-first is the useful default for a corrective/audit
// report — "what just happened" — the same reasoning behind the 90-day
// default window in `parseDeletedEntriesParams` above.
export const DELETED_ENTRIES_DEFAULT_SORT: SortSpec<DeletedEntriesSortColumn> = {
  key: "when",
  dir: "desc",
};

// A row missing the value being sorted on sinks to the bottom regardless of
// direction (the NULLS_LAST rule every report in this batch follows) —
// flipping to ascending shouldn't surface every entry with no resolvable
// patient/visit/service/actor/amount ahead of the ones that have one.
const NULLS_LAST_COLUMNS = new Set<DeletedEntriesSortColumn>([
  "patient",
  "visit",
  "what",
  "by",
  "amount",
]);

function patientSortKey(e: DeletedEntry): string | null {
  return e.patient ? `${e.patient.last_name}, ${e.patient.first_name}` : null;
}

// Mirrors what the "What" cell actually prints: a visit-delete always reads
// "Entire visit" (never the deleted tests' names — those aren't on the
// audit row), a test-delete reads its service name, which can itself be
// null when even the audit metadata didn't carry one.
function whatSortKey(e: DeletedEntry): string | null {
  return e.isVisit ? "Entire visit" : e.serviceName;
}

export function compareDeletedEntries(
  a: DeletedEntry,
  b: DeletedEntry,
  sort: SortSpec<DeletedEntriesSortColumn>,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp: number;

  if (NULLS_LAST_COLUMNS.has(sort.key)) {
    // One null-handling branch covers all five of these columns; "amount"
    // is the only genuinely numeric one, the rest compare as text once the
    // null case is out of the way.
    let av: string | number | null;
    let bv: string | number | null;
    switch (sort.key) {
      case "patient":
        av = patientSortKey(a);
        bv = patientSortKey(b);
        break;
      case "visit":
        // Rule: never Number() a visit_number — prod holds "H-1001" and
        // "H-LAB_SERVICE-0-3" beside "0042", and Number() on those is NaN.
        av = a.visitNumber;
        bv = b.visitNumber;
        break;
      case "what":
        av = whatSortKey(a);
        bv = whatSortKey(b);
        break;
      case "by":
        av = a.actorName;
        bv = b.actorName;
        break;
      case "amount":
        av = a.amount;
        bv = b.amount;
        break;
      default:
        av = null;
        bv = null;
    }
    if (av === null && bv === null) cmp = 0;
    else if (av === null) return 1; // always last, independent of direction
    else if (bv === null) return -1; // always last, independent of direction
    else if (typeof av === "number" && typeof bv === "number") cmp = dirMul * (av - bv);
    else cmp = dirMul * String(av).localeCompare(String(bv));
  } else {
    switch (sort.key) {
      case "when":
        cmp = dirMul * a.createdAt.localeCompare(b.createdAt);
        break;
      case "event":
        // Deletes sort ahead of restores when descending — the report's
        // whole point is surfacing what got deleted, so that's the useful
        // "top of the list" for the default direction; ascending flips to
        // restores-first. Same numeric-boolean idiom as `users/page.tsx`'s
        // `is_active` column.
        cmp = dirMul * (Number(a.isDelete) - Number(b.isDelete));
        break;
      case "outcome":
        cmp = dirMul * (Number(a.currentlyDeleted) - Number(b.currentlyDeleted));
        break;
      default:
        cmp = 0;
    }
  }

  // audit_log.id is a NUMBER — unlike every other id in this report batch,
  // which is a uuid compared with localeCompare — so the tie-break here is
  // arithmetic.
  return cmp !== 0 ? cmp : a.id - b.id;
}

export async function loadDeletedEntries(
  client: AnyClient,
  params: DeletedEntriesParams,
  maxRows: number,
): Promise<DeletedEntriesReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);
  const { rows, truncated } = await fetchAllRows<AuditRow>(
    (from, to) =>
      client
        .from("audit_log")
        .select("id, created_at, actor_id, action, resource_type, resource_id, metadata")
        .in("action", ALL_ACTIONS)
        .gte("created_at", fromIso!)
        .lt("created_at", toIso!)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<AuditRow[]>(),
    maxRows,
  );

  // Current outcome of each entry — batched by resource type, chunked ids.
  const visitById = new Map<string, VisitRow>();
  const visitIds = unique(rows.filter((r) => r.resource_type === "visit").map((r) => r.resource_id));
  for (const ids of chunk(visitIds, IN_CHUNK)) {
    const { data } = await client
      .from("visits")
      .select("id, visit_number, deleted_at, total_php, patients ( first_name, last_name, drm_id )")
      .in("id", ids)
      .returns<VisitRow[]>();
    for (const v of data ?? []) visitById.set(v.id, v);
  }

  const trById = new Map<string, TestRequestRow>();
  const trIds = unique(rows.filter((r) => r.resource_type === "test_request").map((r) => r.resource_id));
  for (const ids of chunk(trIds, IN_CHUNK)) {
    const { data } = await client
      .from("test_requests")
      .select(
        `
        id, deleted_at, visit_id,
        services ( name, code ),
        visits ( visit_number, deleted_at, patients ( first_name, last_name, drm_id ) )
      `,
      )
      .in("id", ids)
      .returns<TestRequestRow[]>();
    for (const tr of data ?? []) trById.set(tr.id, tr);
  }

  const staffNameById = new Map<string, string>();
  for (const ids of chunk(unique(rows.map((r) => r.actor_id)), IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const s of data ?? []) staffNameById.set(s.id, s.full_name);
  }

  const entries = rows.map((r) => deriveDeletedEntry(r, visitById, trById, staffNameById));
  return { entries, summary: summariseDeletedEntries(entries), truncated };
}

export const DELETED_ENTRIES_CSV_HEADER = [
  "When (Manila)",
  "Event",
  "Patient",
  "DRM-ID",
  "Visit #",
  "What",
  "Service code",
  "By",
  "Reason",
  "Amount PHP",
  "Currently deleted",
] as const;

export function deletedEntriesCsvRows(entries: readonly DeletedEntry[]): unknown[][] {
  return [
    [...DELETED_ENTRIES_CSV_HEADER],
    ...entries.map((e) => [
      csvManilaStamp(e.createdAt),
      e.isDelete ? "Deleted" : "Restored",
      e.patient ? `${e.patient.last_name}, ${e.patient.first_name}` : "",
      e.patient?.drm_id ?? "",
      e.visitNumber ?? "",
      e.isVisit
        ? `Entire visit${e.activeTestCount != null ? ` (${e.activeTestCount} ${e.activeTestCount === 1 ? "test" : "tests"})` : ""}`
        : `${e.serviceName ?? ""}${e.isPackageHeader ? " · package" : ""}`,
      e.isVisit ? "" : (e.serviceCode ?? ""),
      e.actorName ?? "",
      e.reason ?? "",
      e.amount != null ? Number(e.amount).toFixed(2) : "",
      e.currentlyDeleted ? "yes" : "no",
    ]),
  ];
}

export function deletedEntriesCsvHref(p: DeletedEntriesParams): string {
  return `/api/admin/reports/deleted-entries.csv?${new URLSearchParams({ start: p.start, end: p.end })}`;
}

export function deletedEntriesCsvFilename(p: DeletedEntriesParams): string {
  return `deleted-entries-${p.start}_${p.end}.csv`;
}
