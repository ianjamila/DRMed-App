"use client";

import { useState, useTransition } from "react";
import { voidPaymentAction } from "./actions";

export function VoidPaymentDialog({
  paymentId,
  amountLabel,
}: {
  paymentId: string;
  amountLabel: string;
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
      const result = await voidPaymentAction(paymentId, reason.trim());
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
        Void
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        Voiding {amountLabel}. A reversal journal entry will post automatically.
        Reason is audit-logged.
      </p>
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
          {pending ? "Voiding…" : "Confirm void"}
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
