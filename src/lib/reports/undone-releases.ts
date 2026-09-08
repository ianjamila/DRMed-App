/** Undone releases (0110 audit trail) — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { asRecord, csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export interface UndoneReleasesParams {
  start: string;
  end: string;
}

/** Undo is a rare corrective event — default to a wide 90-day window. */
export function parseUndoneReleasesParams(
  sp: { start?: string; end?: string },
  today: string = todayManilaISODate(),
): UndoneReleasesParams {
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -90),
    end: isISODate(sp.end) ? sp.end : today,
  };
}

export interface AuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  resource_id: string | null;
  metadata: Json | null;
}

export interface PatientEmbed {
  first_name: string;
  last_name: string;
  drm_id: string;
}

interface VisitEmbed {
  visit_number: string;
  patients: PatientEmbed | PatientEmbed[] | null;
}

export interface TestRequestRow {
  id: string;
  status: string;
  released_at: string | null;
  visit_id: string;
  services: { name: string; code: string } | { name: string; code: string }[] | null;
  // test_requests has no direct patients FK — reach the patient via visits.
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface UndoneRelease {
  id: number;
  createdAt: string;
  patient: PatientEmbed | null;
  visitNumber: string | null;
  visitId: string | null;
  serviceName: string | null;
  serviceCode: string | null;
  /** The 0110 trigger flipping a package header back after its component was undone. */
  isCascade: boolean;
  actorName: string | null;
  reason: string | null;
  /** Times the patient had opened the result before the undo; null = recorded before tracking existed. */
  viewedCount: number | null;
  /** Current test_requests.status, or null when the row is gone. */
  currentStatus: string | null;
  releasedAt: string | null;
}

export interface UndoneReleasesSummary {
  staffUndos: number;
  stillUnreleased: number;
  reReleased: number;
  viewedBeforeUndo: number;
}

export interface UndoneReleasesReport {
  entries: UndoneRelease[];
  summary: UndoneReleasesSummary;
  truncated: boolean;
}

export function deriveUndoneRelease(
  r: AuditRow,
  trById: ReadonlyMap<string, TestRequestRow>,
  staffNameById: ReadonlyMap<string, string>,
): UndoneRelease {
  const meta = asRecord(r.metadata);
  const tr = r.resource_id ? trById.get(r.resource_id) : undefined;
  const svc = pluckOne(tr?.services ?? null);
  const visit = pluckOne(tr?.visits ?? null);
  const isCascade = r.actor_type === "system";
  return {
    id: r.id,
    createdAt: r.created_at,
    patient: pluckOne(visit?.patients ?? null),
    visitNumber: visit?.visit_number ?? null,
    visitId: tr?.visit_id ?? null,
    serviceName: svc?.name ?? null,
    serviceCode: svc?.code ?? null,
    isCascade,
    actorName: isCascade ? null : (staffNameById.get(r.actor_id ?? "") ?? null),
    reason: isCascade ? null : typeof meta.reason === "string" ? meta.reason : null,
    viewedCount: isCascade ? null : meta.viewed_count != null ? Number(meta.viewed_count) : null,
    currentStatus: tr?.status ?? null,
    releasedAt: tr?.released_at ?? null,
  };
}

export function summariseUndoneReleases(entries: readonly UndoneRelease[]): UndoneReleasesSummary {
  const staffUndos = entries.filter((e) => !e.isCascade);
  return {
    staffUndos: staffUndos.length,
    stillUnreleased: entries.filter((e) => e.currentStatus === "ready_for_release").length,
    reReleased: entries.filter((e) => e.currentStatus === "released").length,
    viewedBeforeUndo: staffUndos.filter((e) => (e.viewedCount ?? 0) > 0).length,
  };
}

export async function loadUndoneReleases(
  client: AnyClient,
  params: UndoneReleasesParams,
  maxRows: number,
): Promise<UndoneReleasesReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);
  // Staff undos carry the reason + viewed_count; cascade rows written by the
  // 0110 trigger are actor_type='system' with metadata.cascaded_from.
  const { rows, truncated } = await fetchAllRows<AuditRow>(
    (from, to) =>
      client
        .from("audit_log")
        .select("id, created_at, actor_id, actor_type, resource_id, metadata")
        .eq("action", "test_request.release_undone")
        .gte("created_at", fromIso!)
        .lt("created_at", toIso!)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<AuditRow[]>(),
    maxRows,
  );

  const trById = new Map<string, TestRequestRow>();
  for (const ids of chunk(unique(rows.map((r) => r.resource_id)), IN_CHUNK)) {
    const { data } = await client
      .from("test_requests")
      .select(
        `
        id, status, released_at, visit_id,
        services ( name, code ),
        visits ( visit_number, patients ( first_name, last_name, drm_id ) )
      `,
      )
      .in("id", ids)
      .returns<TestRequestRow[]>();
    for (const tr of data ?? []) trById.set(tr.id, tr);
  }

  const staffNameById = new Map<string, string>();
  const actorIds = unique(rows.filter((r) => r.actor_type === "staff").map((r) => r.actor_id));
  for (const ids of chunk(actorIds, IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const s of data ?? []) staffNameById.set(s.id, s.full_name);
  }

  const entries = rows.map((r) => deriveUndoneRelease(r, trById, staffNameById));
  return { entries, summary: summariseUndoneReleases(entries), truncated };
}

export function currentStatusLabel(e: UndoneRelease): string {
  if (!e.currentStatus) return "";
  if (e.currentStatus === "released") return "Re-released";
  if (e.currentStatus === "ready_for_release") return "Still unreleased";
  if (e.currentStatus === "cancelled") return "Cancelled";
  return e.currentStatus.replace(/_/g, " ");
}

export const UNDONE_RELEASES_CSV_HEADER = [
  "When (Manila)",
  "Patient",
  "DRM-ID",
  "Visit #",
  "Service",
  "Service code",
  "Undone by",
  "Reason",
  "Viewed before undo",
  "Current status",
  "Re-released at (Manila)",
] as const;

export function undoneReleasesCsvRows(entries: readonly UndoneRelease[]): unknown[][] {
  return [
    [...UNDONE_RELEASES_CSV_HEADER],
    ...entries.map((e) => [
      csvManilaStamp(e.createdAt),
      e.patient ? `${e.patient.last_name}, ${e.patient.first_name}` : "",
      e.patient?.drm_id ?? "",
      e.visitNumber ?? "",
      e.serviceName ?? "",
      e.serviceCode ?? "",
      e.isCascade ? "System (package cascade)" : (e.actorName ?? ""),
      e.isCascade ? "Followed its component's undo" : (e.reason ?? ""),
      e.isCascade ? "" : (e.viewedCount ?? ""),
      currentStatusLabel(e),
      e.currentStatus === "released" ? csvManilaStamp(e.releasedAt) : "",
    ]),
  ];
}

export function undoneReleasesCsvHref(p: UndoneReleasesParams): string {
  return `/api/admin/reports/undone-releases.csv?${new URLSearchParams({ start: p.start, end: p.end })}`;
}

export function undoneReleasesCsvFilename(p: UndoneReleasesParams): string {
  return `undone-releases-${p.start}_${p.end}.csv`;
}
