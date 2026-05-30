"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatPhp } from "@/lib/marketing/format";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import { PAYMENT_LABEL, ROLE_LABEL, SCHEDULE_LABEL } from "@/lib/payroll/labels";
import {
  updateEmployeeAction,
  deactivateEmployeeAction,
  addAllowanceAction,
  endAllowanceAction,
  requestLoanAction,
  approveLoanAction,
  markLoanDisbursedAction,
  voidLoanAction,
  writeOffLoanAction,
} from "../actions";
import {
  addLeaveGrantAction,
  recordLeaveUsageAction,
  recordLeaveCashConversionAction,
} from "../../leaves/actions";

export interface EmployeeDetail {
  id: string;
  employee_number: string | null;
  hire_date: string;
  regularization_date: string | null;
  termination_date: string | null;
  basic_daily_rate_php: number;
  schedule_kind: string;
  payment_method: string;
  is_active: boolean;
  full_name: string;
  role: string | null;
}

export interface AllowanceRow {
  id: string;
  name: string;
  daily_amount_php: number;
  is_taxable: boolean;
  effective_from: string;
  effective_to: string | null;
}

export interface LoanRow {
  id: string;
  principal_php: number;
  amortization_per_period_php: number;
  outstanding_balance_php: number;
  status: string;
  notes: string | null;
  requested_at: string;
  approved_at: string | null;
  disbursed_at: string | null;
  start_period_id: string | null;
}

export interface OtSlipRow {
  id: string;
  work_date: string;
  hours_requested: number;
  status: string;
  reason: string | null;
  requested_at: string;
  decided_at: string | null;
  decision_notes: string | null;
}

export interface PeriodOption {
  id: string;
  period_start: string;
  period_end: string;
}

export interface EmployeeRunHistoryRow {
  id: string;
  run_id: string;
  run_status: string | null;
  period_start: string | null;
  period_end: string | null;
  scheduled_days: number;
  days_present: number;
  days_vl_used: number;
  days_sl_used: number;
  basic_pay_php: number;
  gross_pay_php: number;
  net_pay_php: number;
}

type TabKey = "overview" | "allowances" | "loans" | "leaves";

const LOAN_STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  approved: "Approved",
  active: "Active",
  paid_off: "Paid off",
  written_off: "Written off",
  voided: "Voided",
};

const LOAN_STATUS_BADGE: Record<string, string> = {
  requested: "bg-amber-100 text-amber-900",
  approved: "bg-sky-100 text-sky-900",
  active: "bg-emerald-100 text-emerald-900",
  paid_off: "bg-slate-200 text-slate-700",
  written_off: "bg-rose-100 text-rose-900",
  voided: "bg-slate-200 text-slate-700",
};

function todayManila(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPeriodRange(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  return `${formatDate(start)} – ${formatDate(end)}`;
}

interface Props {
  employee: EmployeeDetail;
  allowances: AllowanceRow[];
  loans: LoanRow[];
  otSlips: OtSlipRow[];
  vlBalance: number;
  slBalance: number;
  runHistory: EmployeeRunHistoryRow[];
  periodOptions: PeriodOption[];
}

export function EmployeeDetailClient(props: Props) {
  const [tab, setTab] = useState<TabKey>("overview");
  const { employee } = props;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href="/staff/admin/payroll/employees"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Employees
          </Link>
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {employee.full_name}
        </h1>
        <HeaderFacts employee={employee} />
      </header>

      <Tabs current={tab} onChange={setTab} />

      <div className="mt-6">
        {tab === "overview" ? (
          <OverviewTab employee={employee} />
        ) : tab === "allowances" ? (
          <AllowancesTab
            employeeId={employee.id}
            allowances={props.allowances}
          />
        ) : tab === "loans" ? (
          <LoansTab
            employeeId={employee.id}
            loans={props.loans}
            periodOptions={props.periodOptions}
          />
        ) : (
          <LeavesTab
            employeeId={employee.id}
            vlBalance={props.vlBalance}
            slBalance={props.slBalance}
            runHistory={props.runHistory}
            otSlips={props.otSlips}
          />
        )}
      </div>
    </div>
  );
}

function HeaderFacts({ employee }: { employee: EmployeeDetail }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {employee.role ? (
        <Pill tone="cyan">{ROLE_LABEL[employee.role] ?? employee.role}</Pill>
      ) : null}
      {employee.employee_number ? (
        <Pill tone="slate">#{employee.employee_number}</Pill>
      ) : null}
      <Pill tone={employee.is_active ? "emerald" : "slate"}>
        {employee.is_active ? "Active" : "Inactive"}
      </Pill>
      <Pill tone="slate">
        {SCHEDULE_LABEL[employee.schedule_kind] ?? employee.schedule_kind}
      </Pill>
      <Pill tone="slate">
        {PAYMENT_LABEL[employee.payment_method] ?? employee.payment_method}
      </Pill>
      <span className="ml-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Hired {formatDate(employee.hire_date)}
        {employee.regularization_date
          ? ` · Regularized ${formatDate(employee.regularization_date)}`
          : ""}
        {employee.termination_date
          ? ` · Terminated ${formatDate(employee.termination_date)}`
          : ""}
      </span>
      <span className="ml-auto text-base font-semibold text-[color:var(--color-brand-navy)]">
        {formatPhp(employee.basic_daily_rate_php)} / day
      </span>
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "cyan" | "emerald" | "slate" | "amber" | "rose" | "sky";
}) {
  const toneClass: Record<typeof tone, string> = {
    cyan: "bg-cyan-100 text-cyan-900",
    emerald: "bg-emerald-100 text-emerald-900",
    slate: "bg-slate-200 text-slate-700",
    amber: "bg-amber-100 text-amber-900",
    rose: "bg-rose-100 text-rose-900",
    sky: "bg-sky-100 text-sky-900",
  };
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

function Tabs({
  current,
  onChange,
}: {
  current: TabKey;
  onChange: (t: TabKey) => void;
}) {
  const items: { key: TabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "allowances", label: "Allowances" },
    { key: "loans", label: "Loans" },
    { key: "leaves", label: "Leaves" },
  ];
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex min-w-max gap-1 border-b border-[color:var(--color-brand-bg-mid)]">
        {items.map((i) => {
          const active = i.key === current;
          return (
            <button
              key={i.key}
              type="button"
              onClick={() => onChange(i.key)}
              className={`min-h-[44px] border-b-2 px-4 py-2 text-sm font-bold transition ${
                active
                  ? "border-[color:var(--color-brand-cyan)] text-[color:var(--color-brand-navy)]"
                  : "border-transparent text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)]"
              }`}
            >
              {i.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Overview tab
// =============================================================================

function OverviewTab({ employee }: { employee: EmployeeDetail }) {
  const router = useRouter();
  const [dailyRate, setDailyRate] = useState(
    String(employee.basic_daily_rate_php),
  );
  const [scheduleKind, setScheduleKind] = useState<
    "fixed_5day_mon_fri" | "fixed_6day_mon_sat" | "shifting_5of6_mon_sat"
  >(
    (employee.schedule_kind as
      | "fixed_5day_mon_fri"
      | "fixed_6day_mon_sat"
      | "shifting_5of6_mon_sat") ?? "fixed_6day_mon_sat",
  );
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank">(
    (employee.payment_method as "cash" | "bank") ?? "cash",
  );
  const [regularizationDate, setRegularizationDate] = useState(
    employee.regularization_date ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSaved(false);

    const dailyRateN = Number(dailyRate);
    if (!Number.isFinite(dailyRateN) || dailyRateN <= 0) {
      setError("Daily rate must be a positive number.");
      return;
    }

    startTransition(async () => {
      const updateResult = await updateEmployeeAction(employee.id, {
        basic_daily_rate_php: dailyRateN,
        schedule_kind: scheduleKind,
        payment_method: paymentMethod,
        regularization_date: regularizationDate || null,
      });
      if (!updateResult.ok) {
        setError(updateResult.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  const deactivate = () => {
    if (isPending) return;
    setError(null);
    setSaved(false);
    const ok = window.confirm(
      `Deactivate ${employee.full_name}? They will no longer appear on payroll runs.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await deactivateEmployeeAction(employee.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Employment details
      </h2>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Update HR fields. To end employment, use the Deactivate button below;
        it records the termination date and sets the employee inactive.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Basic daily rate">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[color:var(--color-brand-text-soft)]">
              ₱
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={dailyRate}
              onChange={(e) => setDailyRate(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </div>
        </Field>

        <Field label="Schedule">
          <select
            value={scheduleKind}
            onChange={(e) =>
              setScheduleKind(
                e.target.value as
                  | "fixed_5day_mon_fri"
                  | "fixed_6day_mon_sat"
                  | "shifting_5of6_mon_sat",
              )
            }
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="fixed_5day_mon_fri">Fixed Mon–Fri (5 days)</option>
            <option value="fixed_6day_mon_sat">Fixed Mon–Sat (6 days)</option>
            <option value="shifting_5of6_mon_sat">
              Shifting 5-of-6 Mon–Sat
            </option>
          </select>
        </Field>

        <Field label="Payment method">
          <select
            value={paymentMethod}
            onChange={(e) =>
              setPaymentMethod(e.target.value as "cash" | "bank")
            }
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
          </select>
        </Field>

        <Field label="Regularization date">
          <input
            type="date"
            value={regularizationDate}
            onChange={(e) => setRegularizationDate(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Termination date">
          <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)]/40 px-3 py-2 text-sm text-[color:var(--color-brand-text-mid)]">
            {employee.termination_date
              ? formatDate(employee.termination_date)
              : "—"}
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            Set via the Deactivate action below; recorded automatically.
          </p>
        </Field>
      </div>

      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
      {saved ? (
        <p className="mt-4 text-sm text-emerald-700">Saved.</p>
      ) : null}

      <div className="mt-6 flex flex-wrap justify-between gap-3">
        {employee.is_active ? (
          <button
            type="button"
            onClick={deactivate}
            disabled={isPending}
            className="min-h-[44px] rounded-md border border-rose-200 bg-white px-6 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            Deactivate employee
          </button>
        ) : (
          <span className="text-sm text-[color:var(--color-brand-text-soft)]">
            This employee is inactive.
          </span>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-6 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}

// =============================================================================
// Allowances tab
// =============================================================================

function AllowancesTab({
  employeeId,
  allowances,
}: {
  employeeId: string;
  allowances: AllowanceRow[];
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [isTaxable, setIsTaxable] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState(todayManila());
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submitAdd = () => {
    setError(null);
    const amountN = Number(amount);
    if (!name.trim()) {
      setError("Label is required.");
      return;
    }
    if (!Number.isFinite(amountN) || amountN < 0) {
      setError("Daily amount must be a non-negative number.");
      return;
    }
    startTransition(async () => {
      const result = await addAllowanceAction({
        employee_id: employeeId,
        name: name.trim(),
        daily_amount_php: amountN,
        is_taxable: isTaxable,
        effective_from: effectiveFrom,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setAmount("");
      setIsTaxable(true);
      setEffectiveFrom(todayManila());
      setShowAdd(false);
      router.refresh();
    });
  };

  const endRow = (a: AllowanceRow) => {
    setRowError(null);
    const today = todayManila();
    const ok = window.confirm(
      `End allowance "${a.name}" effective ${today}?`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await endAllowanceAction(a.id, today);
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Allowances
        </h2>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95"
        >
          {showAdd ? "Cancel" : "+ Add allowance"}
        </button>
      </div>

      {showAdd ? (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Label">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Transportation"
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
            <Field label="Daily amount">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[color:var(--color-brand-text-soft)]">
                  ₱
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
              </div>
            </Field>
            <Field label="Effective from">
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={isTaxable}
                onChange={(e) => setIsTaxable(e.target.checked)}
                className="h-4 w-4"
              />
              Taxable allowance
            </label>
          </div>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={submitAdd}
              disabled={isPending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-6 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Add allowance"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3 text-right">Daily amount</th>
              <th className="px-4 py-3">Taxable</th>
              <th className="px-4 py-3">Effective from</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {allowances.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No allowances yet.
                </td>
              </tr>
            ) : (
              allowances.map((a) => {
                const active = a.effective_to == null;
                return (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                      {a.name}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {formatPhp(a.daily_amount_php)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {a.is_taxable ? "Yes" : "No"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {formatDate(a.effective_from)}
                    </td>
                    <td className="px-4 py-3">
                      {active ? (
                        <Pill tone="emerald">Active</Pill>
                      ) : (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          Ended {formatDate(a.effective_to)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {active ? (
                        <button
                          type="button"
                          onClick={() => endRow(a)}
                          disabled={isPending}
                          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
                        >
                          End
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {rowError ? <p className="text-sm text-red-600">{rowError}</p> : null}
    </section>
  );
}

// =============================================================================
// Loans tab
// =============================================================================

function LoansTab({
  employeeId,
  loans,
  periodOptions,
}: {
  employeeId: string;
  loans: LoanRow[];
  periodOptions: PeriodOption[];
}) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [principal, setPrincipal] = useState("");
  const [amort, setAmort] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Per-loan dialog state for disbursement / void / write-off prompts.
  const [disburseLoan, setDisburseLoan] = useState<LoanRow | null>(null);
  const [voidLoan, setVoidLoan] = useState<LoanRow | null>(null);
  const [writeOff, setWriteOff] = useState<LoanRow | null>(null);

  const submitAdd = () => {
    setError(null);
    const principalN = Number(principal);
    const amortN = Number(amort);
    if (!Number.isFinite(principalN) || principalN <= 0) {
      setError("Principal must be a positive number.");
      return;
    }
    if (!Number.isFinite(amortN) || amortN <= 0) {
      setError("Monthly amortization must be a positive number.");
      return;
    }
    startTransition(async () => {
      const result = await requestLoanAction({
        employee_id: employeeId,
        principal_php: principalN,
        amortization_per_period_php: amortN,
        notes: reason.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPrincipal("");
      setAmort("");
      setReason("");
      setShowAdd(false);
      router.refresh();
    });
  };

  const approve = (loan: LoanRow) => {
    setRowError(null);
    startTransition(async () => {
      const result = await approveLoanAction({ loan_id: loan.id });
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Loans
        </h2>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95"
        >
          {showAdd ? "Cancel" : "+ Request loan"}
        </button>
      </div>

      {showAdd ? (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Principal">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[color:var(--color-brand-text-soft)]">
                  ₱
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
              </div>
            </Field>
            <Field label="Monthly amortization">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[color:var(--color-brand-text-soft)]">
                  ₱
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={amort}
                  onChange={(e) => setAmort(e.target.value)}
                  className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                />
              </div>
            </Field>
            <Field label="Reason / notes (optional)">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What is this loan for?"
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </Field>
          </div>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={submitAdd}
              disabled={isPending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-6 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Request loan"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3 text-right">Principal</th>
              <th className="px-4 py-3 text-right">Per period</th>
              <th className="px-4 py-3 text-right">Outstanding</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {loans.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No loans yet.
                </td>
              </tr>
            ) : (
              loans.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 text-right font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPhp(l.principal_php)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {formatPhp(l.amortization_per_period_php)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {formatPhp(l.outstanding_balance_php)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${
                        LOAN_STATUS_BADGE[l.status] ??
                        "bg-slate-200 text-slate-700"
                      }`}
                    >
                      {LOAN_STATUS_LABEL[l.status] ?? l.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {formatDateTime(l.requested_at)}
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                    {l.notes ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {l.status === "requested" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => approve(l)}
                            disabled={isPending}
                            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => setVoidLoan(l)}
                            disabled={isPending}
                            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-rose-300 disabled:opacity-50"
                          >
                            Void
                          </button>
                        </>
                      ) : null}
                      {l.status === "approved" ? (
                        <button
                          type="button"
                          onClick={() => setDisburseLoan(l)}
                          disabled={isPending}
                          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
                        >
                          Mark disbursed
                        </button>
                      ) : null}
                      {l.status === "active" ? (
                        <button
                          type="button"
                          onClick={() => setWriteOff(l)}
                          disabled={isPending}
                          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-rose-300 disabled:opacity-50"
                        >
                          Write off
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {rowError ? <p className="text-sm text-red-600">{rowError}</p> : null}

      {disburseLoan ? (
        <DisbursementDialog
          loan={disburseLoan}
          periodOptions={periodOptions}
          onClose={() => setDisburseLoan(null)}
          onDone={() => {
            setDisburseLoan(null);
            router.refresh();
          }}
        />
      ) : null}
      {voidLoan ? (
        <ReasonDialog
          title="Void loan"
          body={`Voiding will permanently mark this loan as voided. Outstanding ${formatPhp(voidLoan.outstanding_balance_php)}.`}
          confirmLabel="Void loan"
          onClose={() => setVoidLoan(null)}
          onSubmit={async (text) => {
            const result = await voidLoanAction(voidLoan.id, text);
            if (!result.ok) return result.error;
            setVoidLoan(null);
            router.refresh();
            return null;
          }}
        />
      ) : null}
      {writeOff ? (
        <ReasonDialog
          title="Write off loan"
          body={`Writing off marks the remaining ${formatPhp(writeOff.outstanding_balance_php)} as uncollectible.`}
          confirmLabel="Write off"
          onClose={() => setWriteOff(null)}
          onSubmit={async (text) => {
            const result = await writeOffLoanAction(writeOff.id, text);
            if (!result.ok) return result.error;
            setWriteOff(null);
            router.refresh();
            return null;
          }}
        />
      ) : null}
    </section>
  );
}

function DisbursementDialog({
  loan,
  periodOptions,
  onClose,
  onDone,
}: {
  loan: LoanRow;
  periodOptions: PeriodOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [periodId, setPeriodId] = useState(periodOptions[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    if (!periodId) {
      setError("Select a start period.");
      return;
    }
    startTransition(async () => {
      const result = await markLoanDisbursedAction({
        loan_id: loan.id,
        start_period_id: periodId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
    });
  };

  return (
    <Dialog title="Mark loan disbursed" onClose={onClose}>
      <p className="text-sm text-[color:var(--color-brand-text-mid)]">
        Pick the open payroll period in which amortizations will start
        deducting.
      </p>
      <div className="mt-4">
        <Field label="Start period">
          <select
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            {periodOptions.length === 0 ? (
              <option value="">No open periods available</option>
            ) : null}
            {periodOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {formatPeriodRange(p.period_start, p.period_end)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <DialogActions
        onClose={onClose}
        onConfirm={submit}
        disabled={isPending || periodOptions.length === 0 || !periodId}
        confirmLabel={isPending ? "Saving…" : "Confirm disbursement"}
      />
    </Dialog>
  );
}

function ReasonDialog({
  title,
  body,
  confirmLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    if (!text.trim()) {
      setError("Reason is required.");
      return;
    }
    startTransition(async () => {
      const errMsg = await onSubmit(text.trim());
      if (errMsg) setError(errMsg);
    });
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <p className="text-sm text-[color:var(--color-brand-text-mid)]">{body}</p>
      <div className="mt-4">
        <Field label="Reason">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <DialogActions
        onClose={onClose}
        onConfirm={submit}
        disabled={isPending}
        confirmLabel={isPending ? "Saving…" : confirmLabel}
      />
    </Dialog>
  );
}

// =============================================================================
// Leaves tab
// =============================================================================

function LeavesTab({
  employeeId,
  vlBalance,
  slBalance,
  runHistory,
  otSlips,
}: {
  employeeId: string;
  vlBalance: number;
  slBalance: number;
  runHistory: EmployeeRunHistoryRow[];
  otSlips: OtSlipRow[];
}) {
  const [grantOpen, setGrantOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);

  return (
    <section className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <BalanceCard label="Vacation leave (VL)" days={vlBalance} tone="emerald" />
        <BalanceCard label="Sick leave (SL)" days={slBalance} tone="sky" />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setGrantOpen(true)}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95"
        >
          + Add grant
        </button>
        <button
          type="button"
          onClick={() => setUsageOpen(true)}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
        >
          Record usage
        </button>
        <button
          type="button"
          onClick={() => setCashOpen(true)}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
        >
          Cash conversion
        </button>
      </div>

      <div>
        <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Period history (last 10)
        </h3>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Days present and leave taken per recent payroll period.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3">Run status</th>
                <th className="px-4 py-3 text-right">Scheduled</th>
                <th className="px-4 py-3 text-right">Present</th>
                <th className="px-4 py-3 text-right">VL used</th>
                <th className="px-4 py-3 text-right">SL used</th>
                <th className="px-4 py-3 text-right">Net pay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {runHistory.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No payroll runs yet.
                  </td>
                </tr>
              ) : (
                runHistory.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 text-xs">
                      {formatPeriodRange(r.period_start, r.period_end)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.run_status ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      {r.scheduled_days}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      {r.days_present}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      {r.days_vl_used}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      {r.days_sl_used}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-[color:var(--color-brand-navy)]">
                      {formatPhp(r.net_pay_php)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Recent OT slips
        </h3>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Last 30 overtime requests for this employee.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Work date</th>
                <th className="px-4 py-3 text-right">Hours</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Requested</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {otSlips.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No OT slips yet.
                  </td>
                </tr>
              ) : (
                otSlips.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3 text-xs">
                      {formatDate(s.work_date)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      {s.hours_requested}
                    </td>
                    <td className="px-4 py-3 text-xs">{s.status}</td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {s.reason ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {formatDateTime(s.requested_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {grantOpen ? (
        <LeaveGrantDialog
          employeeId={employeeId}
          onClose={() => setGrantOpen(false)}
        />
      ) : null}
      {usageOpen ? (
        <LeaveUsageDialog
          employeeId={employeeId}
          onClose={() => setUsageOpen(false)}
        />
      ) : null}
      {cashOpen ? (
        <LeaveCashDialog
          employeeId={employeeId}
          onClose={() => setCashOpen(false)}
        />
      ) : null}
    </section>
  );
}

function BalanceCard({
  label,
  days,
  tone,
}: {
  label: string;
  days: number;
  tone: "emerald" | "sky";
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50"
      : "border-sky-200 bg-sky-50";
  return (
    <div className={`rounded-xl border p-5 ${toneClass}`}>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {days.toFixed(1)} <span className="text-base font-semibold">days</span>
      </p>
    </div>
  );
}

function LeaveGrantDialog({
  employeeId,
  onClose,
}: {
  employeeId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<"VL" | "SL">("VL");
  const [days, setDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayManila());
  const [expiryDate, setExpiryDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    const daysN = Number(days);
    if (!Number.isFinite(daysN) || daysN <= 0) {
      setError("Days must be a positive number.");
      return;
    }
    if (!reason.trim()) {
      setError("Reason is required.");
      return;
    }
    startTransition(async () => {
      const result = await addLeaveGrantAction({
        employee_id: employeeId,
        kind,
        days: daysN,
        effective_date: effectiveDate,
        expiry_date: expiryDate || null,
        reason: reason.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog title="Add leave grant" onClose={onClose}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "VL" | "SL")}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="VL">Vacation (VL)</option>
            <option value="SL">Sick (SL)</option>
          </select>
        </Field>
        <Field label="Days">
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
        <Field label="Effective date">
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
        <Field label="Expiry date (optional)">
          <input
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Reason">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <DialogActions
        onClose={onClose}
        onConfirm={submit}
        disabled={isPending}
        confirmLabel={isPending ? "Saving…" : "Add grant"}
      />
    </Dialog>
  );
}

function LeaveUsageDialog({
  employeeId,
  onClose,
}: {
  employeeId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<"VL" | "SL">("VL");
  const [days, setDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayManila());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    const daysN = Number(days);
    if (!Number.isFinite(daysN) || daysN <= 0) {
      setError("Days must be a positive number.");
      return;
    }
    startTransition(async () => {
      const result = await recordLeaveUsageAction({
        employee_id: employeeId,
        kind,
        days: daysN,
        effective_date: effectiveDate,
        reason: reason.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog title="Record leave usage" onClose={onClose}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "VL" | "SL")}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="VL">Vacation (VL)</option>
            <option value="SL">Sick (SL)</option>
          </select>
        </Field>
        <Field label="Days used">
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
        <Field label="Effective date">
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Reason (optional)">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <DialogActions
        onClose={onClose}
        onConfirm={submit}
        disabled={isPending}
        confirmLabel={isPending ? "Saving…" : "Record usage"}
      />
    </Dialog>
  );
}

function LeaveCashDialog({
  employeeId,
  onClose,
}: {
  employeeId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<"VL" | "SL">("VL");
  const [days, setDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayManila());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    const daysN = Number(days);
    if (!Number.isFinite(daysN) || daysN <= 0) {
      setError("Days must be a positive number.");
      return;
    }
    startTransition(async () => {
      const result = await recordLeaveCashConversionAction({
        employee_id: employeeId,
        kind,
        days: daysN,
        effective_date: effectiveDate,
        reason: reason.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog title="Record cash conversion" onClose={onClose}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "VL" | "SL")}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="VL">Vacation (VL)</option>
            <option value="SL">Sick (SL)</option>
          </select>
        </Field>
        <Field label="Days converted">
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
        <Field label="Effective date">
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Reason (optional)">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      <DialogActions
        onClose={onClose}
        onConfirm={submit}
        disabled={isPending}
        confirmLabel={isPending ? "Saving…" : "Convert to cash"}
      />
    </Dialog>
  );
}

// =============================================================================
// Shared dialog scaffolding
// =============================================================================

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          {title}
        </h3>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function DialogActions({
  onClose,
  onConfirm,
  disabled,
  confirmLabel,
}: {
  onClose: () => void;
  onConfirm: () => void;
  disabled: boolean;
  confirmLabel: string;
}) {
  return (
    <div className="mt-6 flex justify-end gap-3">
      <button
        type="button"
        onClick={onClose}
        disabled={disabled}
        className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        {confirmLabel}
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
    </label>
  );
}
