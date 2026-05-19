"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import { formatManilaDate } from "@/lib/payroll/format";
import {
  createOtSlipAction,
  approveOtSlipAction,
  rejectOtSlipAction,
  voidOtSlipAction,
} from "../config/actions";

// =============================================================================
// Prop shapes
// =============================================================================

export type StatusFilter = "all" | "pending" | "approved" | "rejected" | "voided";

export interface EmployeeOption {
  id: string;
  full_name: string;
  employee_number: string | null;
}

export interface OtSlipRow {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_number: string | null;
  work_date: string;
  hours_requested: number;
  reason: string | null;
  status: string; // 'pending' | 'approved' | 'rejected' | 'voided'
  requested_at: string;
  decided_at: string | null;
  decision_notes: string | null;
  decided_by_name: string | null;
}

interface Props {
  slips: OtSlipRow[];
  employees: EmployeeOption[];
  currentStatus: StatusFilter;
  currentEmployee: string;
  dateFrom: string;
  dateTo: string;
  defaultWorkDate: string;
  error: string | null;
}

// =============================================================================
// Date helpers
// =============================================================================

const TS_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTs(iso: string | null): string {
  if (!iso) return "-";
  return TS_FMT.format(new Date(iso));
}

// =============================================================================
// Main client
// =============================================================================

const ROUTE = "/staff/admin/payroll/ot-slips";

export function OtSlipsClient({
  slips,
  employees,
  currentStatus,
  currentEmployee,
  dateFrom,
  dateTo,
  defaultWorkDate,
  error,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Inline error surface for approve/reject/void. Cleared on next success and
  // whenever filters change so it doesn't linger across unrelated actions.
  const [actionError, setActionError] = useState<string | null>(null);
  // Reason-prompt modal for reject + void.
  const [reasonPrompt, setReasonPrompt] = useState<{
    kind: "reject" | "void";
    slipId: string;
  } | null>(null);

  // Guards against state updates after unmount (e.g. user closes modal while
  // a transition is still pending).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      // Sentinels that mean "default": status=all and employee=all both drop.
      if ((key === "status" || key === "employee") && value === "all") {
        next.delete(key);
      } else if (!value) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      const qs = next.toString();
      const target = qs ? `${ROUTE}?${qs}` : ROUTE;
      setActionError(null);
      startTransition(() => {
        router.replace(target);
      });
    },
    [router, searchParams],
  );

  const handleApprove = useCallback(
    (slipId: string) => {
      startTransition(async () => {
        const result = await approveOtSlipAction(slipId);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setActionError(null);
        router.refresh();
      });
    },
    [router],
  );

  const handleReject = useCallback(
    (slipId: string, reason: string) => {
      startTransition(async () => {
        const result = await rejectOtSlipAction(slipId, reason);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setActionError(null);
        if (mountedRef.current) {
          setReasonPrompt(null);
        }
        router.refresh();
      });
    },
    [router],
  );

  const handleVoid = useCallback(
    (slipId: string) => {
      startTransition(async () => {
        const result = await voidOtSlipAction(slipId);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setActionError(null);
        if (mountedRef.current) {
          setReasonPrompt(null);
        }
        router.refresh();
      });
    },
    [router],
  );

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

      {/* Filter strip */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Status
          <select
            value={currentStatus}
            onChange={(e) => updateParam("status", e.target.value)}
            disabled={isPending}
            className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="voided">Voided</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Employee
          <select
            value={currentEmployee || "all"}
            onChange={(e) => updateParam("employee", e.target.value)}
            disabled={isPending}
            className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            <option value="all">All</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
                {e.employee_number ? ` (${e.employee_number})` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          From
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => updateParam("date_from", e.target.value)}
            disabled={isPending}
            className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          To
          <input
            type="date"
            value={dateTo}
            onChange={(e) => updateParam("date_to", e.target.value)}
            disabled={isPending}
            className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-normal normal-case text-[color:var(--color-brand-navy)] focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          />
        </label>

        <p className="hidden text-xs text-[color:var(--color-brand-text-soft)] sm:block">
          {slips.length} {slips.length === 1 ? "slip" : "slips"}
        </p>

        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          disabled={employees.length === 0}
          className="ml-auto min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95 disabled:opacity-50"
        >
          + Request OT slip
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[1080px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Work date</th>
              <th className="px-4 py-3 text-right">Hours</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Decided</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {slips.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No OT slips match your filters.
                </td>
              </tr>
            ) : (
              slips.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 align-middle">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">
                      {s.employee_name}
                    </div>
                    {s.employee_number ? (
                      <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {s.employee_number}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {formatManilaDate(s.work_date)}
                  </td>
                  <td className="px-4 py-3 text-right align-middle font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                    {s.hours_requested.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {s.reason ?? (
                      <span className="text-[color:var(--color-brand-text-soft)]">
                        -
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <SlipStatusPill status={s.status} />
                  </td>
                  <td className="px-4 py-3 align-middle text-xs">
                    {s.decided_at ? (
                      <>
                        <div className="font-semibold text-[color:var(--color-brand-navy)]">
                          {s.decided_by_name ?? "(unknown)"}
                        </div>
                        <div className="text-[color:var(--color-brand-text-soft)]">
                          {formatTs(s.decided_at)}
                        </div>
                      </>
                    ) : (
                      <span className="text-[color:var(--color-brand-text-soft)]">
                        -
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <SlipActions
                      status={s.status}
                      disabled={isPending}
                      onApprove={() => handleApprove(s.id)}
                      onReject={() =>
                        setReasonPrompt({ kind: "reject", slipId: s.id })
                      }
                      onVoid={() =>
                        setReasonPrompt({ kind: "void", slipId: s.id })
                      }
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
        {slips.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No OT slips match your filters.
          </p>
        ) : (
          slips.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {s.employee_name}
                  </div>
                  <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {formatManilaDate(s.work_date)} - {s.hours_requested.toFixed(2)}h
                  </div>
                </div>
                <SlipStatusPill status={s.status} />
              </div>
              {s.reason ? (
                <p className="mt-2 text-xs text-[color:var(--color-brand-text-mid)]">
                  {s.reason}
                </p>
              ) : null}
              {s.decided_at ? (
                <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
                  Decided by {s.decided_by_name ?? "(unknown)"} on{" "}
                  {formatTs(s.decided_at)}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <SlipActions
                  status={s.status}
                  disabled={isPending}
                  onApprove={() => handleApprove(s.id)}
                  onReject={() =>
                    setReasonPrompt({ kind: "reject", slipId: s.id })
                  }
                  onVoid={() =>
                    setReasonPrompt({ kind: "void", slipId: s.id })
                  }
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Reason prompt */}
      {reasonPrompt ? (
        <ReasonPrompt
          kind={reasonPrompt.kind}
          isPending={isPending}
          onCancel={() => setReasonPrompt(null)}
          onConfirm={(reason) => {
            if (reasonPrompt.kind === "reject") {
              // reject path always provides a non-null trimmed reason.
              handleReject(reasonPrompt.slipId, reason ?? "");
            } else {
              // Void action doesn't accept a reason; we just confirm intent.
              handleVoid(reasonPrompt.slipId);
            }
          }}
        />
      ) : null}

      {/* Request drawer */}
      <RequestOtSlipDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        employees={employees}
        defaultWorkDate={defaultWorkDate}
        onCreated={() => {
          setDrawerOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

// =============================================================================
// Status pill
// =============================================================================

function SlipStatusPill({ status }: { status: string }) {
  let cls = "bg-slate-200 text-slate-700";
  if (status === "pending") cls = "bg-amber-100 text-amber-900";
  else if (status === "approved") cls = "bg-emerald-100 text-emerald-900";
  else if (status === "rejected") cls = "bg-rose-100 text-rose-900";
  else if (status === "voided") cls = "bg-slate-200 text-slate-700";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}

// =============================================================================
// Per-row actions
// =============================================================================

function SlipActions({
  status,
  disabled,
  onApprove,
  onReject,
  onVoid,
}: {
  status: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  onVoid: () => void;
}) {
  if (status === "pending") {
    return (
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="min-h-[44px] rounded-md bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={disabled}
          className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    );
  }
  if (status === "approved") {
    return (
      <button
        type="button"
        onClick={onVoid}
        disabled={disabled}
        className="min-h-[44px] rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:border-rose-600 disabled:opacity-50"
      >
        Void
      </button>
    );
  }
  return (
    <span className="text-xs text-[color:var(--color-brand-text-soft)]">-</span>
  );
}

// =============================================================================
// Reason prompt modal
// =============================================================================

interface ReasonPromptProps {
  kind: "reject" | "void";
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void;
}

function ReasonPrompt({
  kind,
  isPending,
  onCancel,
  onConfirm,
}: ReasonPromptProps) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  const submit = () => {
    setError(null);
    if (kind === "reject") {
      const trimmed = reason.trim();
      if (trimmed.length === 0) {
        setError("Reason is required.");
        return;
      }
      onConfirm(trimmed);
      return;
    }
    // Void doesn't carry a reason; this is just a confirmation step.
    onConfirm(null);
  };

  const title = kind === "reject" ? "Reject OT slip" : "Void OT slip";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reason-prompt-title"
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onCancel}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
      >
        <h2
          id="reason-prompt-title"
          className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
        >
          {title}
        </h2>
        {kind === "reject" ? (
          <>
            <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
              Tell the employee why this OT request is being rejected. Required.
            </p>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Reason
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={500}
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                placeholder="e.g. Not enough notice."
              />
            </label>
          </>
        ) : (
          <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
            Voiding will retract this OT slip. This cannot be undone.
          </p>
        )}
        {error ? (
          <p className="mt-2 text-sm text-red-700">{error}</p>
        ) : null}
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="min-h-[44px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="min-h-[44px] flex-1 rounded-md bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {isPending
              ? "Working..."
              : kind === "reject"
                ? "Reject"
                : "Void"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Request drawer
// =============================================================================

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  employees: EmployeeOption[];
  defaultWorkDate: string;
  onCreated: () => void;
}

function RequestOtSlipDrawer({
  open,
  onClose,
  employees,
  defaultWorkDate,
  onCreated,
}: DrawerProps) {
  const [employeeId, setEmployeeId] = useState("");
  const [workDate, setWorkDate] = useState(defaultWorkDate);
  const [hoursRequested, setHoursRequested] = useState("1.00");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  // Lock body scroll while the drawer is open.
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

  // Reset the date back to today's default whenever the drawer is opened.
  useEffect(() => {
    if (open) {
      setWorkDate(defaultWorkDate);
    }
  }, [open, defaultWorkDate]);

  if (!open) return null;

  const submit = () => {
    setError(null);
    if (!employeeId) {
      setError("Pick an employee.");
      return;
    }
    if (!workDate) {
      setError("Pick a work date.");
      return;
    }
    const hoursN = Number(hoursRequested);
    if (!Number.isFinite(hoursN) || hoursN < 0.25 || hoursN > 12) {
      setError("Hours must be between 0.25 and 12.");
      return;
    }
    startTransition(async () => {
      const result = await createOtSlipAction({
        employee_id: employeeId,
        work_date: workDate,
        hours_requested: hoursN,
        reason: reason.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Reset and notify parent.
      setEmployeeId("");
      setWorkDate(defaultWorkDate);
      setHoursRequested("1.00");
      setReason("");
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
        aria-labelledby="request-ot-title"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] bg-white px-5 py-4">
          <h2
            id="request-ot-title"
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
          >
            Request OT slip
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
          <Field label="Employee">
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">Pick an employee...</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                  {e.employee_number ? ` (${e.employee_number})` : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Work date">
            <input
              type="date"
              value={workDate}
              onChange={(e) => setWorkDate(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>

          <Field label="Hours requested">
            <input
              type="number"
              inputMode="decimal"
              step="0.25"
              min="0.25"
              max="12"
              value={hoursRequested}
              onChange={(e) => setHoursRequested(e.target.value)}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
            <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
              Between 0.25 and 12 hours.
            </p>
          </Field>

          <Field label="Reason (optional)">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              placeholder="e.g. Covered evening shift."
            />
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
            {isPending ? "Saving..." : "Request"}
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
