"use client";

import { useState, useTransition } from "react";
import { acknowledgeBatchAction } from "../../../actions";
import { ActionModal } from "./action-modal";

export function AcknowledgeBatchModal({
  open,
  onClose,
  batchId,
  defaultAckRef = null,
}: {
  open: boolean;
  onClose: () => void;
  batchId: string;
  defaultAckRef?: string | null;
}) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Acknowledge batch"
      description="Record that the HMO confirmed receipt of this batch. Their acknowledgment reference goes below if they gave one."
    >
      {open ? (
        <AcknowledgeBatchModalInner
          key={batchId}
          batchId={batchId}
          defaultAckRef={defaultAckRef}
          onClose={onClose}
        />
      ) : null}
    </ActionModal>
  );
}

function AcknowledgeBatchModalInner({
  batchId,
  defaultAckRef,
  onClose,
}: {
  batchId: string;
  defaultAckRef: string | null;
  onClose: () => void;
}) {
  const [ackRef, setAckRef] = useState<string>(defaultAckRef ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      setErr(null);
      const trimmed = ackRef.trim();
      const res = await acknowledgeBatchAction({
        batch_id: batchId,
        hmo_ack_ref: trimmed.length > 0 ? trimmed : null,
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
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          HMO acknowledgment reference{" "}
          <span className="font-normal text-[color:var(--color-brand-text-soft)]">
            (optional)
          </span>
        </span>
        <input
          type="text"
          value={ackRef}
          onChange={(e) => setAckRef(e.target.value)}
          maxLength={128}
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
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
