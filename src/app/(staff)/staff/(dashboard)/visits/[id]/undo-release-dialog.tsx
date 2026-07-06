"use client";

import { useState, useTransition } from "react";
import { undoReleaseSelectedAction } from "./actions";

// Per-row "Undo" affordance for a released test — same inline-expand pattern
// as void-payment-dialog. Delegates to undoReleaseSelectedAction with a
// single-element selection so the reason requirement, section scoping,
// header exclusion and audit metadata stay in one code path with the bulk
// bar. Migration 0110's trigger handles the JE reversal + package cascade.
export function UndoReleaseDialog({
  testRequestId,
  visitId,
  viewedCount,
  size = "default",
}: {
  testRequestId: string;
  visitId: string;
  // How many times the patient already viewed/downloaded this result —
  // computed server-side by the visit page (countResultViews).
  viewedCount: number;
  // "compact" is used inside package-component rows, which are denser than
  // the standalone tests table.
  size?: "default" | "compact";
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const textCls = size === "compact" ? "text-[10px]" : "text-xs";

  function onConfirm() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await undoReleaseSelectedAction(visitId, [testRequestId], reason.trim());
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
        className={`${textCls} font-semibold text-[color:var(--color-brand-text-soft)] hover:underline`}
      >
        Undo
      </button>
    );
  }

  return (
    <div className="w-64 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        This result will be pulled from the patient portal and the release
        accounting reversed. Re-releasing later is allowed. Reason is
        audit-logged.
      </p>
      {viewedCount > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 font-semibold text-amber-800">
          Patient has already viewed/downloaded this result {viewedCount}{" "}
          {viewedCount === 1 ? "time" : "times"} — undoing does not un-see it.
        </p>
      ) : null}
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
          {pending ? "Undoing…" : "Confirm undo"}
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
