"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryReleaseNoticeAction } from "./actions";

// 0210/0212: admin's manual Retry for a "result ready" message the sender gave
// up on. A successful retry takes the row off the abandoned list as the page
// re-renders, so — like RetryNoticeButton — the outcome travels in the URL to a
// banner at the top of the page (?noticeRetried=1, rendered by page.tsx).
export function RetryReleaseNoticeButton({ noticeId, showingAll }: { noticeId: string; showingAll: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onRetry() {
    startTransition(async () => {
      setErr(null);
      const result = await retryReleaseNoticeAction(noticeId);
      if (!result.ok) {
        startTransition(() => {
          setErr(result.error);
        });
        return;
      }
      const qs = new URLSearchParams({ noticeRetried: "1" });
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
        {pending ? "Queuing…" : "Retry sending"}
      </button>
      {err ? (
        <p role="alert" className="text-xs text-red-600">
          {err}
        </p>
      ) : null}
    </div>
  );
}
