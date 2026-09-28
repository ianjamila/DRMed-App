import { PageHeader } from "@/components/staff/page-header";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { manilaDate } from "@/lib/dates/manila";
import { serviceKindLabel } from "@/lib/services/kind-labels";
import { dailyRevenueCsvHref, loadDailyRevenue, parseDailyRevenueParams } from "@/lib/reports/daily-revenue";
import { createClient } from "@/lib/supabase/server";
import { RevenueByClass } from "@/components/staff/revenue-by-class";
import { todayManilaISODate } from "@/lib/dates/manila";
import { priorYearRange } from "@/lib/reports/period-presets";
import { summariseClasses, summaryTotals, type VisitClass } from "@/lib/visits/classification";
import { buildRevenuePresets, matchRevenuePreset } from "@/lib/visits/revenue-presets";

export const metadata = { title: ROUTE_NAME["/staff/admin/operations/daily-revenue"] };
export const dynamic = "force-dynamic";

interface SearchParams { from?: string; to?: string; rev?: string }

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export default async function DailyRevenuePage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  await requireAdminStaff();
  const raw = await searchParams;
  const params = parseDailyRevenueParams(raw);
  const { from, to } = params;
  // Keeps the revenue dropdown open across a click on one of its own range
  // buttons (which reloads the page); every other arrival starts it closed.
  const revenueOpen = raw.rev === "1";

  const admin = createAdminClient();
  const supabase = await createClient();
  const prior = priorYearRange(from, to);
  // Same ceiling as the export so page and CSV can never disagree; the page
  // says so when it bites.
  const [{ byDate, truncated }, summaryRes, priorRes] = await Promise.all([
    loadDailyRevenue(admin, params, REPORT_EXPORT_MAX_ROWS),
    // The Visit Records breakdown over this page's dates — through the
    // RLS-scoped client, as on Visit Records itself.
    supabase.rpc("visits_classification_summary", { p_start: from, p_end: to, p_deleted: "active" }),
    supabase.rpc("visits_classification_summary", {
      p_start: prior.start,
      p_end: prior.end,
      p_deleted: "active",
    }),
  ]);
  const summary = summariseClasses(summaryRes.data);
  const priorSummary = priorRes.error ? null : summariseClasses(priorRes.data);
  // "All dates" is left out: this page always has a range, and an unbounded
  // one would walk every release ever made.
  const presets = buildRevenuePresets(todayManilaISODate()).filter((p) => p.key !== "all");
  const activePreset = matchRevenuePreset(presets, from, to);
  const rangeHref = (start: string, end: string, kind?: VisitClass) => {
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    qs.set("start", start);
    qs.set("end", end);
    qs.set("rev", "1");
    return `/staff/visits?${qs}`;
  };

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <PageHeader
          eyebrow={SECTION_NAME["/staff/admin/operations"]}
          title={ROUTE_NAME["/staff/admin/operations/daily-revenue"]}
        />
        <form key={`${from}_${to}`} className="mt-3 flex flex-wrap items-end gap-2 text-sm" method="get">
          <label>From <input type="date" name="from" defaultValue={from} className="rounded border px-2 py-1" /></label>
          <label>To <input type="date" name="to" defaultValue={to} className="rounded border px-2 py-1" /></label>
          <button type="submit" className="min-h-[44px] rounded border px-3 py-1">Apply</button>
          <ExportCsvLink href={dailyRevenueCsvHref(params)} />
        </form>
      </div>

      <RevenueByClass
        rows={summary}
        totals={summaryTotals(summary)}
        rangeLabel={[activePreset?.label, `${manilaDate(from)} → ${manilaDate(to)}`]
          .filter(Boolean)
          .join(" · ")}
        open={revenueOpen}
        error={Boolean(summaryRes.error)}
        presets={presets}
        activePreset={activePreset?.key}
        presetHref={(p) => `?from=${p.start}&to=${p.end}&rev=1`}
        cardHref={(c) => rangeHref(from, to, c)}
        visitsHref={rangeHref(from, to)}
        prior={priorSummary ? { rows: priorSummary, totals: summaryTotals(priorSummary) } : null}
        pnlHref={`/staff/admin/operations/expenses?from=${from}&to=${to}`}
        notes={
          <p className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
            Billed lines by <b>visit date</b>, as on Visit Records. The days below
            count <b>released</b> lines by release date, so the two totals can differ.
          </p>
        }
      />

      {truncated ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} service-days — narrow the range.
        </p>
      ) : null}

      {[...byDate.entries()].map(([date, list]) => {
        const total = list.reduce((s, r) => s + Number(r.revenue_php ?? 0), 0);
        return (
          <section key={date} className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
            <header className="mb-2 flex justify-between">
              <strong className="text-[color:var(--color-brand-navy)]">{manilaDate(date)}</strong>
              <span className="font-mono font-semibold">{PESO(total)}</span>
            </header>
            <ul className="text-sm">
              {list.map((r) => (
                <li key={r.service_code} className="flex justify-between border-t py-1">
                  <span><code className="mr-2">{r.service_code}</code>{r.service_name} <span className="text-[color:var(--color-brand-text-soft)]">({serviceKindLabel(r.service_kind)} · {r.released_count ?? 0} {r.released_count === 1 ? "release" : "releases"})</span></span>
                  <span className="font-mono">{PESO(Number(r.revenue_php ?? 0))}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {byDate.size === 0 && <p className="text-sm text-[color:var(--color-brand-text-soft)]">No released revenue in this range.</p>}
    </div>
  );
}
