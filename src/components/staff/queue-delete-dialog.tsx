"use client";

import { useState, useTransition } from "react";
import {
  deleteVisitAction,
  deleteTestRequestsAction,
  restoreVisitAction,
  restoreTestRequestsAction,
} from "@/lib/actions/visits/queue-deletion";

// Inline-expand confirm for queue-entry delete/restore — same pattern as
// UndoReleaseDialog / void-payment-dialog: a text button that expands into a
// bordered box with explanation, required reason, confirm + cancel. Shared by
// the reception queue (visit level), the lab queue and the visit detail page
// (test level). The 0125 triggers enforce the unpaid-only rule server-side;
// callers decide visibility with visitDeletability/testDeletability.
export function QueueDeleteDialog({
  visitId,
  testRequestIds,
  mode,
  entryLabel,
  size = "default",
}: {
  visitId: string;
  // Omitted = the whole visit; present = these tests (a package header id
  // deletes/restores its whole package via the DB cascade).
  testRequestIds?: string[];
  mode: "delete" | "restore";
  // What the confirm copy calls the thing, e.g. "this visit",
  // "CBC (Complete Blood Count)", "this chemistry panel".
  entryLabel: string;
  size?: "default" | "compact";
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isDelete = mode === "delete";
  const textCls = size === "compact" ? "text-[10px]" : "text-xs";

  function onConfirm() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const trimmed = reason.trim();
      const result = testRequestIds
        ? isDelete
          ? await deleteTestRequestsAction(visitId, testRequestIds, trimmed)
          : await restoreTestRequestsAction(visitId, testRequestIds, trimmed)
        : isDelete
          ? await deleteVisitAction(visitId, trimmed)
          : await restoreVisitAction(visitId, trimmed);
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
        className={`${textCls} font-semibold ${
          isDelete
            ? "text-red-700 hover:underline"
            : "text-[color:var(--color-brand-text-soft)] hover:underline"
        }`}
      >
        {isDelete ? "Delete" : "Restore"}
      </button>
    );
  }

  return (
    <div className="w-64 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
      <p className="text-[color:var(--color-brand-text-mid)]">
        {isDelete ? (
          <>
            Remove {entryLabel} from the queue. Nothing is billed for a
            deleted entry, it can be restored later, and the reason is
            audit-logged.
          </>
        ) : (
          <>
            Put {entryLabel} back in the queue and on the bill. Reason is
            audit-logged.
          </>
        )}
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
          className={`min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50 ${
            isDelete ? "bg-red-700" : "bg-[color:var(--color-brand-navy)]"
          }`}
        >
          {pending
            ? isDelete
              ? "Deleting…"
              : "Restoring…"
            : isDelete
              ? "Confirm delete"
              : "Confirm restore"}
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
