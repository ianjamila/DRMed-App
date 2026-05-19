"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useFocusTrap } from "@/lib/a11y/use-focus-trap";
import { formatPeriodRange } from "@/lib/payroll/format";
import {
  closePeriodAction,
  createPeriodAction,
} from "../runs/actions";

export interface PeriodRow {
  id: string;
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD
  status: string; // 'open' | 'closed'
  created_at: string; // ISO timestamp
}

export type RunByPeriod = Record<string, { id: string; status: string }>;

interface Props {
  periods: PeriodRow[];
  runByPeriod: RunByPeriod;
  defaultStart: string;
  defaultEnd: string;
  error?: string | null;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export function PeriodsClient({
  periods,
  runByPeriod,
  defaultStart,
  defaultEnd,
  error,
}: Props) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Track per-row pending state so the right button shows the spinner.
  const [closingId, setClosingId] = useState<string | null>(null);
  const [isClosePending, startCloseTransition] = useTransition();

  const handleClose = useCallback(
    (periodId: string) => {
      if (
        !window.confirm(
          "Close period? This locks dates for further runs.",
        )
      ) {
        return;
      }
      setClosingId(periodId);
      startCloseTransition(async () => {
        const result = await closePeriodAction(periodId);
        setClosingId(null);
        if (!result.ok) {
          window.alert(result.error);
          return;
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
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          {periods.length} {periods.length === 1 ? "period" : "periods"}
        </p>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="ml-auto min-h-[44px] rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-bold text-white hover:brightness-95"
        >
          + Create next period
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-[color:var(--color-bg-mid)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Period</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Run</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {periods.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No pay periods yet. Click &ldquo;Create next period&rdquo; to
                  get started.
                </td>
              </tr>
            ) : (
              periods.map((p) => {
                const run = runByPeriod[p.id];
                const canClose =
                  p.status === "open" && run?.status === "finalised";
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-3 align-middle font-semibold text-[color:var(--color-brand-navy)]">
                      {formatPeriodRange(p.period_start, p.period_end)}
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <PeriodStatusPill status={p.status} />
                    </td>
                    <td className="px-4 py-3 align-middle text-sm">
                      {run ? (
                        <Link
                          href={`/staff/admin/payroll/runs/${run.id}`}
                          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          View run -{">"}
                        </Link>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-middle text-xs text-[color:var(--color-brand-text-soft)]">
                      {formatRelative(p.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle">
                      {canClose ? (
                        <button
                          type="button"
                          onClick={() => handleClose(p.id)}
                          disabled={isClosePending && closingId === p.id}
                          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
                        >
                          {isClosePending && closingId === p.id
                            ? "Closing…"
                            : "Close"}
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

      {/* Mobile stacked cards */}
      <div className="space-y-3 md:hidden">
        {periods.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No pay periods yet.
          </p>
        ) : (
          periods.map((p) => {
            const run = runByPeriod[p.id];
            const canClose =
              p.status === "open" && run?.status === "finalised";
            return (
              <div
                key={p.id}
                className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {formatPeriodRange(p.period_start, p.period_end)}
                  </div>
                  <PeriodStatusPill status={p.status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-[color:var(--color-brand-text-soft)]">
                    Run
                  </dt>
                  <dd className="text-right">
                    {run ? (
                      <Link
                        href={`/staff/admin/payroll/runs/${run.id}`}
                        className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        View -{">"}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt className="text-[color:var(--color-brand-text-soft)]">
                    Created
                  </dt>
                  <dd className="text-right">{formatRelative(p.created_at)}</dd>
                </dl>
                {canClose ? (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => handleClose(p.id)}
                      disabled={isClosePending && closingId === p.id}
                      className="min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
                    >
                      {isClosePending && closingId === p.id
                        ? "Closing…"
                        : "Close"}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* `key` remounts the dialog each time it opens so the `useState`
          initialisers re-run with fresh defaults. This replaces a useEffect
          that called setState to re-prime the fields on open. */}
      <CreatePeriodDialog
        key={dialogOpen ? `open-${defaultStart}-${defaultEnd}` : "closed"}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        defaultStart={defaultStart}
        defaultEnd={defaultEnd}
        onCreated={() => {
          setDialogOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function PeriodStatusPill({ status }: { status: string }) {
  if (status === "open") {
    return (
      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-900">
        Open
      </span>
    );
  }
  if (status === "closed") {
    return (
      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
        Closed
      </span>
    );
  }
  return (
    <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-700">
      {status}
    </span>
  );
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  defaultStart: string;
  defaultEnd: string;
  onCreated: () => void;
}

function CreatePeriodDialog({
  open,
  onClose,
  defaultStart,
  defaultEnd,
  onCreated,
}: DialogProps) {
  const [periodStart, setPeriodStart] = useState(defaultStart);
  const [periodEnd, setPeriodEnd] = useState(defaultEnd);
  // pay_date is required by CreatePeriodSchema and constrained to >= period_end
  // at the DB level. Default to the end-of-period and let the admin nudge it.
  const [payDate, setPayDate] = useState(defaultEnd);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  // Field reset on open is handled by the parent passing a `key` that changes
  // whenever the dialog opens, which remounts this component and re-runs the
  // useState initialisers above. No reset effect needed.

  // Lock body scroll + Escape-to-close while the dialog is open.
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

  // Keep pay_date >= period_end as a UX nicety. If the admin shrinks
  // period_end below pay_date the action will still validate via the DB CHECK.
  const minPayDate = useMemo(() => periodEnd, [periodEnd]);

  if (!open) return null;

  const submit = () => {
    setError(null);
    if (!periodStart || !periodEnd || !payDate) {
      setError("Period start, period end, and pay date are all required.");
      return;
    }
    if (periodEnd < periodStart) {
      setError("Period end cannot be before period start.");
      return;
    }
    if (payDate < periodEnd) {
      setError("Pay date must be on or after period end.");
      return;
    }
    startTransition(async () => {
      const result = await createPeriodAction({
        period_start: periodStart,
        period_end: periodEnd,
        pay_date: payDate,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-period-title"
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-[color:var(--color-brand-navy)]/40 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <h2
            id="create-period-title"
            className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
          >
            Create next period
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
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Period start
            </span>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => {
                const v = e.target.value;
                setPeriodStart(v);
                // Defensive: if the admin pushes period_start past the current
                // period_end, drag period_end (and pay_date) along so the form
                // can never enter the "end < start" invalid state.
                setPeriodEnd((end) => (end < v ? v : end));
                setPayDate((d) => (d < v ? v : d));
              }}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Period end
            </span>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => {
                const v = e.target.value;
                setPeriodEnd(v);
                // pay_date must be >= period_end; if the admin edits period_end
                // forward we drag pay_date with it so the action doesn't reject
                // a now-stale pay_date.
                setPayDate((d) => (d < v ? v : d));
              }}
              min={periodStart}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Pay date
            </span>
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              min={minPayDate}
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
            <span className="mt-1 block text-xs text-[color:var(--color-brand-text-soft)]">
              Must be on or after period end.
            </span>
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
        <div className="flex gap-3 border-t border-[color:var(--color-brand-bg-mid)] px-5 py-4">
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
            {isPending ? "Creating…" : "Create period"}
          </button>
        </div>
      </div>
    </div>
  );
}
