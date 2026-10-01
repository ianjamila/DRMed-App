"use client";

import { useState, useTransition } from "react";
import { deleteSampleVisitAction, deleteSampleVisitFromQueueAction } from "./actions";

// Admin-only, shown when released results are the ONLY thing stopping a
// visit delete. Same inline-expand pattern as QueueDeleteDialog, plus a
// required "this was a sample visit" tick — un-releasing takes results away
// from a patient, so it must never be a one-click slip on a real visit.
//
// `source="queue"` is the Queue's row action on a sample visit's card (same
// confirmation, the queue server action, which also re-proves is_sample); the
// Queue does not know the released count, so its wording says "any".
export function DeleteSampleVisitDialog({
  visitId,
  visitNumber,
  releasedCount,
  source = "visit_page",
}: {
  visitId: string;
  visitNumber: string;
  releasedCount?: number;
  source?: "visit_page" | "queue";
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setOpen(false);
    setReason("");
    setConfirmed(false);
    setErr(null);
  }

  function onConfirm() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    if (!confirmed) {
      setErr("Tick the box to confirm this was a sample visit.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result =
        source === "queue"
          ? await deleteSampleVisitFromQueueAction(visitId, reason.trim())
          : await deleteSampleVisitAction(visitId, reason.trim());
      if (!result.ok) {
        startTransition(() => {
          setErr(result.error);
        });
        return;
      }
      reset();
    });
  }

  if (!open) {
    return (
      <span className="inline-flex max-w-[16rem] flex-col items-start text-xs">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-semibold text-red-700 hover:underline"
        >
          Delete sample visit{source === "queue" ? "…" : ""}
        </button>
        <span className="text-[color:var(--color-brand-text-soft)]">
          {source === "queue"
            ? "Sample visits only — un-releases any results."
            : "Has released results — only for a visit that was never real."}
        </span>
      </span>
    );
  }

  const results =
    releasedCount === undefined
      ? "released results (if any)"
      : `${releasedCount} released result${releasedCount === 1 ? "" : "s"}`;
  return (
    <div className="w-72 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        Delete visit #{visitNumber} as a sample visit. This first unreleases
        its {results} — the patient can no longer open them, and each one is
        listed in Undone Releases — then deletes the whole visit. The patient is
        not contacted. The visit can be restored later; the results stay
        unreleased. Reason is audit-logged.
      </p>
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)…"
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs"
      />
      <label className="flex items-start gap-2 text-[color:var(--color-brand-text-mid)]">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span>This was a sample or test visit, not a real patient visit.</span>
      </label>
      {err ? <p className="text-red-600">{err}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-red-700 px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Unrelease and delete"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
