"use client";

import { useState, useTransition } from "react";
import { setVisitSampleAction } from "@/lib/actions/visits/sample";

// Mark / unmark a visit as a sample (0181). Inline confirm, like the other
// visit-page actions; the server re-checks the role and audit-logs it.
export function SampleToggle({
  visitId,
  isSample,
}: {
  visitId: string;
  isSample: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      setErr(null);
      const result = await setVisitSampleAction(visitId, !isSample);
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:text-[color:var(--color-brand-navy)] hover:underline"
      >
        {isSample ? "Not a sample" : "Mark as sample"}
      </button>
    );
  }

  return (
    <div className="w-72 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        {isSample ? (
          <>
            Treat this as a real patient visit again. From now on, result and
            statement emails go to the patient as usual.
          </>
        ) : (
          <>
            Mark this as a sample (training or testing) visit. It is labelled
            “Sample” everywhere and the patient is never emailed or texted
            about it. It still counts like any visit until you delete it.
          </>
        )}
      </p>
      {err ? <p className="text-red-600">{err}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : isSample ? "Not a sample" : "Mark as sample"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
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
