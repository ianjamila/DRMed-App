"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "@/components/ui/panel";
import { voidPettyCashExpenseAction } from "./actions";
import { manilaTime } from "@/lib/dates/manila";

export interface PettyCashRow {
  /** `eod_cash_adjustments.id` — what the void acts on. */
  id: string;
  /** Everyday phrase for the category (from the contra account). */
  label: string;
  /** No expense account was chosen — the entry is parked in 9999 Suspense. */
  uncategorised: boolean;
  payee: string | null;
  note: string | null;
  amount_php: number;
  voided: boolean;
  recorded_at: string;
}

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export function PettyCashList({
  rows,
  isToday,
}: {
  rows: PettyCashRow[];
  isToday: boolean;
}) {
  const total = rows
    .filter((r) => !r.voided)
    .reduce((sum, r) => sum + r.amount_php, 0);
  const dayLabel = isToday ? "today" : "this day";

  if (rows.length === 0) {
    return (
      <Panel className="border-dashed p-6 text-sm text-[color:var(--color-brand-text-soft)]">
        No petty cash recorded {dayLabel} yet.
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <ul className="divide-y divide-[color:var(--color-brand-bg-mid)]">
        {rows.map((r) => (
          <PettyCashItem key={r.id} row={r} />
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg-soft)] px-4 py-3 text-sm">
        <span className="font-semibold text-[color:var(--color-brand-text-soft)]">
          Total taken from the till {dayLabel} (not counting voided)
        </span>
        <span className="font-mono font-bold text-[color:var(--color-brand-navy)]">
          {peso.format(total)}
        </span>
      </div>
    </Panel>
  );
}

function PettyCashItem({ row }: { row: PettyCashRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const voided = row.voided;
  const title = row.payee ? `${row.label} — ${row.payee}` : row.label;

  function submitVoid() {
    setErr(null);
    if (reason.trim().length < 3) {
      setErr("Give a short reason.");
      return;
    }
    startTransition(async () => {
      const r = await voidPettyCashExpenseAction(row.id, reason.trim());
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setConfirming(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className={`text-sm font-semibold ${
              voided
                ? "text-[color:var(--color-brand-text-soft)] line-through"
                : "text-[color:var(--color-brand-navy)]"
            }`}
          >
            {title}
          </p>
          <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
            {manilaTime(row.recorded_at)}
            {voided ? " · voided" : ""}
          </p>
          {row.uncategorised && !voided && (
            <p className="mt-1 text-xs font-semibold text-amber-800">
              No expense account picked — ask Admin to file this properly.
            </p>
          )}
          {row.note && (
            <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
              {row.note}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            className={`font-mono text-sm font-bold ${
              voided
                ? "text-[color:var(--color-brand-text-soft)] line-through"
                : "text-[color:var(--color-brand-navy)]"
            }`}
          >
            {peso.format(row.amount_php)}
          </span>
          {!voided && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 text-xs font-semibold text-red-700 hover:bg-red-50"
            >
              Void
            </button>
          )}
        </div>
      </div>

      {confirming && (
        <div className="mt-3 space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
          {err && (
            <p role="alert" className="text-xs text-red-900">
              {err}
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-red-900">
              Reason for void *
            </span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              autoFocus
              placeholder="e.g. wrong amount, duplicate"
              className="w-full rounded-md border border-red-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submitVoid}
              disabled={pending}
              className="min-h-[44px] rounded-md bg-red-700 px-3 text-xs font-bold uppercase tracking-wider text-white hover:bg-red-800 disabled:opacity-50"
            >
              {pending ? "Voiding…" : "Confirm void"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setReason("");
                setErr(null);
              }}
              disabled={pending}
              className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
