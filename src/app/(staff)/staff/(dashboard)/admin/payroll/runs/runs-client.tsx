"use client";

import { useCallback, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { formatPhp } from "@/lib/marketing/format";

export interface RunListRow {
  id: string;
  status: string; // 'draft' | 'computed' | 'finalised' | 'voided'
  created_at: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  sum_gross_php: number;
  sum_net_php: number;
  count_total: number;
  count_paid: number;
}

interface Props {
  runs: RunListRow[];
  years: number[];
  currentYear: number;
  currentStatus: "all" | "draft" | "computed" | "finalised" | "voided";
  error?: string | null;
}

const PERIOD_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
});
const YEAR_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
});
const DATE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatPeriodRange(startISO: string, endISO: string): string {
  if (!startISO || !endISO) return "—";
  const start = new Date(`${startISO}T00:00:00+08:00`);
  const end = new Date(`${endISO}T00:00:00+08:00`);
  return `${PERIOD_FMT.format(start)} – ${PERIOD_FMT.format(end)}, ${YEAR_FMT.format(end)}`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  return DATE_FMT.format(new Date(`${iso}T00:00:00+08:00`));
}

export function RunsClient({
  runs,
  years,
  currentYear,
  currentStatus,
  error,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      if (value === "all" && key === "status") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      const qs = next.toString();
      const target = qs ? `?${qs}` : "";
      startTransition(() => {
        router.replace(`/staff/admin/payroll/runs${target}`);
      });
    },
    [router, searchParams],
  );

  const openRun = useCallback(
    (id: string) => router.push(`/staff/admin/payroll/runs/${id}`),
    [router],
  );

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Year
          <select
            value={String(currentYear)}
            onChange={(e) => updateParam("year", e.target.value)}
            disabled={isPending}
            className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2.5 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Status
          <select
            value={currentStatus}
            onChange={(e) => updateParam("status", e.target.value)}
            disabled={isPending}
            className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2.5 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="computed">Computed</option>
            <option value="finalised">Finalised</option>
            <option value="voided">Voided</option>
          </select>
        </label>
        <p className="hidden text-xs text-[color:var(--color-brand-text-soft)] sm:block">
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </p>
        <Link
          href="/staff/admin/payroll/periods"
          className="ml-auto min-h-[44px] inline-flex items-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
        >
          Manage periods -{">"}
        </Link>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Period</th>
              <th className="px-4 py-3">Pay date</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Σ Gross</th>
              <th className="px-4 py-3 text-right">Σ Net</th>
              <th className="px-4 py-3 text-right">Paid / Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {runs.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  <div>No pay runs in {currentYear}.</div>
                  <Link
                    href="/staff/admin/payroll/periods"
                    className="mt-2 inline-block font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                  >
                    Create a period first -{">"}
                  </Link>
                </td>
              </tr>
            ) : (
              runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openRun(r.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openRun(r.id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open run for ${formatPeriodRange(r.period_start, r.period_end)}`}
                  className="cursor-pointer hover:bg-[color:var(--color-brand-bg)]/40 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)] focus:ring-inset"
                >
                  <td className="px-4 py-3 align-middle font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPeriodRange(r.period_start, r.period_end)}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {formatDate(r.pay_date)}
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <RunStatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPhp(r.sum_gross_php)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPhp(r.sum_net_php)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle text-xs">
                    <span className="font-semibold text-[color:var(--color-brand-navy)]">
                      {r.count_paid}
                    </span>{" "}
                    / {r.count_total}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards */}
      <div className="space-y-3 md:hidden">
        {runs.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No pay runs in {currentYear}.{" "}
            <Link
              href="/staff/admin/payroll/periods"
              className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Create a period first -{">"}
            </Link>
          </p>
        ) : (
          runs.map((r) => (
            <Link
              key={r.id}
              href={`/staff/admin/payroll/runs/${r.id}`}
              className="block min-h-[44px] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm hover:border-[color:var(--color-brand-cyan)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPeriodRange(r.period_start, r.period_end)}
                  </div>
                  <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                    Pay date: {formatDate(r.pay_date)}
                  </div>
                </div>
                <RunStatusPill status={r.status} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Σ Gross
                </dt>
                <dd className="text-right font-semibold text-[color:var(--color-brand-navy)]">
                  {formatPhp(r.sum_gross_php)}
                </dd>
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Σ Net
                </dt>
                <dd className="text-right font-semibold text-[color:var(--color-brand-navy)]">
                  {formatPhp(r.sum_net_php)}
                </dd>
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Paid / Total
                </dt>
                <dd className="text-right">
                  <span className="font-semibold text-[color:var(--color-brand-navy)]">
                    {r.count_paid}
                  </span>{" "}
                  / {r.count_total}
                </dd>
              </dl>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

function RunStatusPill({ status }: { status: string }) {
  // Colors per the task spec: draft=gray, computed=amber, finalised=green, voided=red.
  let cls = "bg-slate-200 text-slate-700";
  if (status === "draft") cls = "bg-slate-200 text-slate-700";
  else if (status === "computed") cls = "bg-amber-100 text-amber-900";
  else if (status === "finalised") cls = "bg-emerald-100 text-emerald-900";
  else if (status === "voided") cls = "bg-rose-100 text-rose-900";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}
