/** Lab turnaround-time analytics — shared by the page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { LAB_SECTIONS, type ServiceSection } from "@/lib/auth/role-sections";
import { DOCTOR_KINDS_PG_LIST } from "@/lib/visits/classification";
import { isISODate, manilaRangeUtc, shiftISODate, todayManilaISODate } from "@/lib/dates/manila";
import { fetchAllRows } from "./paging";
import { csvManilaStamp, pluckOne } from "./format";

type AnyClient = SupabaseClient<Database>;

export interface LabTatParams {
  start: string;
  end: string;
  /** "" = all sections. */
  section: ServiceSection | "";
}

export function parseLabTatParams(
  sp: { start?: string; end?: string; section?: string },
  today: string = todayManilaISODate(),
): LabTatParams {
  // Only the LAB sections are selectable. A doctor section (`consultation`,
  // `procedure`) now matches nothing here, so a stale bookmark carrying one
  // falls back to "All sections" — the same way an unknown section does —
  // rather than rendering an empty report that reads like a quiet lab.
  const section = (LAB_SECTIONS as readonly string[]).includes(sp.section ?? "")
    ? (sp.section as ServiceSection)
    : "";
  return {
    start: isISODate(sp.start) ? sp.start : shiftISODate(today, -30),
    end: isISODate(sp.end) ? sp.end : today,
    section,
  };
}

/**
 * The bucket a released line lands in when its service carries no `section`.
 *
 * After migration 0144 backfilled the twelve retired catalog rows, exactly one
 * service is still unsectioned: `LEGACY-LAB`, the pre-app import catch-all —
 * one code standing in for whatever the paper record said, spanning every
 * bench (334 lines, 2024-02 → 2026-05). It is deliberately left unsectioned
 * because there is no bench it honestly belongs to, so this row is a real
 * category, not a data gap. The page says so beneath the table.
 */
export const UNSECTIONED_LABEL = "(unset)";

export const SECTION_LABEL: Record<string, string> = {
  chemistry: "Chemistry",
  hematology: "Hematology",
  immunology: "Immunology",
  urinalysis: "Urinalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-ray",
  imaging_ultrasound: "Ultrasound",
  imaging_ecg: "ECG",
  send_out: "Send-out",
  consultation: "Consultation",
  procedure: "Procedure",
  vaccine: "Vaccine",
  home_service: "Home service",
  package: "Package",
};

type ServicesEmbed = { name: string; section: string | null; turnaround_hours: number | null };
type PatientEmbed = { first_name: string; last_name: string };
type VisitEmbed = { visit_number: string; patients: PatientEmbed | PatientEmbed[] | null };

export interface ReleasedRow {
  id: string;
  requested_at: string;
  released_at: string | null;
  status: string;
  services: ServicesEmbed | ServicesEmbed[] | null;
  // test_requests has no direct patients FK — reach the patient via visits.
  visits: VisitEmbed | VisitEmbed[] | null;
}

export interface SectionMetric {
  section: string;
  totalReleased: number;
  pending: number;
  tatSamples: number[];
  slaBreaches: number;
  worstTatHours: number;
  worstTatRequestId: string | null;
}

export interface TatSample {
  requestId: string;
  section: string;
  serviceName: string;
  patientName: string;
  visitNumber: string;
  requestedAt: string;
  releasedAt: string;
  tatHours: number;
  slaHours: number | null;
  breach: boolean;
}

export interface LabTatAggregate {
  /** Sorted by totalReleased desc. */
  metrics: SectionMetric[];
  /** Every released test inside the outlier window, in query order. */
  samples: TatSample[];
  /** First SLA_BREACH_DETAIL_LIMIT breaches — the on-screen detail table. */
  slaBreachRows: TatSample[];
  overall: {
    median: number | null;
    p95: number | null;
    totalReleased: number;
    totalBreaches: number;
    breachPct: number;
  };
}

export interface LabTatReport extends LabTatAggregate {
  /** Requested-but-unreleased right now, regardless of window. */
  pendingTotal: number;
  truncated: boolean;
}

/** Samples beyond 60 days are garbage data (legacy imports), not slow labs. */
export const TAT_OUTLIER_HOURS = 24 * 60;
export const SLA_BREACH_DETAIL_LIMIT = 20;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

export function aggregateLabTat(released: readonly ReleasedRow[]): LabTatAggregate {
  const metricsBySection = new Map<string, SectionMetric>();
  const ensure = (section: string): SectionMetric => {
    let m = metricsBySection.get(section);
    if (!m) {
      m = { section, totalReleased: 0, pending: 0, tatSamples: [], slaBreaches: 0, worstTatHours: 0, worstTatRequestId: null };
      metricsBySection.set(section, m);
    }
    return m;
  };

  const samples: TatSample[] = [];
  for (const tr of released) {
    if (!tr.released_at) continue;
    const svc = pluckOne(tr.services);
    if (!svc) continue;
    const sec = svc.section ?? UNSECTIONED_LABEL;
    const m = ensure(sec);
    m.totalReleased += 1;

    const tatHours = (Date.parse(tr.released_at) - Date.parse(tr.requested_at)) / 3_600_000;
    if (!(tatHours >= 0 && tatHours < TAT_OUTLIER_HOURS)) continue;

    m.tatSamples.push(tatHours);
    if (tatHours > m.worstTatHours) {
      m.worstTatHours = tatHours;
      m.worstTatRequestId = tr.id;
    }
    const slaHours = svc.turnaround_hours ?? null;
    const breach = slaHours !== null && tatHours > slaHours;
    if (breach) m.slaBreaches += 1;

    const v = pluckOne(tr.visits);
    const p = pluckOne(v?.patients ?? null);
    samples.push({
      requestId: tr.id,
      section: sec,
      serviceName: svc.name,
      patientName: p ? `${p.last_name}, ${p.first_name}` : "Walk-in",
      visitNumber: v?.visit_number ?? "—",
      requestedAt: tr.requested_at,
      releasedAt: tr.released_at,
      tatHours,
      slaHours,
      breach,
    });
  }

  const metrics = Array.from(metricsBySection.values()).sort((a, b) => b.totalReleased - a.totalReleased);
  const allSamples = metrics.flatMap((r) => r.tatSamples);
  const totalReleased = metrics.reduce((s, r) => s + r.totalReleased, 0);
  const totalBreaches = metrics.reduce((s, r) => s + r.slaBreaches, 0);
  return {
    metrics,
    samples,
    slaBreachRows: samples.filter((s) => s.breach).slice(0, SLA_BREACH_DETAIL_LIMIT),
    overall: {
      median: median(allSamples),
      p95: percentile(allSamples, 0.95),
      totalReleased,
      totalBreaches,
      breachPct: totalReleased > 0 ? Math.round((totalBreaches / totalReleased) * 100) : 0,
    },
  };
}

export async function loadLabTat(
  client: AnyClient,
  params: LabTatParams,
  maxRows: number,
): Promise<LabTatReport> {
  const { fromIso, toIso } = manilaRangeUtc(params.start, params.end);

  // Released test_requests in the window (the TAT samples). No deleted_at
  // filter on purpose: a released line can never be soft-deleted (0125's
  // guard raises P0043 on status = released), so it would be a no-op.
  //
  // Doctor lines are excluded. `test_requests` doubles as the visit's bill
  // line, so consultations and procedures sit in it alongside lab tests
  // (0090). They go straight requested → released at the counter with no
  // bench step, so every one of them is a ~0-hour "turnaround" that is not a
  // turnaround at all. Measured on prod: 7,399 of 25,576 released lines are
  // doctor lines and ALL of them clock under half an hour, dragging the mean
  // TAT from 0.1197h to 0.0851h — and since the consultation anchor carries
  // no `section`, they piled into the "(unset)" row (7,399 of its 9,890) and
  // into the CSV as rows with a blank Section column.
  const { rows: released, truncated } = await fetchAllRows<ReleasedRow>((from, to) => {
    let q = client
      .from("test_requests")
      .select(
        `
        id, requested_at, released_at, status,
        services!inner ( name, section, turnaround_hours ),
        visits ( visit_number, patients ( first_name, last_name ) )
      `,
      )
      .eq("status", "released")
      .gte("released_at", fromIso!)
      .lt("released_at", toIso!)
      .not("services.kind", "in", DOCTOR_KINDS_PG_LIST)
      .order("released_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (params.section) q = q.eq("services.section", params.section);
    return q.returns<ReleasedRow[]>();
  }, maxRows);

  // Pending = requested but not yet released, regardless of window (what is
  // currently stuck). Live lines only (0125), lab lines only — a consultation
  // is never "awaiting release", so counting one here would put the Pending
  // tile permanently in its amber state over work nobody owes.
  let pendingQ = client
    .from("test_requests")
    .select("id, services!inner ( section )", { count: "exact", head: true })
    .in("status", ["requested", "in_progress", "result_uploaded", "ready_for_release"])
    .is("deleted_at", null)
    .not("services.kind", "in", DOCTOR_KINDS_PG_LIST);
  if (params.section) pendingQ = pendingQ.eq("services.section", params.section);
  const { count: pendingTotal } = await pendingQ;

  return { ...aggregateLabTat(released), pendingTotal: pendingTotal ?? 0, truncated };
}

export const LAB_TAT_CSV_HEADER = [
  "Section",
  "Service",
  "Patient",
  "Visit #",
  "Requested (Manila)",
  "Released (Manila)",
  "TAT hours",
  "SLA hours",
  "SLA breach",
] as const;

export function labTatCsvRows(samples: readonly TatSample[]): unknown[][] {
  return [
    [...LAB_TAT_CSV_HEADER],
    ...samples.map((s) => [
      SECTION_LABEL[s.section] ?? s.section,
      s.serviceName,
      s.patientName,
      s.visitNumber,
      csvManilaStamp(s.requestedAt),
      csvManilaStamp(s.releasedAt),
      s.tatHours.toFixed(1),
      s.slaHours ?? "",
      s.breach ? "yes" : "no",
    ]),
  ];
}

export function labTatCsvHref(p: LabTatParams): string {
  const qs = new URLSearchParams({ start: p.start, end: p.end });
  if (p.section) qs.set("section", p.section);
  return `/api/admin/reports/lab-tat.csv?${qs}`;
}

export function labTatCsvFilename(p: LabTatParams): string {
  return `lab-tat-${p.start}_${p.end}${p.section ? `-${p.section}` : ""}.csv`;
}
