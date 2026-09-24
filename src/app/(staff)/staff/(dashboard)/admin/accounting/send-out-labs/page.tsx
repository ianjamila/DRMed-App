import Link from "next/link";
import { PageHeader } from "@/components/staff/page-header";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { buildPeriodPresets } from "@/lib/reports/period-presets";
import { PeriodPresets } from "./_components/period-presets";
import {
  buildSpendMatrix,
  buildSummary,
  enumerateMonths,
  fillMonthlyMargin,
  formatTurnaroundHours,
  marginPct,
  NOT_TAGGED_LABEL,
  sortTurnaroundRows,
  withinPromisePct,
  type MonthlyMarginRow,
  type SpendByLabRow,
  type TurnaroundRow,
} from "@/lib/reports/send-out-labs";

export const metadata = { title: ROUTE_NAME["/staff/admin/accounting/send-out-labs"] };
export const dynamic = "force-dynamic";

const BASE = "/staff/admin/accounting/send-out-labs";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const NUM = new Intl.NumberFormat("en-PH");

// No `Date` and no `Intl.DateTimeFormat` here on purpose — `month` is always
// the RPCs' own `YYYY-MM-01`, and building the label off its own digits keeps
// this file out of both date-render guards (see the guards' own notes).
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function monthLabel(monthIso: string): string {
  const [year, month] = monthIso.split("-");
  return `${MONTH_ABBR[Number(month) - 1] ?? month} ${year}`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string }>;
}

export default async function SendOutLabsPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  // Default: the last 12 months (first of the month 11 months back → today) —
  // the same window `buildPeriodPresets`' "12m" preset computes, reused here
  // rather than re-derived so the default and the matching pill can never
  // drift apart.
  const defaultPreset = buildPeriodPresets(todayISO).find((p) => p.key === "12m")!;
  const start = isISODate(sp.start) ? sp.start : defaultPreset.start;
  const endRaw = isISODate(sp.end) ? sp.end : defaultPreset.end;
  const end = endRaw < start ? start : endRaw;

  const supabase = await createClient();

  const [spendRes, marginRes, turnaroundRes] = await Promise.all([
    supabase.rpc("send_out_spend_by_lab", { p_start: start, p_end: end }),
    supabase.rpc("send_out_monthly_margin", { p_start: start, p_end: end }),
    supabase.rpc("send_out_turnaround_by_lab", { p_start: start, p_end: end }),
  ]);
  if (spendRes.error) throw new Error(spendRes.error.message);
  if (marginRes.error) throw new Error(marginRes.error.message);
  if (turnaroundRes.error) throw new Error(turnaroundRes.error.message);

  const spendRows: SpendByLabRow[] = spendRes.data ?? [];
  const marginRows: MonthlyMarginRow[] = marginRes.data ?? [];
  const turnaroundRows: TurnaroundRow[] = turnaroundRes.data ?? [];

  const months = enumerateMonths(start, end);
  const spendMatrix = buildSpendMatrix(spendRows, months);
  const marginByMonth = fillMonthlyMargin(marginRows, months);
  const summary = buildSummary(spendRows, marginRows);
  const turnaround = sortTurnaroundRows(turnaroundRows);

  const csvHref = `${BASE}/export?start=${start}&end=${end}`;

  return (
    <div className="space-y-6">
      <div className="mb-2">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <PageHeader
          eyebrow="Books & Reports"
          title={ROUTE_NAME["/staff/admin/accounting/send-out-labs"]}
          subtitle={
            <>
              Partner-lab spend, what send-out tests earned against it, and
              turnaround, for <strong>{start}</strong> → <strong>{end}</strong>.
            </>
          }
          actions={<ExportCsvLink href={csvHref} />}
        />
      </div>

      <PeriodPresets pathname={BASE} start={start} end={end} todayISO={todayISO} />

      <form
        action=""
        className="mb-2 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
      >
        <div className="flex flex-col">
          <label htmlFor="start" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Start date
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label htmlFor="end" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            End date
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayISO}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Recalculate
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* 1. Summary tiles                                                  */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <p className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
          The scoreboard for the period above — what went out to partner labs, what came back in from patients and HMOs for
          send-out tests, and the difference.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile label="Send Out spend" value={PHP.format(summary.totalSpendPhp)} hint="Paid to partner labs (GL 6420)" />
          <SummaryTile label="Send-out tests billed" value={NUM.format(summary.testsBilled)} hint="Released in this period" />
          <SummaryTile label="Billed amount" value={PHP.format(summary.billedPhp)} hint="Charged to patients/HMOs" />
          <SummaryTile
            label="Margin"
            value={PHP.format(summary.marginPhp)}
            hint="Billed − spend"
            tone={summary.marginPhp < 0 ? "warn" : "ok"}
          />
        </div>
        {summary.labShares.length > 0 ? (
          <div className="mt-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Share of spend by lab
            </p>
            <div className="space-y-2">
              {summary.labShares.map((s) => (
                <div key={s.vendorId ?? "not-tagged"} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-sm text-[color:var(--color-brand-text)]">{s.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[color:var(--color-brand-bg)]">
                    <div
                      className="h-full rounded-full bg-[color:var(--color-brand-cyan)]"
                      style={{ width: `${Math.min(100, s.sharePct)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs font-mono text-[color:var(--color-brand-text-soft)]">
                    {s.sharePct.toFixed(0)}%
                  </span>
                  <span className="w-28 shrink-0 text-right font-mono text-sm">{PHP.format(s.spendPhp)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. Spend by lab                                                   */}
      {/* ---------------------------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Spend by lab
          </h2>
          <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
            &quot;{NOT_TAGGED_LABEL}&quot; = older entries whose description doesn&apos;t name a lab; every new Send Out
            expense now asks which lab.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Month</th>
                {spendMatrix.columns.map((col) => (
                  <th key={col.key} className="px-4 py-3 text-right">{col.label}</th>
                ))}
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {spendMatrix.rows.map((row) => (
                <tr key={row.month} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 font-medium text-[color:var(--color-brand-navy)]">{monthLabel(row.month)}</td>
                  {spendMatrix.columns.map((col) => (
                    <td key={col.key} className="px-4 py-3 text-right font-mono">
                      {PHP.format(row.byLab[col.key] ?? 0)}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right font-mono font-semibold">{PHP.format(row.totalPhp)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-[color:var(--color-brand-bg)] font-semibold">
              <tr>
                <td className="px-4 py-3 text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">Total</td>
                {spendMatrix.columns.map((col) => (
                  <td key={col.key} className="px-4 py-3 text-right font-mono">{PHP.format(spendMatrix.totals.byLab[col.key] ?? 0)}</td>
                ))}
                <td className="px-4 py-3 text-right font-mono">{PHP.format(spendMatrix.totals.totalPhp)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 3. Send-out profit by month                                       */}
      {/* ---------------------------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Send-out profit by month
          </h2>
          <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
            Billed = what patients/HMOs were charged for released send-out tests (package components carry ₱0). Spend = the
            Send Out expense for the month, so a month where the lab was paid late can swing.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Month</th>
                <th className="px-4 py-3 text-right">Tests</th>
                <th className="px-4 py-3 text-right">Billed</th>
                <th className="px-4 py-3 text-right">Send Out spend</th>
                <th className="px-4 py-3 text-right">Margin</th>
                <th className="px-4 py-3 text-right">Margin %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {marginByMonth.map((row) => (
                <tr key={row.month} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 font-medium text-[color:var(--color-brand-navy)]">{monthLabel(row.month)}</td>
                  <td className="px-4 py-3 text-right font-mono">{NUM.format(row.tests)}</td>
                  <td className="px-4 py-3 text-right font-mono">{PHP.format(row.revenue_php)}</td>
                  <td className="px-4 py-3 text-right font-mono">{PHP.format(row.spend_php)}</td>
                  <td className={`px-4 py-3 text-right font-mono ${row.margin_php < 0 ? "text-red-700" : ""}`}>
                    {PHP.format(row.margin_php)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                    {pct(marginPct(row.revenue_php, row.margin_php))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 4. Turnaround by lab                                              */}
      {/* ---------------------------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Turnaround by lab
          </h2>
          <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
            Request-to-release time for send-out tests handled in the app. &quot;% within promised turnaround&quot; compares
            against each service&apos;s expected turnaround, where one is set.
          </p>
        </div>
        {turnaround.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No turnaround data for this period. Imported history is excluded here — it was recorded with the same request and
            release time, so this fills in as send-out tests are requested and released in the app.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Lab</th>
                  <th className="px-4 py-3 text-right">Tests</th>
                  <th className="px-4 py-3 text-right">Median</th>
                  <th className="px-4 py-3 text-right">90th percentile</th>
                  <th className="px-4 py-3 text-right">Average</th>
                  <th className="px-4 py-3 text-right">% within promised turnaround</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {turnaround.map((row) => (
                  <tr key={row.vendor_id ?? row.lab_name} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3 font-medium text-[color:var(--color-brand-navy)]">{row.lab_name}</td>
                    <td className="px-4 py-3 text-right font-mono">{NUM.format(row.tests)}</td>
                    <td className="px-4 py-3 text-right font-mono">{formatTurnaroundHours(row.median_hours)}</td>
                    <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                      {formatTurnaroundHours(row.p90_hours)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                      {formatTurnaroundHours(row.avg_hours)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {withinPromisePct(row.with_promise, row.within_promise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  const accent = tone === "warn" ? "before:bg-amber-400" : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">{label}</p>
      <p className="mt-2 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{hint}</p> : null}
    </article>
  );
}
