"use client";

import { useState, useTransition } from "react";
import { closeQuarterAction, reopenQuarterAction } from "./actions";

export function PeriodActionsClient({
  year,
  quarter,
  state,
  inFuture,
}: {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  state: "open" | "closed" | "mixed";
  inFuture: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [showReopenForm, setShowReopenForm] = useState(false);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  function onClose() {
    startTransition(async () => {
      setErr(null);
      const result = await closeQuarterAction(year, quarter, notes.trim() || null);
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setShowCloseForm(false);
      setNotes("");
    });
  }

  function onReopen() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await reopenQuarterAction(year, quarter, reason.trim());
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setShowReopenForm(false);
      setReason("");
    });
  }

  return (
    <div className="mt-3 space-y-2">
      {err ? <p className="text-xs text-red-600">{err}</p> : null}

      {state === "open" && !inFuture ? (
        showCloseForm ? (
          <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-2">
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Closing Q{quarter} {year} will reject any future postings dated within these months. Reversing entries posted to a later open period are still allowed.
            </p>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional close memo…"
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
              >
                {pending ? "Closing…" : "Confirm close"}
              </button>
              <button
                type="button"
                onClick={() => setShowCloseForm(false)}
                className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCloseForm(true)}
            className="min-h-[44px] w-full rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white"
          >
            Close quarter
          </button>
        )
      ) : null}

      {state === "open" && inFuture ? (
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Quarter still in progress — close becomes available after the last day of the quarter.
        </p>
      ) : null}

      {state === "closed" ? (
        showReopenForm ? (
          <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-2">
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Reopening Q{quarter} {year} unlocks all three months for new postings. Audit log captures the reason.
            </p>
            <textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required)…"
              className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onReopen}
                disabled={pending}
                className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
              >
                {pending ? "Reopening…" : "Confirm reopen"}
              </button>
              <button
                type="button"
                onClick={() => setShowReopenForm(false)}
                className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowReopenForm(true)}
            className="min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-bold uppercase tracking-wider"
          >
            Reopen quarter
          </button>
        )
      ) : null}

      {state === "mixed" ? (
        <p className="text-xs text-amber-700">
          Mixed state — some months closed, some open. Investigate before further action.
        </p>
      ) : null}
    </div>
  );
}
