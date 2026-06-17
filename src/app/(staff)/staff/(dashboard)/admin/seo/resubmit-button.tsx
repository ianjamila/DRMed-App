"use client";

import { useState, useTransition } from "react";
import { resubmitAllToIndexNowAction } from "./actions";

export function ResubmitIndexNowButton({ disabled }: { disabled?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function handleClick() {
    startTransition(async () => {
      const res = await resubmitAllToIndexNowAction();
      if (res.ok) {
        if (res.data.skipped === "disabled") {
          setResult("Submissions are disabled outside production — nothing was sent.");
        } else if (res.data.skipped === "no-urls") {
          setResult("No URLs to submit.");
        } else {
          setResult(`Submitted ${res.data.submitted} of ${res.data.total} URLs to IndexNow.`);
        }
      } else {
        setResult(`Error: ${res.error}`);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending || disabled}
        className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)] disabled:opacity-50"
      >
        {isPending ? "Submitting…" : "Re-submit all pages now"}
      </button>
      {result ? (
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">{result}</span>
      ) : null}
    </div>
  );
}
