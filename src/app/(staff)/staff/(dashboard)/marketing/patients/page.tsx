import Link from "next/link";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PageHeader } from "@/components/staff/page-header";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { manilaDate, manilaDateTime, todayManilaISODate } from "@/lib/dates/manila";
import { firstParam, PATIENT_SOURCES_MIN_DATE, periodHref, resolvePeriod } from "@/lib/marketing/period";
import {
  GRAIN_LABEL, MODE_LABEL, capRows, channelTable, comparisonPeriod, formatNewCounts, chartData, costPerNewPatient, parseGrain, parseMode, previousPeriod,
  sheetBanner, type Grain, type Mode,
} from "@/lib/marketing/patient-sources";
import { loadAdSpendCoverage, loadAdSpendTotals, loadPatientSourcesReport } from "@/lib/marketing/patient-sources.server";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { StatCard } from "../../_dashboards/_components/stat-card";
import { PeriodControls } from "../_components/period-controls";
import { ChannelChartLoader } from "./_components/channel-chart-loader";
import { ChannelTableSection, CostSection, ReferrersSection, RevenueSection } from "./_components/report-sections";

export const metadata = { title: ROUTE_NAME["/staff/marketing/patients"] };
export const dynamic = "force-dynamic";

const PATHNAME = "/staff/marketing/patients";
const SHEET_TABS: Record<string, string> = { lab: "Lab", consult: "Consultations", customers: "Customers" };

export default async function PatientSourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireAdminStaff();
  const sp = await searchParams;
  const todayISO = todayManilaISODate();
  const period = resolvePeriod({ from: firstParam(sp.from), to: firstParam(sp.to) }, todayISO, { min: PATIENT_SOURCES_MIN_DATE });
  const mode: Mode = parseMode(firstParam(sp.mode));
  const grain: Grain = parseGrain(firstParam(sp.grain));
  const params = { from: period.from, to: period.to, mode, grain };
  const prev = previousPeriod(period.from, period.to);
  const supabase = await createClient();

  // One report call (0206): the database builds who-is-who once and every
  // card below reads the same snapshot. The previous period may start before
  // Patient Sources' first date (the database refuses that): no comparison.
  const [report, spend, coverage] = await Promise.all([
    loadPatientSourcesReport(supabase, {
      from: period.from, to: period.to, grain, mode,
      prev: comparisonPeriod(prev, PATIENT_SOURCES_MIN_DATE),
    }),
    loadAdSpendTotals(supabase, period.from, period.to),
    loadAdSpendCoverage(supabase),
  ]);

  const header = (
    <PageHeader
      eyebrow={SECTION_NAME["/staff/marketing"]}
      title={ROUTE_NAME["/staff/marketing/patients"]}
      subtitle="Where new and returning customers came from, per day, week or month — from the app and, once the sheet sync runs, from the reception Google Sheet."
    />
  );

  if (!report.ok) {
    return (
      <div>
        {header}
        <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
          {report.message}
        </p>
      </div>
    );
  }
  const r = report.data;
  // The overlaps list keeps the export ceiling the paged loader applied.
  const overlaps = capRows(r.overlaps, REPORT_EXPORT_MAX_ROWS);
  if (overlaps.rows.length > 0) {
    // P20 / RA 10173: the double-entry panel sends DRM-IDs, dates and amounts to
    // the browser even while collapsed. Audit the disclosure — counts only.
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: staff.user_id,
      actor_type: "staff",
      action: "patient_sources.overlaps_viewed",
      resource_type: "report",
      metadata: { from: period.from, to: period.to, count: overlaps.rows.length, truncated: overlaps.truncated },
      ip_address: ip,
      user_agent: ua,
    });
  }
  const s = r.summary;
  const banner = sheetBanner(s);
  // "customers" is the latest REGISTRATION date, not a sync or upload time (0189
  // names it sheet_last_dates.customers); lab/consult are the latest service dates.
  const lastDates = Object.entries(s.sheet_last_dates ?? {}).filter(([, d]) => d);
  const serviceDates = lastDates.filter(([tab]) => tab !== "customers");
  const registrationDate = lastDates.find(([tab]) => tab === "customers")?.[1];
  const toggle = (patch: Record<string, string>, label: string, on: boolean) => (
    <Link
      key={label}
      href={periodHref(PATHNAME, params, patch)}
      className={
        "min-h-[36px] rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider " +
        (on ? "bg-[color:var(--color-brand-navy)] text-white" : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]")
      }
    >
      {label}
    </Link>
  );
  const peopleHref = (m: "new" | "returning" | "served", channel?: string) =>
    periodHref(`${PATHNAME}/people`, { from: period.from, to: period.to }, { mode: m, channel });
  const chart = chartData(r.series, grain);
  const table = channelTable(r.current, r.previous);
  const costs = spend.ok ? costPerNewPatient(spend.data.rows, r.new_by_day) : null;

  return (
    <div>
      {header}
      <PeriodControls pathname={PATHNAME} todayISO={todayISO} from={period.from} to={period.to}
        presetKey={period.presetKey} error={period.error} params={params} min={PATIENT_SOURCES_MIN_DATE} />
      <div className="mb-4 flex flex-wrap gap-2">
        {toggle({ mode: "new" }, MODE_LABEL.new, mode === "new")}
        {toggle({ mode: "served" }, MODE_LABEL.served, mode === "served")}
        <span className="mx-2" />
        {(["day", "week", "month"] as const).map((g) => toggle({ grain: g }, GRAIN_LABEL[g], grain === g))}
        <a className="ml-auto text-sm underline"
          href={periodHref("/api/admin/reports/patient-sources.csv", params, {})}>Download CSV</a>
      </div>

      {banner ? (
        <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{banner}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="New customers" href={peopleHref("new")}
          value={formatNewCounts(s.new_confirmed, s.new_unconfirmed)}
          hint="First visit recorded since Dec 2023 (or registration, if no visit yet)" />
        <StatCard label="Returning, first time in our records" href={peopleHref("returning")}
          value={s.returning_first_recorded.toLocaleString("en-PH")}
          hint="The sheet marks them as repeat customers" />
        <StatCard label="All customers served" href={peopleHref("served")}
          value={`${s.served_confirmed.toLocaleString("en-PH")} confirmed · ${s.served_unconfirmed.toLocaleString("en-PH")} unconfirmed`}
          hint="Everyone with a visit in the period, counted once" />
        <StatCard label="Source recorded"
          value={`${s.source_recorded.toLocaleString("en-PH")} of ${s.source_total.toLocaleString("en-PH")}`}
          hint="New customers whose channel is known" />
      </div>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        {s.undated_registrations.toLocaleString("en-PH")} people registered with no date and no recorded visit — not on any day.
        {serviceDates.length > 0
          ? ` Latest service date in the sheet: ${serviceDates.map(([tab, d]) => `${SHEET_TABS[tab] ?? tab} ${manilaDate(d as string)}`).join(" · ")}.`
          : ""}
        {registrationDate
          ? ` Latest registration date in the sheet: ${manilaDate(registrationDate as string)}.`
          : ""}
        {s.last_synced_at ? ` Last sync: ${manilaDateTime(s.last_synced_at)}.` : ""}
      </p>

      <section className="mt-6">
        <h2 className="mb-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          {MODE_LABEL[mode]} per {GRAIN_LABEL[grain].toLowerCase()}
        </h2>
        {chart.rows.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">Nobody in this period.</p>
        ) : (
          <ChannelChartLoader rows={chart.rows} channels={chart.channels} />
        )}
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Solid = confirmed patient records. Hatched = unconfirmed: a name in the reception sheet not yet matched to a patient record.
        </p>
      </section>

      <ChannelTableSection rows={table} modeLabel={MODE_LABEL[mode]}
        peopleHref={(channel) => peopleHref(mode === "served" ? "served" : "new", channel)} />
      <CostSection costs={costs} coverage={coverage.ok ? coverage.data : null} from={period.from} to={period.to} />
      <RevenueSection revenue={r.revenue} overlaps={overlaps} />
      <ReferrersSection rows={r.referrers} />

      <section className="mt-8 text-sm text-[color:var(--color-brand-text-soft)]">
        <h2 className="mb-1 font-bold text-[color:var(--color-brand-navy)]">How these numbers work</h2>
        <p>
          A new customer counts on their first visit recorded since December 2023, in the app or the reception sheet — or on
          the day they registered, if they have not visited yet. Counts can move when an earlier registration later gets its
          first recorded visit. Merged duplicate records count once; deleted records are left out.
        </p>
      </section>
    </div>
  );
}
