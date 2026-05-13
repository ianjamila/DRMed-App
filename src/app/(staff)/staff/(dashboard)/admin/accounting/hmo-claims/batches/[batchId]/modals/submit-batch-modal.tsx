"use client";

import { useState, useTransition } from "react";
import { todayManilaISODate } from "@/lib/dates/manila";
import { submitBatchAction } from "../../../actions";
import { ActionModal } from "./action-modal";

type Medium = "mail" | "courier" | "email" | "portal" | "fax" | "in_person";

const MEDIUM_OPTIONS: { value: Medium; label: string }[] = [
  { value: "mail", label: "Mail" },
  { value: "courier", label: "Courier" },
  { value: "email", label: "Email" },
  { value: "portal", label: "Portal" },
  { value: "fax", label: "Fax" },
  { value: "in_person", label: "In person" },
];

export function SubmitBatchModal({
  open,
  onClose,
  batchId,
  defaultMedium = "mail",
  defaultReferenceNo = null,
}: {
  open: boolean;
  onClose: () => void;
  batchId: string;
  defaultMedium?: Medium;
  defaultReferenceNo?: string | null;
}) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Submit batch"
      description="Record how and when this batch was sent to the HMO."
    >
      {open ? (
        <SubmitBatchModalInner
          key={batchId}
          batchId={batchId}
          defaultMedium={defaultMedium}
          defaultReferenceNo={defaultReferenceNo}
          onClose={onClose}
        />
      ) : null}
    </ActionModal>
  );
}

function SubmitBatchModalInner({
  batchId,
  defaultMedium,
  defaultReferenceNo,
  onClose,
}: {
  batchId: string;
  defaultMedium: Medium;
  defaultReferenceNo: string | null;
  onClose: () => void;
}) {
  const today = todayManilaISODate();
  const [medium, setMedium] = useState<Medium>(defaultMedium);
  const [submittedAt, setSubmittedAt] = useState<string>(today);
  const [referenceNo, setReferenceNo] = useState<string>(
    defaultReferenceNo ?? "",
  );
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    if (!submittedAt) {
      setErr("Pick a submission date.");
      return;
    }
    if (submittedAt > today) {
      setErr("Submission date cannot be in the future.");
      return;
    }
    if (!medium) {
      setErr("Pick a submission medium.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const trimmed = referenceNo.trim();
      const res = await submitBatchAction({
        batch_id: batchId,
        submitted_at: submittedAt,
        medium,
        reference_no: trimmed.length > 0 ? trimmed : null,
      });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      onClose();
    });
  }

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Medium
        </legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MEDIUM_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-3 text-sm"
            >
              <input
                type="radio"
                name="medium"
                value={opt.value}
                checked={medium === opt.value}
                onChange={() => setMedium(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Submitted at
        </span>
        <input
          type="date"
          value={submittedAt}
          max={today}
          onChange={(e) => setSubmittedAt(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
        />
      </label>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Reference number{" "}
          <span className="font-normal text-[color:var(--color-brand-text-soft)]">
            (optional)
          </span>
        </span>
        <input
          type="text"
          value={referenceNo}
          onChange={(e) => setReferenceNo(e.target.value)}
          maxLength={64}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 font-mono"
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
          {pending ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  );
}
