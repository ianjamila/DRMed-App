import Link from "next/link";
import { asOfLabel, trendCardData, type ReportResult } from "@/lib/marketing/patient-sources";
import type { PatientSourcesTrend } from "@/lib/marketing/patient-sources.server";
import { StatCard } from "./stat-card";
import { PatientSourcesTrendChartLoader } from "./patient-sources-trend-chart-loader";

const LABEL = "New patients — last 8 weeks";

export function PatientSourcesTrendCard({ trend }: { trend: ReportResult<PatientSourcesTrend> }) {
  if (!trend.ok) return <StatCard label={LABEL} value={0} error />;
  const { weeks, newByDay, spend, readAt } = trend.data;
  const t = trendCardData(newByDay, spend.ok ? spend.rows : [], weeks);
  const href = `/staff/marketing/patients?from=${weeks[0].from}&to=${weeks[weeks.length - 1].to}&grain=week&mode=new`;
  const change = t.pct === null ? "(none the week before)" : `${t.pct > 0 ? "▲" : t.pct < 0 ? "▼" : "="} ${Math.abs(t.pct)}% vs the week before`;
  return (
    <section className="relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-[color:var(--color-brand-cyan)] sm:col-span-2">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">{LABEL}</p>
      <p className="mt-2 font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Last week {t.lastWeek.toLocaleString("en-PH")} <span className="text-sm font-bold">{change}</span>
      </p>
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">This week so far: {t.thisWeekSoFar.toLocaleString("en-PH")}</p>
      <div role="img" aria-label={t.ariaLabel} className="mt-3">
        <PatientSourcesTrendChartLoader rows={t.chart.rows} channels={t.chart.channels} hasSpend={t.hasSpend} />
      </div>
      <table className="sr-only">
        <caption>New patients per week by channel</caption>
        <thead><tr><th>Week</th>{t.chart.channels.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {t.chart.rows.map((r) => (
            <tr key={r.bucket}>
              <td>{r.label}</td>
              {t.chart.channels.map((c) => <td key={c.key}>{Number(r[`${c.key}__c`]) + Number(r[`${c.key}__u`])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {!spend.ok ? (
        <p className="mt-2 text-xs text-amber-800">Couldn&apos;t load ad spend — cost per new patient is not shown.</p>
      ) : !t.hasSpend ? (
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Cost per new patient appears once ad spend is saved (Ad Performance → Save them to clinic records).
        </p>
      ) : null}
      <p className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-[color:var(--color-brand-text-soft)]">
        <span>{asOfLabel(new Date(readAt))}</span>
        <Link href={href} className="font-bold text-[color:var(--color-brand-navy)] underline">Open Patient Sources →</Link>
      </p>
    </section>
  );
}
