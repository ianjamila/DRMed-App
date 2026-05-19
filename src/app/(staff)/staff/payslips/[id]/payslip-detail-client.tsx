"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import type { PayslipData } from "@/lib/payroll/payslip-pdf";
import { getPayslipUrlAction } from "../actions";

type Props = {
  data: PayslipData;
  employeeRunId: string;
  hasFile: boolean;
};

// Peso formatter — fixed .00 decimals, matching the PDF (and the payslip-
// peso formatter inside payslip-pdf.ts).
const PESO_FMT = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function formatPeso(amount: number): string {
  return `₱${PESO_FMT.format(amount)}`;
}

// Manila-zone date helpers — local copies (the lib/payroll/format helpers
// are server-only-friendly but pulling them in here would also work; we
// re-implement to avoid widening the client bundle's server deps).
function formatManilaDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00+08:00`);
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function formatPeriodRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00+08:00`);
  const e = new Date(`${end}T00:00:00+08:00`);
  const range = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
  });
  const year = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
  });
  return `${range.format(s)} – ${range.format(e)}, ${year.format(e)}`;
}

export function PayslipDetailClient({
  data,
  employeeRunId,
  hasFile,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDownload() {
    setError(null);
    startTransition(async () => {
      const res = await getPayslipUrlAction(employeeRunId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      window.open(res.data.url, "_blank", "noopener,noreferrer");
    });
  }

  const methodUsed =
    data.run.payment_method_used ?? data.employee.payment_method;
  const methodLabel = methodUsed === "bank" ? "Bank transfer" : "Cash";

  // Total deductions: gross − net. Same identity used in the PDF's net-pay
  // band — guarantees the helper line reconciles regardless of how
  // individual deduction rows land.
  const totalDeductions = data.run.gross_pay_php - data.run.net_pay_php;

  // Loan + manual deduction sub-lists (matches the PDF's grouping).
  const loanLines = data.deductionLines.filter(
    (l) => l.kind === "loan_amortization",
  );
  const manualLines = data.deductionLines.filter(
    (l) => l.kind === "manual_adjustment" || l.kind === "other",
  );

  return (
    <div className="min-h-dvh bg-[color:var(--color-brand-bg)]">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {/* Top bar — back link + download button */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/staff/payslips"
            className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[color:var(--color-brand-text-soft)] transition hover:bg-white hover:text-[color:var(--color-brand-navy)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to payslips
          </Link>
          {hasFile ? (
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                onClick={handleDownload}
                disabled={pending}
                className="inline-flex h-11 min-w-[44px] items-center gap-2 rounded-full bg-[color:var(--color-brand-navy)] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[color:var(--color-brand-steel)] disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Download PDF
              </button>
              {error ? (
                <span className="max-w-[14rem] text-right text-xs text-red-700">
                  {error}
                </span>
              ) : null}
            </div>
          ) : (
            <span
              className="inline-flex h-11 items-center rounded-full bg-white px-3 text-xs font-semibold text-[color:var(--color-brand-text-soft)] shadow-sm"
              title="PDF not generated yet — contact admin"
            >
              PDF not generated yet. Contact admin.
            </span>
          )}
        </div>

        {/* Letterhead */}
        <section className="mt-5 rounded-2xl bg-white p-5 shadow-sm sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-[family-name:var(--font-heading)] text-base font-extrabold leading-tight text-[color:var(--color-brand-navy)] sm:text-lg">
                DRM Medical Diagnostics &amp; Wellness Center
              </p>
              <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
                drmed.ph
              </p>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                Mandaluyong City, Metro Manila, Philippines
              </p>
            </div>
            <p className="font-[family-name:var(--font-heading)] text-xl font-extrabold tracking-wide text-[color:var(--color-brand-navy)] sm:text-2xl">
              PAYSLIP
            </p>
          </div>
          <div className="mt-4 h-px w-full bg-[color:var(--color-brand-bg-mid)]" />

          {/* Employee + period block */}
          <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Employee
              </p>
              <p className="mt-1 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                {data.employee.full_name}
              </p>
              {data.employee.employee_number ? (
                <p className="text-sm text-[color:var(--color-brand-text-mid)]">
                  Employee #: {data.employee.employee_number}
                </p>
              ) : null}
              <dl className="mt-2 space-y-0.5 text-sm text-[color:var(--color-brand-text-mid)]">
                {data.employee.tin ? (
                  <div className="flex gap-1.5">
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      TIN:
                    </dt>
                    <dd>{data.employee.tin}</dd>
                  </div>
                ) : null}
                {data.employee.sss_number ? (
                  <div className="flex gap-1.5">
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      SSS:
                    </dt>
                    <dd>{data.employee.sss_number}</dd>
                  </div>
                ) : null}
                {data.employee.philhealth_number ? (
                  <div className="flex gap-1.5">
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      PhilHealth:
                    </dt>
                    <dd>{data.employee.philhealth_number}</dd>
                  </div>
                ) : null}
                {data.employee.pagibig_number ? (
                  <div className="flex gap-1.5">
                    <dt className="text-[color:var(--color-brand-text-soft)]">
                      Pag-IBIG:
                    </dt>
                    <dd>{data.employee.pagibig_number}</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Pay period
              </p>
              <p className="mt-1 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                {formatPeriodRange(
                  data.period.period_start,
                  data.period.period_end,
                )}
              </p>
              <p className="text-sm text-[color:var(--color-brand-text-mid)]">
                Pay date: {formatManilaDate(data.period.pay_date)}
              </p>
              <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
                Payment: {methodLabel}
              </p>
              {methodUsed === "bank" &&
              data.employee.bank_account_number ? (
                <p className="text-sm text-[color:var(--color-brand-text-mid)]">
                  {data.employee.bank_name
                    ? `${data.employee.bank_name} · ${data.employee.bank_account_number}`
                    : data.employee.bank_account_number}
                </p>
              ) : null}
              {data.run.paid_at ? (
                <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                  Paid: {formatManilaDate(data.run.paid_at.slice(0, 10))}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* Earnings + deductions */}
        <section className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          {/* Earnings */}
          <article className="rounded-2xl bg-white p-5 shadow-sm sm:p-7">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
              Earnings
            </h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row label="Basic pay" amount={data.run.basic_pay_php} />
              <Row
                label="Allowances"
                amount={data.run.allowances_total_php}
              />
              <Row label="Overtime" amount={data.run.ot_pay_php} />
              <Row
                label="Night differential"
                amount={data.run.night_diff_pay_php}
              />
              <Row label="Holiday pay" amount={data.run.holiday_pay_php} />
              <Row
                label="Incentives"
                amount={data.run.incentives_total_php}
              />
              <Row
                label="Perfect attendance"
                amount={data.run.perfect_attendance_bonus_php}
              />
              {data.run.thirteenth_month_payout_php > 0 ? (
                <Row
                  label="13th-month payout"
                  amount={data.run.thirteenth_month_payout_php}
                />
              ) : null}
            </dl>
            <div className="mt-3 border-t border-[color:var(--color-brand-bg-mid)] pt-2">
              <Row
                label="Gross pay"
                amount={data.run.gross_pay_php}
                bold
              />
            </div>
          </article>

          {/* Deductions */}
          <article className="rounded-2xl bg-white p-5 shadow-sm sm:p-7">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
              Deductions
            </h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row label="SSS contribution" amount={data.run.sss_ee_php} />
              <Row
                label="PhilHealth contribution"
                amount={data.run.philhealth_ee_php}
              />
              <Row
                label="Pag-IBIG contribution"
                amount={data.run.pagibig_ee_php}
              />
              <Row
                label="Withholding tax"
                amount={data.run.wt_compensation_php}
              />
              {data.run.tardiness_deduction_php > 0 ? (
                <Row
                  label="Tardiness"
                  amount={data.run.tardiness_deduction_php}
                />
              ) : null}
              {data.run.staff_advance_settlement_php > 0 ? (
                <Row
                  label="Staff advance settlement"
                  amount={data.run.staff_advance_settlement_php}
                />
              ) : null}

              {loanLines.length > 0 ? (
                <>
                  <dt className="pt-2 text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Loan amortizations
                  </dt>
                  {loanLines.map((l, idx) => (
                    <Row
                      key={`loan-${idx}`}
                      label={l.label}
                      amount={l.amount_php}
                      indent
                    />
                  ))}
                </>
              ) : null}

              {manualLines.length > 0 ? (
                <>
                  <dt className="pt-2 text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Manual deductions
                  </dt>
                  {manualLines.map((l, idx) => (
                    <Row
                      key={`manual-${idx}`}
                      label={l.label}
                      amount={l.amount_php}
                      indent
                    />
                  ))}
                </>
              ) : null}
            </dl>
            <div className="mt-3 border-t border-[color:var(--color-brand-bg-mid)] pt-2">
              <Row
                label="Total deductions"
                amount={totalDeductions}
                bold
              />
            </div>
          </article>
        </section>

        {/* Net pay band */}
        <section className="mt-5 overflow-hidden rounded-2xl bg-gradient-to-r from-[#284570] to-[#06B6D4] p-5 text-white shadow-sm sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/80">
                Net pay
              </p>
              <p className="mt-1 font-[family-name:var(--font-heading)] text-4xl font-extrabold leading-tight sm:text-5xl">
                {formatPeso(data.run.net_pay_php)}
              </p>
            </div>
            <div className="text-right text-sm text-white/85">
              <p className="font-semibold text-white">
                Pay date: {formatManilaDate(data.period.pay_date)}
              </p>
              <p className="mt-1 text-base font-bold uppercase tracking-wide text-white">
                {(data.run.payment_method_used ?? "pending").toUpperCase()}
              </p>
              <p className="mt-1 text-xs text-white/80">
                Gross {formatPeso(data.run.gross_pay_php)} − Deductions{" "}
                {formatPeso(totalDeductions)}
              </p>
            </div>
          </div>
        </section>

        {/* YTD + Leave */}
        <section className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          {/* YTD totals */}
          <article className="rounded-2xl bg-white p-5 shadow-sm sm:p-7">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
              Year-to-date totals
            </h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row
                label="YTD Gross pay"
                amount={data.ytd.gross_pay_php}
              />
              <Row
                label="YTD Basic pay"
                amount={data.ytd.basic_pay_php}
              />
              <Row
                label="YTD Overtime + night diff"
                amount={
                  data.ytd.ot_pay_php + data.ytd.night_diff_pay_php
                }
              />
              <Row
                label="YTD Holiday pay"
                amount={data.ytd.holiday_pay_php}
              />
              <Row
                label="YTD Incentives"
                amount={data.ytd.incentives_total_php}
              />
              {data.ytd.thirteenth_month_payout_php > 0 ? (
                <Row
                  label="YTD 13th-month"
                  amount={data.ytd.thirteenth_month_payout_php}
                />
              ) : null}
              <Row
                label="YTD SSS + PhilHealth + Pag-IBIG"
                amount={
                  data.ytd.sss_ee_php +
                  data.ytd.philhealth_ee_php +
                  data.ytd.pagibig_ee_php
                }
              />
              <Row
                label="YTD Withholding tax"
                amount={data.ytd.wt_compensation_php}
              />
            </dl>
            <div className="mt-3 border-t border-[color:var(--color-brand-bg-mid)] pt-2">
              <Row
                label="YTD Net pay"
                amount={data.ytd.net_pay_php}
                bold
              />
            </div>
          </article>

          {/* Leave + attendance */}
          <article className="rounded-2xl bg-white p-5 shadow-sm sm:p-7">
            <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
              Leave balances
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
              As of {formatManilaDate(data.period.period_end)}
            </p>
            <dl className="mt-3 space-y-1.5 text-sm">
              <DaysRow
                label="Vacation leave"
                days={data.leave.vl_balance}
              />
              <DaysRow
                label="Sick leave"
                days={data.leave.sl_balance}
              />
            </dl>

            <h3 className="mt-5 text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Attendance this period
            </h3>
            <dl className="mt-2 space-y-1.5 text-sm">
              <TextRow
                label="Days worked"
                value={`${data.run.days_present} of ${data.run.scheduled_days}`}
              />
              <TextRow
                label="Unpaid absence"
                value={`${data.run.days_unpaid_absent} d`}
              />
              <TextRow
                label="VL used / SL used"
                value={`${data.run.days_vl_used} d / ${data.run.days_sl_used} d`}
              />
            </dl>
          </article>
        </section>

        <p className="mt-6 text-center text-xs text-[color:var(--color-brand-text-soft)]">
          Signatures are captured on the printed PDF only.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row primitives
// ---------------------------------------------------------------------------

function Row({
  label,
  amount,
  bold = false,
  indent = false,
}: {
  label: string;
  amount: number;
  bold?: boolean;
  indent?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${indent ? "pl-3" : ""}`}>
      <dt
        className={
          bold
            ? "font-semibold text-[color:var(--color-brand-navy)]"
            : "text-[color:var(--color-brand-text-soft)]"
        }
      >
        {label}
      </dt>
      <dd
        className={
          bold
            ? "font-extrabold text-[color:var(--color-brand-navy)]"
            : "text-[color:var(--color-brand-text-mid)]"
        }
      >
        {formatPeso(amount)}
      </dd>
    </div>
  );
}

function DaysRow({ label, days }: { label: string; days: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[color:var(--color-brand-text-soft)]">{label}</dt>
      <dd className="text-[color:var(--color-brand-text-mid)]">
        {days.toFixed(2)} days
      </dd>
    </div>
  );
}

function TextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[color:var(--color-brand-text-soft)]">{label}</dt>
      <dd className="text-[color:var(--color-brand-text-mid)]">{value}</dd>
    </div>
  );
}
