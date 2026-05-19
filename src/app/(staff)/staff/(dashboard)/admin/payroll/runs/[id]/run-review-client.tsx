"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatPhp } from "@/lib/marketing/format";
import { formatPeriodRange, formatManilaDate } from "@/lib/payroll/format";
import { PAYMENT_LABEL } from "@/lib/payroll/labels";

// =============================================================================
// Prop shapes (mirror page.tsx)
// =============================================================================

export interface EarningLineRow {
  id: string;
  kind: string;
  label: string;
  amount_php: number;
  created_by: string | null;
  created_at: string;
}

export interface DeductionLineRow {
  id: string;
  kind: string;
  label: string;
  amount_php: number;
  loan_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface EmployeeRunRow {
  id: string;
  run_id: string;
  employee_id: string;
  full_name: string;
  employee_number: string | null;
  schedule_kind: string;
  payment_method: "cash" | "bank";
  scheduled_days: number;
  days_present: number;
  days_vl_used: number;
  days_sl_used: number;
  days_unpaid_absent: number;
  basic_pay_php: number;
  allowances_total_php: number;
  ot_pay_php: number;
  night_diff_pay_php: number;
  holiday_pay_php: number;
  incentives_total_php: number;
  perfect_attendance_bonus_php: number;
  thirteenth_month_payout_php: number;
  gross_pay_php: number;
  sss_ee_php: number;
  philhealth_ee_php: number;
  pagibig_ee_php: number;
  wt_compensation_php: number;
  tardiness_deduction_php: number;
  staff_advance_settlement_php: number;
  other_deductions_total_php: number;
  net_pay_php: number;
  payout_status: string;
  payment_method_used: string | null;
  paid_at: string | null;
  ot_overage_unpaid_minutes_total: number;
  minutes_late_total: number;
  tardiness_count: number;
  missing_punch_days: number;
  earnings: EarningLineRow[];
  deductions: DeductionLineRow[];
}

export interface RunHeader {
  id: string;
  period_id: string;
  status: string; // draft | computed | finalised | voided
  computed_at: string | null;
  finalised_at: string | null;
  finalised_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  period_start: string;
  period_end: string;
  pay_date: string;
  period_status: string;
  finaliser_name: string | null;
  dtr_imported: boolean;
  sum_gross_php: number;
  sum_net_php: number;
  sum_statutory_and_wt_php: number;
  employee_count: number;
  paid_count: number;
}

interface Props {
  run: RunHeader;
  employeeRuns: EmployeeRunRow[];
}

// =============================================================================
// Status pill
// =============================================================================

const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  computed: "Computed",
  finalised: "Finalised",
  voided: "Voided",
};

const RUN_STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-200 text-slate-700",
  computed: "bg-amber-100 text-amber-900",
  finalised: "bg-emerald-100 text-emerald-900",
  voided: "bg-rose-100 text-rose-900",
};

function RunStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        RUN_STATUS_BADGE[status] ?? "bg-slate-200 text-slate-700"
      }`}
    >
      {RUN_STATUS_LABEL[status] ?? status}
    </span>
  );
}

// =============================================================================
// Year extractor (for the page title)
// =============================================================================

function periodYearLabel(endISO: string): string {
  if (!endISO) return "";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
  }).format(new Date(`${endISO}T00:00:00+08:00`));
}

// =============================================================================
// useLocalStorage — tiny inline hook (no shared util exists yet)
// =============================================================================

type DrawerStyle = "inline" | "slide-out";

function useDrawerStylePreference(): [DrawerStyle, (next: DrawerStyle) => void] {
  const [style, setStyle] = useState<DrawerStyle>("inline");

  // Read from localStorage on mount only — avoid SSR/CSR hydration mismatch.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("payroll-run-drawer-style");
      if (raw === "inline" || raw === "slide-out") {
        setStyle(raw);
      }
    } catch {
      // Ignore — Storage may be blocked in private windows.
    }
  }, []);

  const update = (next: DrawerStyle) => {
    setStyle(next);
    try {
      window.localStorage.setItem("payroll-run-drawer-style", next);
    } catch {
      // Ignore.
    }
  };

  return [style, update];
}

// =============================================================================
// Top-level component
// =============================================================================

export function RunReviewClient({ run, employeeRuns }: Props) {
  const [selectedEmployeeRunId, setSelectedEmployeeRunId] = useState<
    string | null
  >(null);
  const [drawerStylePref, setDrawerStylePref] = useDrawerStylePreference();

  // Detect mobile viewport to force slide-out style. Tailwind's md breakpoint
  // is 768px; match that here so the toggle's effective state matches the
  // table layout below.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = () => setIsMobile(mq.matches);
    handler();
    // Older Safari uses addListener / removeListener; modern browsers use
    // addEventListener. Both are supported by MediaQueryList.
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  const effectiveDrawerStyle: DrawerStyle = isMobile
    ? "slide-out"
    : drawerStylePref;

  const selected = useMemo(
    () =>
      selectedEmployeeRunId == null
        ? null
        : employeeRuns.find((er) => er.id === selectedEmployeeRunId) ?? null,
    [employeeRuns, selectedEmployeeRunId],
  );

  const otOverageEmployees = useMemo(
    () => employeeRuns.filter((er) => er.ot_overage_unpaid_minutes_total > 0),
    [employeeRuns],
  );

  const periodYear = periodYearLabel(run.period_end);
  const finaliserLabel = run.finaliser_name ?? "Not finalised yet";

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
        <Link
          href="/staff/admin/payroll/runs"
          className="hover:text-[color:var(--color-brand-navy)]"
        >
          ← Pay runs
        </Link>
      </p>

      {/* Header card */}
      <header className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)] sm:text-3xl">
              Pay run · {formatPeriodRange(run.period_start, run.period_end)}
              {periodYear ? null : null}
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
              Pay date {formatManilaDate(run.pay_date)} · {finaliserLabel} ·{" "}
              {run.employee_count}{" "}
              {run.employee_count === 1 ? "employee" : "employees"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RunStatusPill status={run.status} />
            {/* Right-side action slot kept empty intentionally — finalise / void /
                mark-paid / re-import controls land in the next batch (T61/T62). */}
          </div>
        </div>
      </header>

      {/* KPI strip */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiBox label="Σ Gross" value={formatPhp(run.sum_gross_php)} />
        <KpiBox
          label="Σ Statutory + WT"
          value={formatPhp(run.sum_statutory_and_wt_php)}
        />
        <KpiBox label="Σ Net" value={formatPhp(run.sum_net_php)} emphasis />
        <KpiBox
          label="Paid / Total"
          value={`${run.paid_count} / ${run.employee_count}`}
        />
      </section>

      {/* Banners */}
      <div className="mb-6 space-y-3">
        {otOverageEmployees.length > 0 ? (
          <Banner tone="amber" title="OT overage detected">
            <p className="text-sm text-amber-900">
              {otOverageEmployees.length}{" "}
              {otOverageEmployees.length === 1 ? "employee has" : "employees have"}{" "}
              OT time outside any approved slip — total{" "}
              {otOverageEmployees.reduce(
                (sum, er) => sum + er.ot_overage_unpaid_minutes_total,
                0,
              )}{" "}
              minutes. These are NOT paid until you create OT slips:
            </p>
            <ul className="mt-2 list-inside list-disc text-sm text-amber-900">
              {otOverageEmployees.map((er) => (
                <li key={er.id}>
                  {er.full_name} — {er.ot_overage_unpaid_minutes_total} min
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              <Link
                href="/staff/admin/payroll/ot-slips"
                className="font-semibold text-amber-900 underline hover:text-amber-700"
              >
                Create OT slips →
              </Link>
            </p>
          </Banner>
        ) : null}

        {!run.dtr_imported && run.status === "draft" ? (
          <Banner tone="amber" title="No DTR imported yet">
            <p className="text-sm text-amber-900">
              Upload the DTR for this period to compute attendance, OT, and
              tardiness.
            </p>
            <p className="mt-2 text-sm">
              <Link
                href={`/staff/admin/payroll/runs/${run.id}/dtr`}
                className="font-semibold text-amber-900 underline hover:text-amber-700"
              >
                Import DTR →
              </Link>
            </p>
          </Banner>
        ) : null}
      </div>

      {/* Per-employee table */}
      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--color-brand-bg-mid)] px-4 py-3 sm:px-5">
          <h2 className="font-[family-name:var(--font-heading)] text-base font-extrabold text-[color:var(--color-brand-navy)]">
            Per-employee summary
          </h2>
          {/* The mobile viewport always uses slide-out (more usable on narrow
              screens), so we hide the toggle there entirely. */}
          {!isMobile ? (
            <DrawerStyleToggle
              value={drawerStylePref}
              onChange={setDrawerStylePref}
            />
          ) : null}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3 text-right">Days</th>
                  <th className="px-4 py-3 text-right">Gross</th>
                  <th className="px-4 py-3 text-right">Net</th>
                  <th className="px-4 py-3">Pay method</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {employeeRuns.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                    >
                      No employees on this run.
                    </td>
                  </tr>
                ) : null}
                {employeeRuns.map((er) => {
                  const isSelected = selectedEmployeeRunId === er.id;
                  return (
                    <RunRowDesktop
                      key={er.id}
                      er={er}
                      isSelected={isSelected}
                      isInlineSelected={
                        isSelected && effectiveDrawerStyle === "inline"
                      }
                      onSelect={() =>
                        setSelectedEmployeeRunId((cur) =>
                          cur === er.id ? null : er.id,
                        )
                      }
                      inlineDrawer={
                        isSelected && effectiveDrawerStyle === "inline" ? (
                          // Drawer body lands in T60 — placeholder for now so
                          // the inline row reserves visual space.
                          <DrawerPlaceholder
                            employeeName={er.full_name}
                            onClose={() => setSelectedEmployeeRunId(null)}
                          />
                        ) : null
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile stacked cards */}
        <div className="space-y-3 px-3 py-3 md:hidden">
          {employeeRuns.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] px-3 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
              No employees on this run.
            </p>
          ) : null}
          {employeeRuns.map((er) => (
            <button
              key={er.id}
              type="button"
              onClick={() => setSelectedEmployeeRunId(er.id)}
              className="block w-full min-h-[44px] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-left shadow-sm hover:border-[color:var(--color-brand-cyan)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-[color:var(--color-brand-navy)]">
                    {er.full_name}
                  </p>
                  {er.employee_number ? (
                    <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                      #{er.employee_number}
                    </p>
                  ) : null}
                </div>
                <PayMethodPill method={er.payment_method} />
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-[color:var(--color-brand-text-soft)]">
                    Days
                  </dt>
                  <dd className="font-semibold text-[color:var(--color-brand-navy)]">
                    {er.days_present}
                    {er.scheduled_days > 0
                      ? ` / ${er.scheduled_days}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-[color:var(--color-brand-text-soft)]">
                    Gross
                  </dt>
                  <dd className="font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPhp(er.gross_pay_php)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[color:var(--color-brand-text-soft)]">
                    Net
                  </dt>
                  <dd className="font-bold text-[color:var(--color-brand-navy)]">
                    {formatPhp(er.net_pay_php)}
                  </dd>
                </div>
              </dl>
            </button>
          ))}
        </div>
      </section>

      {/* Slide-out drawer body lands in T60 — for now, use a placeholder so
          the selection state still has a visible affordance. */}
      {selected && effectiveDrawerStyle === "slide-out" ? (
        <SlideOutPlaceholder
          employeeName={selected.full_name}
          onClose={() => setSelectedEmployeeRunId(null)}
        />
      ) : null}
    </div>
  );
}

// =============================================================================
// Drawer placeholders (T59 only — replaced by EarningDeductionDrawer in T60)
// =============================================================================

function DrawerPlaceholder({
  employeeName,
  onClose,
}: {
  employeeName: string;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {employeeName} — earnings &amp; deductions
        </p>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
        >
          Close
        </button>
      </div>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Line CRUD lands in the next batch (T60).
      </p>
    </div>
  );
}

function SlideOutPlaceholder({
  employeeName,
  onClose,
}: {
  employeeName: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Lines for ${employeeName}`}
        className="absolute right-0 top-0 flex h-full w-full flex-col bg-white shadow-2xl sm:max-w-[560px]"
      >
        <div className="flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <h3 className="font-[family-name:var(--font-heading)] text-base font-extrabold text-[color:var(--color-brand-navy)]">
            {employeeName}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] rounded-md text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-[color:var(--color-brand-text-soft)]">
          Line CRUD lands in the next batch (T60).
        </div>
      </aside>
    </div>
  );
}

// =============================================================================
// KPI box
// =============================================================================

function KpiBox({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-4">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-2 font-[family-name:var(--font-heading)] text-[color:var(--color-brand-navy)] ${
          emphasis ? "text-2xl font-extrabold" : "text-xl font-bold"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// =============================================================================
// Banner
// =============================================================================

function Banner({
  tone,
  title,
  children,
}: {
  tone: "amber";
  title: string;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50";
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="font-[family-name:var(--font-heading)] text-sm font-extrabold text-amber-900">
        {title}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// =============================================================================
// Pay-method pill
// =============================================================================

function PayMethodPill({ method }: { method: "cash" | "bank" }) {
  const cls =
    method === "cash"
      ? "bg-amber-100 text-amber-900"
      : "bg-sky-100 text-sky-900";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {PAYMENT_LABEL[method] ?? method}
    </span>
  );
}

// =============================================================================
// Per-row (desktop)
// =============================================================================

function RunRowDesktop({
  er,
  isSelected,
  isInlineSelected,
  onSelect,
  inlineDrawer,
}: {
  er: EmployeeRunRow;
  isSelected: boolean;
  isInlineSelected: boolean;
  onSelect: () => void;
  inlineDrawer: React.ReactNode;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <>
      <tr
        tabIndex={0}
        role="button"
        aria-pressed={isSelected}
        aria-label={`Edit lines for ${er.full_name}`}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className={`cursor-pointer transition ${
          isSelected
            ? "bg-[color:var(--color-brand-cyan)]/10"
            : "hover:bg-[color:var(--color-brand-bg)]/40"
        } focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[color:var(--color-brand-cyan)]`}
      >
        <td className="px-4 py-3">
          <p className="font-semibold text-[color:var(--color-brand-navy)]">
            {er.full_name}
          </p>
          {er.employee_number ? (
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              #{er.employee_number}
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {er.days_present}
          {er.scheduled_days > 0 ? ` / ${er.scheduled_days}` : ""}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatPhp(er.gross_pay_php)}
        </td>
        <td className="px-4 py-3 text-right font-bold tabular-nums text-[color:var(--color-brand-navy)]">
          {formatPhp(er.net_pay_php)}
        </td>
        <td className="px-4 py-3">
          <PayMethodPill method={er.payment_method} />
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          >
            {isSelected ? "Close" : "Edit lines"}
          </button>
        </td>
      </tr>
      {isInlineSelected ? (
        <tr className="bg-[color:var(--color-brand-bg)]/60">
          <td colSpan={6} className="px-4 py-4">
            {inlineDrawer}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// =============================================================================
// Drawer-style toggle
// =============================================================================

function DrawerStyleToggle({
  value,
  onChange,
}: {
  value: DrawerStyle;
  onChange: (next: DrawerStyle) => void;
}) {
  const items: { key: DrawerStyle; label: string }[] = [
    { key: "inline", label: "Inline" },
    { key: "slide-out", label: "Slide-out" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white">
      {items.map((i) => {
        const active = i.key === value;
        return (
          <button
            key={i.key}
            type="button"
            onClick={() => onChange(i.key)}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-bold transition ${
              active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]"
            }`}
            aria-pressed={active}
          >
            {i.label}
          </button>
        );
      })}
    </div>
  );
}
