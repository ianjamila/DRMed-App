"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unclaimFromQueueAction } from "./actions";

// The queue LIST's Unclaim — same confirm + optional-reason shape as the
// detail page's UnclaimOwnButton / ReassignPanel so the three read as one
// feature. Takes every member id so a consolidated chemistry card hands back
// its whole panel at once. The server action decides whose claim the caller
// may release (admin: anyone's; everyone else: their own).
export function QueueUnclaimButton({
  testRequestIds,
  entryLabel,
}: {
  testRequestIds: string[];
  entryLabel: string;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onUnclaim() {
    startTransition(async () => {
      setErr(null);
      const result = await unclaimFromQueueAction({
        testRequestIds,
        reason: reason.trim() || undefined,
      });
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setConfirmOpen(false);
      setReason("");
      router.refresh();
    });
  }

  if (!confirmOpen) {
    return (
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        aria-label={`Unclaim ${entryLabel}`}
      >
        Unclaim
      </button>
    );
  }

  return (
    <div className="ml-auto mt-1.5 w-56 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-left text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        Put this back in the queue for anyone in the section to claim. Only
        possible while no result has been uploaded.
      </p>
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)…"
        maxLength={500}
        aria-label="Reason for unclaiming"
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onUnclaim}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Unclaiming…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirmOpen(false);
            setReason("");
            setErr(null);
          }}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
      {err ? (
        <p role="alert" className="text-red-600">
          {err}
        </p>
      ) : null}
    </div>
  );
}
