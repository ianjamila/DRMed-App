"use client";

import { useState, useTransition } from "react";
import { todayManilaISODate } from "@/lib/dates/manila";
import { bulkSetHmoResponseAction } from "../../../actions";
import { ActionModal } from "./action-modal";

type HmoResponse = "pending" | "paid" | "rejected" | "no_response";
type BulkScope = "pending_only" | "all";

const RESPONSE_OPTIONS: { value: HmoResponse; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Rejected" },
  { value: "no_response", label: "No response" },
];

const SCOPE_OPTIONS: { value: BulkScope; label: string }[] = [
  { value: "pending_only", label: "Pending only" },
  { value: "all", label: "All items" },
];

export function BulkSetHmoResponseModal({
  open,
  onClose,
  batchId,
}: {
  open: boolean;
  onClose: () => void;
  batchId: string;
}) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Set HMO response for items"
      description="Apply a single HMO response to many items at once."
    >
      {open ? (
        <BulkSetHmoResponseModalInner onClose={onClose} batchId={batchId} />
      ) : null}
    </ActionModal>
  );
}

function BulkSetHmoResponseModalInner({
  onClose,
  batchId,
}: {
  onClose: () => void;
  batchId: string;
}) {
  const today = todayManilaISODate();
  const [response, setResponse] = useState<HmoResponse>("paid");
  const [responseDate, setResponseDate] = useState<string>(today);
  const [scope, setScope] = useState<BulkScope>("pending_only");
  const [notes, setNotes] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ updated: number; skipped: number } | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      setErr(null);
      const res = await bulkSetHmoResponseAction({
        batch_id: batchId,
        response,
        response_date: responseDate,
        scope,
        notes: notes.trim() || null,
      });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      // An inactive (deleted/merged) patient's item is skipped rather than
      // failing the whole batch — surface that instead of silently closing,
      // same wording as the closures bulk reschedule's skip note.
      // items_skipped_inactive is the lifecycle-only count, never the
      // ordinary "pending only" scope miss.
      const skipped = res.data?.items_skipped_inactive ?? 0;
      if (skipped > 0) {
        setResult({ updated: res.data?.items_updated ?? 0, skipped });
        return;
      }
      onClose();
    });
  }

  if (result) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-[color:var(--color-brand-navy)]">
          Updated {result.updated} item(s).
        </p>
        <p className="text-sm text-amber-700">
          Skipped {result.skipped} item(s) on a deleted or merged patient —
          restore the record from Admin Tools › Deleted Patients to update
          those.
        </p>
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Response
        </legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {RESPONSE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-3 text-sm"
            >
              <input
                type="radio"
                name="response"
                value={opt.value}
                checked={response === opt.value}
                onChange={() => setResponse(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Response date
        </span>
        <input
          type="date"
          value={responseDate}
          max={today}
          onChange={(e) => setResponseDate(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
        />
      </label>
      <fieldset>
        <legend className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Scope
        </legend>
        <div className="mt-1 flex gap-2">
          {SCOPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-3 text-sm"
            >
              <input
                type="radio"
                name="scope"
                value={opt.value}
                checked={scope === opt.value}
                onChange={() => setScope(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1"
        />
      </label>
      {err ? (
        <p role="alert" className="text-sm text-red-700">
          {err}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
