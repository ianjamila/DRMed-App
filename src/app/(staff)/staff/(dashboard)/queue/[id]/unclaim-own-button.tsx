"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unclaimOwnTestAction } from "../actions";

// Self-service counterpart of the admin ReassignPanel's Unclaim: lets the staff
// member who holds this claim hand it back to the queue. Same confirm +
// optional-reason shape so the two read as one feature.
export function UnclaimOwnButton({ testRequestId }: { testRequestId: string }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onUnclaim() {
    startTransition(async () => {
      setErr(null);
      const result = await unclaimOwnTestAction(testRequestId, reason.trim());
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setConfirmOpen(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3 text-xs">
      <p className="font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Your claim
      </p>

      {!confirmOpen ? (
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        >
          Unclaim — put it back in the queue
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2">
          <p className="text-[color:var(--color-brand-text-mid)]">
            Unclaiming puts this test back in the queue for anyone in the
            section to claim. Only possible while no result has been uploaded.
            The action is audit-logged.
          </p>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)…"
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onUnclaim}
              disabled={pending}
              className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {pending ? "Unclaiming…" : "Confirm unclaim"}
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
        </div>
      )}

      {err ? <p className="text-red-600">{err}</p> : null}
    </div>
  );
}
