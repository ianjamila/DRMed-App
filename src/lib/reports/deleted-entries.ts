/** Deleted queue entries (0125 audit trail) — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
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
