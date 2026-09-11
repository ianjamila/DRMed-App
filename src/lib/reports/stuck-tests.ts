/** Stuck tests + queue-integrity checks — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";
import { moneySettled } from "@/lib/visits/money-settled";

type AnyClient = SupabaseClient<Database>;

export interface StuckTestsParams {
  days: number;
}

export function parseStuckTestsParams(sp: { days?: string }): StuckTestsParams {
  const raw = Number(sp.days);
  return {
    days: Number.isFinite(raw) && raw >= 1 && raw <= 365 ? Math.floor(raw) : 3,
  };
}

type PatientEmbed = { first_name: string; last_name: string; drm_id: string };
type VisitEmbed = {
  visit_number: string;
  payment_status: string;
  hmo_provider_id: string | null;
  patients: PatientEmbed | PatientEmbed[] | null;
};

export interface StuckRow {
  id: string;
  status: string;
  requested_at: string;
  assigned_to: string | null;
  visit_id: string;
  services: { code: string; name: string } | { code: string; name: string }[] | null;
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface EmptyVisitRow {
  id: string;
  visit_number: string;
  created_at: string;
  total_php: number;
  payment_status: string;
  patients: PatientEmbed | PatientEmbed[] | null;
}

export interface StuckTestsLists {
  /** Non-final tests older than the threshold (the main table). */
  stuck: StuckRow[];
  /** Package headers at ready_for_release on money-settled visits (paid, waived or HMO) whose components are all terminal — 0109/0138 should have auto-released them. */
  stuckHeaders: StuckRow[];
  /** Package headers with no component rows at all. */
  orphanHeaders: StuckRow[];
  /** Visits with no test_request rows, older than an hour. */
  emptyVisits: EmptyVisitRow[];
}

export interface StuckTestsReport extends StuckTestsLists {
  claimerNames: ReadonlyMap<string, string>;
  truncated: boolean;
}

/**
 * Is this package header's visit money-settled, and therefore a genuine
 * "should have auto-released by now" candidate? Shares `moneySettled` with
 * the DB trigger's predicate (0133/0138) so the report can never again go
 * blind to HMO visits, whose `payment_status` stays 'unpaid' for good.
 */
export function headerCandidateIsSettled(row: StuckRow): boolean {
  const visit = pluckOne(row.visits);
  return visit ? moneySettled(visit) : false;
}

export function ageDays(requestedAt: string, now: number = Date.now()): number {
  return Math.floor((now - new Date(requestedAt).getTime()) / (1000 * 60 * 60 * 24));
}

function cutoffIso(days: number, now: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

const STUCK_SELECT = `
  id, status, requested_at, assigned_to, visit_id,
  services!inner ( code, name ),
  visits!inner (
    visit_number, payment_status, hmo_provider_id,
    patients!inner ( first_name, last_name, drm_id )
  )
`;

export async function loadStuckTests(
  client: AnyClient,
  params: StuckTestsParams,
  maxRows: number,
  now: number = Date.now(),
): Promise<StuckTestsReport> {
  const cutoff = cutoffIso(params.days, now);

  // Non-final tests older than the threshold. No direct patients embed on
  // test_requests — join via visits(patients(...)). A deleted line isn't
  // stuck — it's not owed at all (0125).
  const { rows: stuck, truncated } = await fetchAllRows<StuckRow>(
    (from, to) =>
      client
        .from("test_requests")
        .select(STUCK_SELECT)
        .in("status", ["requested", "in_progress", "result_uploaded", "ready_for_release"])
        .eq("is_package_header", false)
        .lt("requested_at", cutoff)
        .is("deleted_at", null)
        .is("visits.deleted_at", null)
        .order("requested_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<StuckRow[]>(),
    maxRows,
  );

  const claimerNames = new Map<string, string>();
  for (const ids of chunk(unique(stuck.map((r) => r.assigned_to)), IN_CHUNK)) {
    const { data } = await client.from("staff_profiles").select("id, full_name").in("id", ids);
    for (const p of data ?? []) claimerNames.set(p.id, p.full_name);
  }

  // The three integrity lists below keep a flat 100-row cap and do not feed
  // `truncated`: they describe anomalies that should be ~0, not a ledger to
  // export in full. If one ever fills up, the fix is upstream, not a bigger cap.

  // Zero-child package headers — 0130's Population-A predicates, live. Since
  // the atomic visit-creation fix these can no longer be minted, so anything
  // here is pre-fix damage 0130 missed or a regression. The embed hint is the
  // parent_id column (self-referential FK); `.is("components", null)` makes
  // the left-joined embed an anti-join.
  const { data: orphanRaw } = await client
    .from("test_requests")
    .select(`${STUCK_SELECT}, components:test_requests!parent_id ( id )`)
    .eq("is_package_header", true)
    .in("status", ["in_progress", "ready_for_release"])
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .is("components", null)
    .order("requested_at", { ascending: true })
    .limit(100)
    // The `components` embed exists only for the anti-join filter above; it is
    // never read, so the row type deliberately leaves it out.
    .returns<StuckRow[]>();

  // Visits with NO test_request rows — the one partial-write shape the atomic
  // insert still permits. Older than an hour so a request in flight can't
  // false-positive.
  const { data: emptyVisitsRaw } = await client
    .from("visits")
    .select(
      `
      id, visit_number, created_at, total_php, payment_status,
      patients!inner ( first_name, last_name, drm_id ),
      lines:test_requests ( id )
    `,
    )
    .is("deleted_at", null)
    .is("lines", null)
    .lt("created_at", cutoffIso(1 / 24, now))
    .order("created_at", { ascending: true })
    .limit(100)
    .returns<EmptyVisitRow[]>();

  // Package HEADERS sitting at ready_for_release on SETTLED visits whose
  // components are all terminal with ≥1 released — post-0109 this should be
  // empty; anything here means the auto-release didn't fire. "Settled" has
  // included HMO since 0133/0138: an HMO visit's payment_status stays
  // 'unpaid' forever, so the old paid/waived-only filter made this report
  // blind to precisely the stuck headers A3 was about.
  const { data: headersRaw } = await client
    .from("test_requests")
    .select(STUCK_SELECT)
    .eq("is_package_header", true)
    .eq("status", "ready_for_release")
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order("requested_at", { ascending: true })
    .limit(100)
    .returns<StuckRow[]>();

  const headerCandidates = (headersRaw ?? []).filter(headerCandidateIsSettled);

  const stuckHeaders: StuckRow[] = [];
  if (headerCandidates.length > 0) {
    const byParent = new Map<string, string[]>();
    for (const ids of chunk(headerCandidates.map((h) => h.id), IN_CHUNK)) {
      const { data: components } = await client
        .from("test_requests")
        .select("parent_id, status")
        .in("parent_id", ids);
      for (const c of components ?? []) {
        if (!c.parent_id) continue;
        const list = byParent.get(c.parent_id) ?? [];
        list.push(c.status);
        byParent.set(c.parent_id, list);
      }
    }
    for (const h of headerCandidates) {
      const statuses = byParent.get(h.id) ?? [];
      const allTerminal =
        statuses.length > 0 && statuses.every((s) => s === "released" || s === "cancelled");
      if (allTerminal && statuses.some((s) => s === "released")) stuckHeaders.push(h);
    }
  }

  return {
    stuck,
    stuckHeaders,
    orphanHeaders: orphanRaw ?? [],
    emptyVisits: emptyVisitsRaw ?? [],
    claimerNames,
    truncated,
  };
}

export const STUCK_TESTS_CSV_HEADER = [
  "List",
  "Age (days)",
  "Requested / created (Manila)",
  "Visit #",
  "Patient",
  "DRM-ID",
  "Test code",
  "Test",
  "Status",
  "Claimed by",
  "Visit payment",
  "Visit total PHP",
] as const;

function testRow(list: string, r: StuckRow, claimerNames: ReadonlyMap<string, string>, now: number): unknown[] {
  const svc = pluckOne(r.services);
  const visit = pluckOne(r.visits);
  const patient = visit ? pluckOne(visit.patients) : null;
  return [
    list,
    ageDays(r.requested_at, now),
    csvManilaStamp(r.requested_at),
    visit?.visit_number ?? "",
    patient ? `${patient.last_name}, ${patient.first_name}` : "",
    patient?.drm_id ?? "",
    svc?.code ?? "",
    svc?.name ?? "",
    r.status,
    r.assigned_to ? (claimerNames.get(r.assigned_to) ?? "") : "",
    visit?.payment_status ?? "",
    "",
  ];
}

export function stuckTestsCsvRows(
  lists: StuckTestsLists,
  claimerNames: ReadonlyMap<string, string>,
  now: number = Date.now(),
): unknown[][] {
  return [
    [...STUCK_TESTS_CSV_HEADER],
    ...lists.stuck.map((r) => testRow("Stuck test", r, claimerNames, now)),
    ...lists.stuckHeaders.map((r) => testRow("Package header not auto-released", r, claimerNames, now)),
    ...lists.orphanHeaders.map((r) => testRow("Package header with no components", r, claimerNames, now)),
    ...lists.emptyVisits.map((v) => {
      const patient = pluckOne(v.patients);
      return [
        "Visit with no tests",
        ageDays(v.created_at, now),
        csvManilaStamp(v.created_at),
        v.visit_number,
        patient ? `${patient.last_name}, ${patient.first_name}` : "",
        patient?.drm_id ?? "",
        "",
        "",
        "",
        "",
        v.payment_status,
        Number(v.total_php).toFixed(2),
      ];
    }),
  ];
}

export function stuckTestsCsvHref(p: StuckTestsParams): string {
  return `/api/admin/reports/stuck-tests.csv?days=${p.days}`;
}

export function stuckTestsCsvFilename(p: StuckTestsParams, today: string): string {
  return `stuck-tests-${p.days}d-${today}.csv`;
}
