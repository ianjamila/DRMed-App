"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryPatientNoticeAction } from "./actions";

// 0188: re-send a patient notice that failed with a send error. The outcome
// is shown as a banner at the top of the list (?retried=<outcome>, rendered
// by page.tsx) rather than here, because a successful retry takes this row
// off the list — and this button with it — as soon as the page re-renders.
export function RetryNoticeButton({ amendmentId, showingAll }: { amendmentId: string; showingAll: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onRetry() {
    startTransition(async () => {
      setErr(null);
      const result = await retryPatientNoticeAction(amendmentId);
      if (!result.ok) {
        startTransition(() => {
          setErr(result.error);
        });
        return;
      }
      const qs = new URLSearchParams({ retried: result.data.outcome });
      if (showingAll) qs.set("all", "1");
      router.replace(`/staff/result-follow-ups?${qs.toString()}`);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onRetry}
        disabled={pending}
        className="min-h-[44px] rounded-md border border-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)] disabled:opacity-50"
      >
        {pending ? "Sending…" : "Retry notice"}
      </button>
      {err ? (
        <p role="alert" className="text-xs text-red-600">
          {err}
        </p>
      ) : null}
    </div>
  );
}
