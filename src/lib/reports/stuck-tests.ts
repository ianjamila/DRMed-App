/** Stuck tests + queue-integrity checks — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunk, fetchAllRows, fetchCompleteRows, IN_CHUNK, unique } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";
import { moneySettled } from "@/lib/visits/money-settled";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import type { SortSpec } from "@/lib/ui/table-params";

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
 * Sortable columns for the main `stuck` table. The three integrity lists
 * (`stuckHeaders`, `orphanHeaders`, `emptyVisits`) deliberately keep their
 * flat 100-row cap and fixed `requested_at`/`created_at` order — they exist
 * to describe anomalies that should be ~0, not a ledger to page through — so
 * they are NOT part of this allow-list and never reach `parseSort`.
 */
export const STUCK_SORTABLE_COLUMNS = [
  "age",
  "visit",
  "patient",
  "test",
  "status",
  "claimed",
  "payment",
] as const;
export type StuckSortColumn = (typeof STUCK_SORTABLE_COLUMNS)[number];

// Oldest-first is the useful default for a report whose whole point is "what
// has been ignored longest" — the worst offender should be the first row a
// reader sees, with no click required. Age counts UP the longer a row sits
// untouched, so "age desc" (biggest number, i.e. oldest) is the default.
export const STUCK_DEFAULT_SORT: SortSpec<StuckSortColumn> = { key: "age", dir: "desc" };

function patientNameOf(r: StuckRow): string {
  const visit = pluckOne(r.visits);
  const patient = visit ? pluckOne(visit.patients) : null;
  return patient ? `${patient.last_name}, ${patient.first_name}` : "";
}

/**
 * Comparator for the main `stuck` table. Takes `claimerNames` as an explicit
 * argument (rather than closing over it) because the "Claimed by" column
 * sorts on the resolved staff name, not the raw `assigned_to` uuid, and this
 * function is pure/exported for its own unit tests.
 */
export function compareStuckRows(
  a: StuckRow,
  b: StuckRow,
  sort: SortSpec<StuckSortColumn>,
  claimerNames: ReadonlyMap<string, string>,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp: number;

  switch (sort.key) {
    case "age": {
      // Age is the INVERSE of requested_at: the oldest row has the SMALLEST
      // requested_at but the LARGEST age. So this column's default ("age
      // desc" = oldest first) needs requested_at sorted ASCENDING — the
      // opposite sign from `dirMul` above, which every other column here
      // uses unmodified. Flip it here instead of trying to bend `dirMul`
      // itself, or "oldest first" quietly becomes "newest first".
      const raw = a.requested_at.localeCompare(b.requested_at);
      cmp = sort.dir === "desc" ? raw : -raw;
      break;
    }
    case "visit": {
      // visit_number is TEXT. Prod holds "#0H-1", "#H-1001" and
      // "#H-LAB_SERVICE-0-3" alongside zero-padded "0042" — Number() turns
      // almost all of those into NaN, and NaN comparisons are never 0, which
      // would silently disable the id tie-break below. Compare as text.
      const av = pluckOne(a.visits)?.visit_number ?? "";
      const bv = pluckOne(b.visits)?.visit_number ?? "";
      cmp = dirMul * av.localeCompare(bv);
      break;
    }
    case "patient":
      cmp = dirMul * patientNameOf(a).localeCompare(patientNameOf(b));
      break;
    case "test": {
      const at = pluckOne(a.services)?.name ?? "";
      const bt = pluckOne(b.services)?.name ?? "";
      cmp = dirMul * at.localeCompare(bt);
      break;
    }
    case "status":
      cmp = dirMul * a.status.localeCompare(b.status);
      break;
    case "claimed": {
      const an = a.assigned_to ? (claimerNames.get(a.assigned_to) ?? null) : null;
      const bn = b.assigned_to ? (claimerNames.get(b.assigned_to) ?? null) : null;
      // Unclaimed sinks to the bottom regardless of direction, same rule as
      // NULLS_LAST_COLUMNS in users/page.tsx — otherwise "ascending" would
      // surface every unclaimed row first, the least useful reading of
      // "who's holding this test".
      if (an === null && bn === null) cmp = 0;
      else if (an === null) return 1;
      else if (bn === null) return -1;
      else cmp = dirMul * an.localeCompare(bn);
      break;
    }
    case "payment": {
      const av = pluckOne(a.visits)?.payment_status ?? "";
      const bv = pluckOne(b.visits)?.payment_status ?? "";
      cmp = dirMul * av.localeCompare(bv);
      break;
    }
    default:
      cmp = 0;
  }

  // Tie-break on id, ascending. test_requests.id is a uuid string here —
  // contrast the audit_log-backed reports (deleted-entries, undone-releases)
  // in this same suite, whose tie-break is `a.id - b.id` because that id is
  // a number.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
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
  //
  // Doctor lines are excluded. `test_requests` doubles as the visit's bill
  // line, so consultations and procedures sit in it alongside lab tests
  // (0090), but nobody ever works a consult on the bench: it has no queue
  // step that could clear it. A pending one therefore ages forever, and this
  // list is the one place that reads that as a problem to chase.
  //
  // Prod holds 3 such lines (71–106 days old); 2 of them are on soft-deleted
  // visits the `visits.deleted_at` filter above already dropped, so exactly
  // one reached the report — and it was the report's ONLY row, so the page
  // now correctly reads "nothing stuck" instead of naming work no one could
  // ever finish. They still surface on /staff/visits under the "Doctor
  // Consults" chip, which is where that follow-up belongs.
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
        .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
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
  //
  // None of them needs the doctor-kind filter the `stuck` query above carries.
  // The two header lists select `is_package_header = true`, and a package
  // header is a `lab_package` by construction — prod has zero doctor-kind
  // headers. `emptyVisits` counts test_request ROWS per visit, so a
  // consultation-only visit is correctly not empty: it has a bill line.

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
      const { data: components, error } = await fetchCompleteRows((from, to) =>
        client
          .from("test_requests")
          .select("parent_id, status")
          .in("parent_id", ids)
          .order("id", { ascending: true })
          .range(from, to)
      );
      if (error) throw new Error(error.message);
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
