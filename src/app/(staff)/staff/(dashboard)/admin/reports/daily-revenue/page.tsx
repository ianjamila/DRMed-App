import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { dailyRevenueCsvHref, loadDailyRevenue, parseDailyRevenueParams } from "@/lib/reports/daily-revenue";

export const metadata = { title: "Daily revenue — staff" };
export const dynamic = "force-dynamic";

interface SearchParams { from?: string; to?: string }

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export default async function DailyRevenuePage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  await requireAdminStaff();
  const params = parseDailyRevenueParams(await searchParams);
  const { from, to } = params;

  const admin = createAdminClient();
  // Same ceiling as the export so page and CSV can never disagree; the page
  // says so when it bites.
  const { byDate, truncated } = await loadDailyRevenue(admin, params, REPORT_EXPORT_MAX_ROWS);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">Phase 12.C · Admin · Reports</p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">Daily revenue</h1>
        <form className="mt-3 flex flex-wrap items-end gap-2 text-sm" method="get">
          <label>From <input type="date" name="from" defaultValue={from} className="rounded border px-2 py-1" /></label>
          <label>To <input type="date" name="to" defaultValue={to} className="rounded border px-2 py-1" /></label>
          <button type="submit" className="min-h-[44px] rounded border px-3 py-1">Apply</button>
          <ExportCsvLink href={dailyRevenueCsvHref(params)} />
        </form>
      </header>

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
              <strong className="text-[color:var(--color-brand-navy)]">{date}</strong>
              <span className="font-mono font-semibold">{PESO(total)}</span>
            </header>
            <ul className="text-sm">
              {list.map((r) => (
                <li key={r.service_code} className="flex justify-between border-t py-1">
                  <span><code className="mr-2">{r.service_code}</code>{r.service_name} <span className="text-[color:var(--color-brand-text-soft)]">({r.service_kind} · {r.released_count} releases)</span></span>
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
