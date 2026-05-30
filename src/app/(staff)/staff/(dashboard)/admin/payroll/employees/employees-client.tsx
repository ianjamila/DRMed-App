"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatPhp } from "@/lib/marketing/format";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import { PAYMENT_LABEL, ROLE_LABEL, SCHEDULE_LABEL } from "@/lib/payroll/labels";
import { createEmployeeAction } from "./actions";
import { Panel } from "@/components/ui/panel";

export interface EmployeeListRow {
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

export interface EligibleStaffOption {
  id: string;
  full_name: string;
  role: string;
}

type StatusFilter = "all" | "active" | "inactive";

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

interface Props {
  employees: EmployeeListRow[];
  eligibleStaff: EligibleStaffOption[];
}

export function EmployeesClient({ employees, eligibleStaff }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return employees.filter((e) => {
      if (status === "active" && !e.is_active) return false;
      if (status === "inactive" && e.is_active) return false;
      if (q) {
        const hay = `${e.full_name} ${e.employee_number ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [employees, deferredQuery, status]);

  const activeCount = useMemo(
    () => employees.filter((e) => e.is_active).length,
    [employees],
  );
  const inactiveCount = useMemo(
    () => employees.filter((e) => !e.is_active).length,
    [employees],
  );

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const handleCreated = useCallback(() => {
    setDrawerOpen(false);
    router.refresh();
  }, [router]);

  const openEmployee = useCallback(
    (id: string) => router.push(`/staff/admin/payroll/employees/${id}`),
    [router],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name or employee #"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-64 flex-1 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2.5 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2.5 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="all">All ({employees.length})</option>
          <option value="active">Active ({activeCount})</option>
          <option value="inactive">Inactive ({inactiveCount})</option>
        </select>
        <p className="hidden text-xs text-[color:var(--color-brand-text-soft)] sm:block">
          Showing {filtered.length} of {employees.length}
        </p>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="ml-auto min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95"
        >
          + Add employee
        </button>
      </div>

      {/* Desktop table */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Employee #</th>
              <th className="px-4 py-3">Hired</th>
              <th className="px-4 py-3">Reg</th>
              <th className="px-4 py-3 text-right">Daily rate</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No employees match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => openEmployee(e.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      openEmployee(e.id);
                    } else if (event.key === " ") {
                      event.preventDefault();
                      openEmployee(e.id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open ${e.full_name}`}
                  className="cursor-pointer hover:bg-[color:var(--color-brand-bg)]/40 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)] focus:ring-inset"
                >
                  <td className="px-4 py-3 align-middle">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      {e.full_name}
                    </div>
                    {e.role ? (
                      <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {ROLE_LABEL[e.role] ?? e.role}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-middle font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                    {e.employee_number ?? "—"}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {formatDate(e.hire_date)}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {formatDate(e.regularization_date)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPhp(e.basic_daily_rate_php)}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {SCHEDULE_LABEL[e.schedule_kind] ?? e.schedule_kind}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {PAYMENT_LABEL[e.payment_method] ?? e.payment_method}
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <StatusPill active={e.is_active} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      {/* Mobile stacked cards */}
      <div className="space-y-3 md:hidden">
        {filtered.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No employees match your filters.
          </p>
        ) : (
          filtered.map((e) => (
            <Link
              key={e.id}
              href={`/staff/admin/payroll/employees/${e.id}`}
              className="block min-h-[44px] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm hover:border-[color:var(--color-brand-cyan)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {e.full_name}
                  </div>
                  {e.role ? (
                    <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                      {ROLE_LABEL[e.role] ?? e.role}
                    </div>
                  ) : null}
                </div>
                <StatusPill active={e.is_active} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Employee #
                </dt>
                <dd className="text-right font-mono">
                  {e.employee_number ?? "—"}
                </dd>
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Daily rate
                </dt>
                <dd className="text-right font-semibold text-[color:var(--color-brand-navy)]">
                  {formatPhp(e.basic_daily_rate_php)}
                </dd>
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Hired
                </dt>
                <dd className="text-right">{formatDate(e.hire_date)}</dd>
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Schedule
                </dt>
                <dd className="text-right">
                  {SCHEDULE_LABEL[e.schedule_kind] ?? e.schedule_kind}
                </dd>
                <dt className="text-[color:var(--color-brand-text-soft)]">
                  Payment
                </dt>
                <dd className="text-right">
                  {PAYMENT_LABEL[e.payment_method] ?? e.payment_method}
                </dd>
              </dl>
            </Link>
          ))
        )}
      </div>

      <AddEmployeeDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        eligibleStaff={eligibleStaff}
        onCreated={handleCreated}
      />
    </div>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return active ? (
    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-900">
      Active
    </span>
  ) : (
    <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
      Inactive
    </span>
  );
}

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  eligibleStaff: EligibleStaffOption[];
  onCreated: () => void;
}

function AddEmployeeDrawer({
  open,
  onClose,
  eligibleStaff,
  onCreated,
}: DrawerProps) {
  const [staffProfileId, setStaffProfileId] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [hireDate, setHireDate] = useState(todayManila());
  const [regularizationDate, setRegularizationDate] = useState("");
  const [dailyRate, setDailyRate] = useState("");
  const [monthlySalaryCredit, setMonthlySalaryCredit] = useState("");
  const [scheduleKind, setScheduleKind] = useState<
    "fixed_5day_mon_fri" | "fixed_6day_mon_sat" | "shifting_5of6_mon_sat"
  >("fixed_6day_mon_sat");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank">("cash");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    setError(null);
    const dailyRateN = Number(dailyRate);
    const mscN = Number(monthlySalaryCredit);
    if (!staffProfileId) {
      setError("Pick a staff profile.");
      return;
    }
    if (!Number.isFinite(dailyRateN) || dailyRateN <= 0) {
      setError("Daily rate must be a positive number.");
      return;
    }
    if (!Number.isFinite(mscN) || mscN <= 0) {
      setError("Monthly salary credit must be a positive number.");
      return;
    }
    startTransition(async () => {
      const result = await createEmployeeAction({
        staff_profile_id: staffProfileId,
        employee_number: employeeNumber.trim() || undefined,
        hire_date: hireDate,
        regularization_date: regularizationDate || null,
        basic_daily_rate_php: dailyRateN,
        monthly_salary_credit_php: mscN,
        schedule_kind: scheduleKind,
        payment_method: paymentMethod,
        tax_status: "standard",
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Reset and close.
      setStaffProfileId("");
      setEmployeeNumber("");
      setHireDate(todayManila());
      setRegularizationDate("");
      setDailyRate("");
      setMonthlySalaryCredit("");
      setScheduleKind("fixed_6day_mon_sat");
      setPaymentMethod("cash");
      onCreated();
    });
  };

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-employee-title"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <h2
            id="add-employee-title"
            className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]"
          >
            Add employee
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] rounded-md text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Close
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">
          <Field label="Staff profile">
            <select
              value={staffProfileId}
              onChange={(e) => setStaffProfileId(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">Select a staff member…</option>
              {eligibleStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name} ({ROLE_LABEL[s.role] ?? s.role})
                </option>
              ))}
            </select>
            {eligibleStaff.length === 0 ? (
              <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                All active staff already have employee records.
              </p>
            ) : null}
          </Field>

          <Field label="Employee number (optional)">
            <input
              type="text"
              value={employeeNumber}
              onChange={(e) => setEmployeeNumber(e.target.value)}
              placeholder="e.g. DRM-0042"
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

          <Field label="Hire date">
            <input
              type="date"
              value={hireDate}
              onChange={(e) => setHireDate(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

          <Field label="Regularization date (optional)">
            <input
              type="date"
              value={regularizationDate}
              onChange={(e) => setRegularizationDate(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

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
                placeholder="e.g. 750"
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              />
            </div>
          </Field>

          <Field label="Monthly salary credit (for SSS/PhilHealth)">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[color:var(--color-brand-text-soft)]">
                ₱
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={monthlySalaryCredit}
                onChange={(e) => setMonthlySalaryCredit(e.target.value)}
                placeholder="e.g. 20000"
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
              <option value="fixed_5day_mon_fri">
                Fixed Mon–Fri (5 days)
              </option>
              <option value="fixed_6day_mon_sat">
                Fixed Mon–Sat (6 days)
              </option>
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

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="mt-auto flex gap-3 border-t border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="min-h-[44px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="min-h-[44px] flex-1 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Create employee"}
          </button>
        </div>
      </div>
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
