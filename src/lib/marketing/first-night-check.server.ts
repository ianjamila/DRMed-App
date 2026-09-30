/**
 * First-night check — the fetching half. Reads every "New patients" screen's
 * numbers for a range through the SAME loaders and formatters those screens use
 * (never a direct database function call — `patient-sources-surfaces.test.ts` pins that),
 * then hands them to the pure judge in `first-night-check.ts`.
 *
 * Read-only. Counts only: no names or ids leave the database.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { mapWithConcurrency } from "@/lib/async/map-with-concurrency";
import { shiftISODate } from "@/lib/dates/manila";
import { formatNewToday, newPatientsTile, type SeriesRow, type SummaryRow } from "./patient-sources";
import {
  loadNewPatientsToday, loadPatientSourcesSeries, loadPatientSourcesSummary,
} from "./patient-sources.server";
import { PATIENT_SOURCES_MIN_DATE } from "./period";
import {
  enumerateDays, evaluateCheck, FORBIDDEN_CHECK_MESSAGE,
  type CheckParams, type CheckReport, type Counts, type DayInput, type LoadError,
} from "./first-night-check";

type Db = SupabaseClient<Database>;
export type Created = { app: number; imported: number };

export interface CheckDeps {
  loadSummary: typeof loadPatientSourcesSummary;
  loadSeries: typeof loadPatientSourcesSeries;
  loadToday: typeof loadNewPatientsToday;
  countCreated: (client: Db, date: string) => Promise<Created>;
}

/** Records created on one Manila day (deleted or merged ones included — it is a count of what was created, not a directory): app registrations vs imported (Sheet Sync creates set legacy_import_run_id). */
export async function countPatientsCreated(client: Db, date: string): Promise<Created> {
  const start = `${date}T00:00:00+08:00`;
  const end = `${shiftISODate(date, 1)}T00:00:00+08:00`;
  const base = () =>
    client.from("patients").select("id", { count: "exact", head: true })
      .gte("created_at", start).lt("created_at", end);
  const [app, imported] = await Promise.all([
    base().is("legacy_import_run_id", null),
    base().not("legacy_import_run_id", "is", null),
  ]);
  if (app.error || imported.error) throw new Error((app.error ?? imported.error)!.message);
  return { app: app.count ?? 0, imported: imported.count ?? 0 };
}

export const DEFAULT_DEPS: CheckDeps = {
  loadSummary: loadPatientSourcesSummary,
  loadSeries: loadPatientSourcesSeries,
  loadToday: loadNewPatientsToday,
  countCreated: countPatientsCreated,
};

/** Per-day report calls in flight at once (each day makes three). */
export const CHECK_CONCURRENCY = 4;

const summaryCounts = (s: SummaryRow): Counts => ({ confirmed: Number(s.new_confirmed), unconfirmed: Number(s.new_unconfirmed) });

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runFirstNightCheck(
  client: Db,
  params: CheckParams,
  deps: CheckDeps = DEFAULT_DEPS,
): Promise<{ report: CheckReport; durationMs: number }> {
  const started = Date.now();
  const errors: LoadError[] = [];
  const fail = (what: string, r: { message: string; kind?: string }, date?: string) =>
    errors.push({ what, date, message: r.kind === "forbidden" ? FORBIDDEN_CHECK_MESSAGE : r.message });

  const dates = enumerateDays(params.from, params.to);

  // Whole-range reads: the Patient Sources card, the Booking Sources card (its
  // own call, like that page) and the chart series.
  const [card, booking, series] = await Promise.all([
    deps.loadSummary(client, params.from, params.to),
    // Booking Sources skips the call before Patient Sources' first date.
    params.from < PATIENT_SOURCES_MIN_DATE ? Promise.resolve(null) : deps.loadSummary(client, params.from, params.to),
    deps.loadSeries(client, params.from, params.to, "day", "new"),
  ]);

  if (!card.ok) fail("Patient Sources", card);
  if (booking && !booking.ok) fail("Booking Sources", booking);

  let chartByDay: Map<string, Counts> | null = null;
  let chartTotal: Counts | null = null;
  if (!series.ok) fail("the Patient Sources day-by-day chart", series);
  else if (series.data.truncated) {
    errors.push({ what: "the Patient Sources day-by-day chart", message: "The chart data was cut off at the row limit — pick a shorter range." });
  } else {
    chartByDay = new Map();
    chartTotal = { confirmed: 0, unconfirmed: 0 };
    for (const r of series.data.rows as SeriesRow[]) {
      const cur = chartByDay.get(r.bucket_start) ?? { confirmed: 0, unconfirmed: 0 };
      cur.confirmed += Number(r.confirmed);
      cur.unconfirmed += Number(r.unconfirmed);
      chartByDay.set(r.bucket_start, cur);
      chartTotal.confirmed += Number(r.confirmed);
      chartTotal.unconfirmed += Number(r.unconfirmed);
    }
  }

  // Per-day reads.
  const days: DayInput[] = await mapWithConcurrency(dates, CHECK_CONCURRENCY, async (date) => {
    const [daySummary, today, created] = await Promise.all([
      deps.loadSummary(client, date, date),
      deps.loadToday(client, date),
      deps.countCreated(client, date).then(
        (v): { ok: true; data: Created } | { ok: false; message: string } => ({ ok: true, data: v }),
        (e) => ({ ok: false as const, message: errMessage(e) }),
      ),
    ]);
    let summary: Counts | null = null;
    if (daySummary.ok) summary = summaryCounts(daySummary.data);
    else fail("the day-by-day Patient Sources figures", daySummary, date);

    let tile: Counts | null = null;
    if (today.ok) {
      const f = formatNewToday(today.data);
      tile = { confirmed: f.total - f.unconfirmed, unconfirmed: f.unconfirmed };
    } else fail("the dashboard tile", today, date);

    if (!created.ok) fail("the patient records count", created, date);
    return {
      date,
      summary,
      chart: chartByDay ? (chartByDay.get(date) ?? { confirmed: 0, unconfirmed: 0 }) : null,
      tile,
      created: created.ok ? created.data : null,
    };
  });

  // Rendered by the Booking Sources page's own formatter. Null = not shown (before Dec 2023) or not loaded.
  const bookingCardText = booking && booking.ok ? newPatientsTile(booking).value : null;

  const s = card.ok ? card.data : null;
  const report = evaluateCheck({
    params,
    patientSourcesCard: s ? summaryCounts(s) : null,
    bookingCardText,
    chartTotal,
    days,
    loadErrors: errors,
    sync: s
      ? {
          paused: s.sync_paused,
          lastSyncedAt: s.last_synced_at,
          lastRunStatus: s.last_run_status,
          undatedRegistrations: Number(s.undated_registrations),
        }
      : null,
  });
  return { report, durationMs: Date.now() - started };
}
