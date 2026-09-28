"use client";

import { useState, useTransition } from "react";
import { formatPhp } from "@/lib/marketing/format";
import { waiveVisitBalanceAction } from "./actions";

export function WaiveBalanceDialog({
  visitId,
  balanceLabel,
  preview,
  legacy,
}: {
  visitId: string;
  balanceLabel: string;
  /** The discount split waiving this balance would post (0183). Null when the visit's lines don't add up. */
  preview: { labPhp: number; doctorPhp: number; lines: number } | null;
  /** An imported (legacy history) visit: waiving posts nothing to the books. */
  legacy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await waiveVisitBalanceAction(visitId, reason.trim());
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setOpen(false);
      setReason("");
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
      >
        Waive balance
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        Waiving {balanceLabel}. Marks this visit as waived (charity /
        no-charge — the patient owes nothing). Results become releasable
        without payment. Reason is audit-logged.
      </p>
      {legacy ? (
        <p className="text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waive-preview">
          Imported visit: the books never held this balance, so nothing is posted.
        </p>
      ) : preview ? (
        <p className="text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waive-preview">
          {formatPhp(preview.labPhp + preview.doctorPhp)} is recorded as a discount as each line is released
          (lines already released: now)
          {preview.doctorPhp > 0 && preview.labPhp > 0
            ? ` — ${formatPhp(preview.labPhp)} on lab tests and ${formatPhp(preview.doctorPhp)} on doctor fees`
            : preview.doctorPhp > 0
              ? " on doctor fees"
              : " on lab tests"}
          , across {preview.lines} line{preview.lines === 1 ? "" : "s"}, and the patient receivable is cleared.
          Nothing is collected. After this, payments and lines on the visit are fixed.
        </p>
      ) : (
        <p className="text-xs text-amber-800" data-testid="waive-preview">
          This visit&apos;s lines do not add up to its total; fix the lines before waiving.
        </p>
      )}
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)…"
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
      />
      {err ? <p className="text-red-600">{err}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Waiving…" : "Confirm waive"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setReason("");
            setErr(null);
          }}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
