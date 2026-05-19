"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import {
  addLeaveGrantAction,
  applyLeaveEntitlementsForYearAction,
  applyLeaveExpiryAction,
  recordLeaveCashConversionAction,
  recordLeaveUsageAction,
} from "./actions";

// =============================================================================
// Prop shapes
// =============================================================================

export interface LeaveRow {
  employee_id: string;
  employee_number: string | null;
  full_name: string;
  vl_balance: number;
  sl_balance: number;
  days_used_this_year: number;
  next_expiry_date: string | null;
}

interface Props {
  rows: LeaveRow[];
  years: number[];
  currentYear: number;
  todayManila: string;
  error: string | null;
}

type LeaveKind = "VL" | "SL";

type ActionKind = "grant" | "usage" | "cash";

interface OpenDrawer {
  action: ActionKind;
  row: LeaveRow;
}

// =============================================================================
// Local formatters
// =============================================================================

const DATE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDateOrDash(iso: string | null): string {
  if (!iso) return "—";
  return DATE_FMT.format(new Date(`${iso}T00:00:00+08:00`));
}

function formatDays(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

const ROUTE = "/staff/admin/payroll/leaves";

// =============================================================================
// Main client
// =============================================================================

export function LeavesClient({
  rows,
  years,
  currentYear,
  todayManila,
  error,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [drawer, setDrawer] = useState<OpenDrawer | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const updateYear = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.set("year", value);
      const qs = next.toString();
      setActionError(null);
      setActionOk(null);
      startTransition(() => {
        router.replace(qs ? `${ROUTE}?${qs}` : ROUTE);
      });
    },
    [router, searchParams],
  );

  const handleRunEntitlements = useCallback(() => {
    // window.confirm is acceptable for low-stakes admin actions; matches the
    // holidays + employees convention. We avoid window.alert for errors —
    // failures surface via the actionError banner below.
    const ok = window.confirm(
      `Run year-end entitlements for ${currentYear}? This inserts the standard SL/VL accruals for every active employee. Safe to re-run — the unique index on (employee, kind, record_kind, effective_date) prevents duplicates.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await applyLeaveEntitlementsForYearAction({
        year: currentYear,
      });
      if (!result.ok) {
        setActionError(result.error);
        setActionOk(null);
        return;
      }
      setActionError(null);
      setActionOk(
        `Applied entitlements for ${currentYear}: ${result.data.rows.length} row(s) inserted.`,
      );
      router.refresh();
    });
  }, [currentYear, router]);

  const handleApplyExpiry = useCallback(() => {
    const ok = window.confirm(
      `Apply VL expiry as of ${todayManila}? This forfeits any unused VL that has reached its expiry date. Safe to re-run.`,
    );
    if (!ok) return;
    startTransition(async () => {
      // The action's schema accepts `year`; the underlying RPC uses that to
      // bound the April 1st expiry cycle. Use current Manila year.
      const result = await applyLeaveExpiryAction({ year: currentYear });
      if (!result.ok) {
        setActionError(result.error);
        setActionOk(null);
        return;
      }
      setActionError(null);
      setActionOk(
        `Applied VL expiry: ${result.data.rows.length} row(s) processed.`,
      );
      router.refresh();
    });
  }, [currentYear, router, todayManila]);

  const openDrawer = useCallback((action: ActionKind, row: LeaveRow) => {
    setActionError(null);
    setActionOk(null);
    setDrawer({ action, row });
  }, []);

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {actionError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {actionError}
        </p>
      ) : null}

      {actionOk ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {actionOk}
        </p>
      ) : null}

      {/* Top action row */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Year
          <select
            value={String(currentYear)}
            onChange={(e) => updateYear(e.target.value)}
            disabled={isPending}
            className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <p className="hidden text-xs text-[color:var(--color-brand-text-soft)] sm:block">
          {rows.length} {rows.length === 1 ? "employee" : "employees"}
        </p>

        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleApplyExpiry}
            disabled={isPending}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            Apply VL expiry
          </button>
          <button
            type="button"
            onClick={handleRunEntitlements}
            disabled={isPending}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95 disabled:opacity-50"
          >
            Run year-end entitlements
          </button>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3 text-right">VL</th>
              <th className="px-4 py-3 text-right">SL</th>
              <th className="px-4 py-3 text-right">Used (year)</th>
              <th className="px-4 py-3">Next expiry</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No active employees yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.employee_id}>
                  <td className="px-4 py-3 align-middle">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      {r.full_name}
                    </div>
                    {r.employee_number ? (
                      <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {r.employee_number}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-mono">
                    {formatDays(r.vl_balance)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-mono">
                    {formatDays(r.sl_balance)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-mono">
                    {formatDays(r.days_used_this_year)}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {formatDateOrDash(r.next_expiry_date)}
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <RowActions
                      row={r}
                      disabled={isPending}
                      onOpen={openDrawer}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No active employees yet.
          </p>
        ) : (
          rows.map((r) => (
            <div
              key={r.employee_id}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {r.full_name}
                  </div>
                  {r.employee_number ? (
                    <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.employee_number}
                    </div>
                  ) : null}
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-center text-xs">
                <div>
                  <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    VL
                  </dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-[color:var(--color-brand-navy)]">
                    {formatDays(r.vl_balance)}
                  </dd>
                </div>
                <div>
                  <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    SL
                  </dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-[color:var(--color-brand-navy)]">
                    {formatDays(r.sl_balance)}
                  </dd>
                </div>
                <div>
                  <dt className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Used
                  </dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-[color:var(--color-brand-navy)]">
                    {formatDays(r.days_used_this_year)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
                Next expiry:{" "}
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  {formatDateOrDash(r.next_expiry_date)}
                </span>
              </p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <RowActions
                  row={r}
                  disabled={isPending}
                  onOpen={openDrawer}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Per-row drawer */}
      {drawer ? (
        <ActionDrawer
          drawer={drawer}
          todayManila={todayManila}
          onClose={() => setDrawer(null)}
          onSuccess={() => {
            setDrawer(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// =============================================================================
// Row actions cluster
// =============================================================================

function RowActions({
  row,
  disabled,
  onOpen,
}: {
  row: LeaveRow;
  disabled: boolean;
  onOpen: (action: ActionKind, row: LeaveRow) => void;
}) {
  return (
    <div className="inline-flex flex-wrap justify-end gap-2">
      <button
        type="button"
        onClick={() => onOpen("grant", row)}
        disabled={disabled}
        className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        Add grant
      </button>
      <button
        type="button"
        onClick={() => onOpen("usage", row)}
        disabled={disabled}
        className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        Record usage
      </button>
      <button
        type="button"
        onClick={() => onOpen("cash", row)}
        disabled={disabled}
        className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
      >
        Cash conversion
      </button>
    </div>
  );
}

// =============================================================================
// Drawer (slide-out from right) — one component switches by drawer.action
// =============================================================================

interface DrawerProps {
  drawer: OpenDrawer;
  todayManila: string;
  onClose: () => void;
  onSuccess: () => void;
}

function ActionDrawer({
  drawer,
  todayManila,
  onClose,
  onSuccess,
}: DrawerProps) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true);

  // Body-scroll lock + ESC-to-close while the drawer is mounted.
  useEffect(() => {
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
  }, [onClose]);

  const title =
    drawer.action === "grant"
      ? "Add leave grant"
      : drawer.action === "usage"
        ? "Record leave usage"
        : "Record cash conversion";

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
        aria-labelledby="leave-action-title"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <div>
            <h2
              id="leave-action-title"
              className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
            >
              {title}
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
              {drawer.row.full_name}
              {drawer.row.employee_number ? (
                <span className="font-mono">
                  {" "}
                  · {drawer.row.employee_number}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] rounded-md text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Close
          </button>
        </div>

        {drawer.action === "grant" ? (
          <GrantForm
            employeeId={drawer.row.employee_id}
            todayManila={todayManila}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        ) : drawer.action === "usage" ? (
          <UsageForm
            employeeId={drawer.row.employee_id}
            todayManila={todayManila}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        ) : (
          <CashForm
            employeeId={drawer.row.employee_id}
            todayManila={todayManila}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Forms — one per action. All controlled inputs (React 19 form-action reset
// would otherwise drop values on the error re-render).
// =============================================================================

function GrantForm({
  employeeId,
  todayManila,
  onClose,
  onSuccess,
}: {
  employeeId: string;
  todayManila: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [kind, setKind] = useState<LeaveKind>("VL");
  const [days, setDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayManila);
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
      onSuccess();
    });
  };

  return (
    <FormShell
      isPending={isPending}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      confirmLabel="Add grant"
    >
      <Field label="Kind">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as LeaveKind)}
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
      <Field label="Reason">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="e.g. promotion, manual_adjustment"
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </Field>
    </FormShell>
  );
}

function UsageForm({
  employeeId,
  todayManila,
  onClose,
  onSuccess,
}: {
  employeeId: string;
  todayManila: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [kind, setKind] = useState<LeaveKind>("VL");
  const [days, setDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayManila);
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
      onSuccess();
    });
  };

  return (
    <FormShell
      isPending={isPending}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      confirmLabel="Record usage"
      footnote="This action is also reachable from the per-employee detail page."
    >
      <Field label="Kind">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as LeaveKind)}
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
      <Field label="Leave date">
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </Field>
      <Field label="Reason (optional)">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </Field>
    </FormShell>
  );
}

function CashForm({
  employeeId,
  todayManila,
  onClose,
  onSuccess,
}: {
  employeeId: string;
  todayManila: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [kind, setKind] = useState<LeaveKind>("VL");
  const [days, setDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayManila);
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
      onSuccess();
    });
  };

  return (
    <FormShell
      isPending={isPending}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      confirmLabel="Record cash conversion"
      footnote="Debits the leave balance and credits the next payroll period."
    >
      <Field label="Kind">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as LeaveKind)}
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
      <Field label="Reason (optional)">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </Field>
    </FormShell>
  );
}

// =============================================================================
// Form chrome shared by all three drawer flavours.
// =============================================================================

function FormShell({
  children,
  isPending,
  error,
  onClose,
  onSubmit,
  confirmLabel,
  footnote,
}: {
  children: React.ReactNode;
  isPending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  confirmLabel: string;
  footnote?: string;
}) {
  return (
    <>
      <div className="space-y-4 px-5 py-5">
        {children}
        {footnote ? (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {footnote}
          </p>
        ) : null}
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
          onClick={onSubmit}
          disabled={isPending}
          className="min-h-[44px] flex-1 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Saving..." : confirmLabel}
        </button>
      </div>
    </>
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
