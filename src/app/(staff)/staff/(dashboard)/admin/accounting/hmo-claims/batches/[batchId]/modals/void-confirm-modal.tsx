"use client";

import { useState, useTransition } from "react";
import { ActionModal } from "./action-modal";

export type VoidConfirmResult = { ok: true } | { ok: false; error: string };

export function VoidConfirmModal({
  open,
  onClose,
  title,
  description,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  onConfirm: (reason: string) => Promise<VoidConfirmResult>;
}) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
    >
      {open ? (
        <VoidConfirmModalInner onClose={onClose} onConfirm={onConfirm} />
      ) : null}
    </ActionModal>
  );
}

function VoidConfirmModalInner({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => Promise<VoidConfirmResult>;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit() {
    if (reason.trim().length < 5) {
      setErr("Reason must be at least 5 characters.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const res = await onConfirm(reason.trim());
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      onClose();
    });
  }

  return (
    <div>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Reason
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1"
        />
      </label>
      {err ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {err}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-red-700 px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Voiding…" : "Void"}
        </button>
      </div>
    </div>
  );
}
