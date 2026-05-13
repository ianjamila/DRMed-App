"use client";

import { useState, useTransition } from "react";
import { createResolutionAction } from "../../../actions";
import { ActionModal } from "./action-modal";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export type ResolveItemTarget = {
  id: string;
  service_name: string;
  billed_amount_php: number;
  paid_amount_php: number;
  patient_billed_amount_php: number;
  written_off_amount_php: number;
};

function unresolvedOf(item: ResolveItemTarget): number {
  return (
    Number(item.billed_amount_php) -
    Number(item.paid_amount_php) -
    Number(item.patient_billed_amount_php) -
    Number(item.written_off_amount_php)
  );
}

export function ResolveItemModal({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: ResolveItemTarget | null;
}) {
  const isOpen = open && item !== null;
  const description = item
    ? `${item.service_name} · unresolved ${PHP.format(unresolvedOf(item))}`
    : undefined;
  return (
    <ActionModal
      open={isOpen}
      onClose={onClose}
      title="Resolve item"
      description={description}
    >
      {isOpen && item ? (
        <ResolveItemModalInner key={item.id} item={item} onClose={onClose} />
      ) : null}
    </ActionModal>
  );
}

function ResolveItemModalInner({
  item,
  onClose,
}: {
  item: ResolveItemTarget;
  onClose: () => void;
}) {
  const [destination, setDestination] = useState<"patient_bill" | "write_off">(
    "patient_bill",
  );
  const [amount, setAmount] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const unresolved = unresolvedOf(item);

  function onSave() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > unresolved + 0.005) {
      setErr(`Amount must be > 0 and ≤ ${PHP.format(unresolved)}.`);
      return;
    }
    startTransition(async () => {
      setErr(null);
      const res = await createResolutionAction({
        item_id: item.id,
        destination,
        amount_php: amt,
        notes: notes.trim() || null,
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
        <legend className="sr-only">Destination</legend>
        <div className="flex gap-3">
          <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-3 text-sm">
            <input
              type="radio"
              name="dest"
              value="patient_bill"
              checked={destination === "patient_bill"}
              onChange={() => setDestination("patient_bill")}
            />
            <span>Bill patient</span>
          </label>
          <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-[color:var(--color-brand-bg-mid)] p-3 text-sm">
            <input
              type="radio"
              name="dest"
              value="write_off"
              checked={destination === "write_off"}
              onChange={() => setDestination("write_off")}
            />
            <span>Write off</span>
          </label>
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          Amount (₱)
        </span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          max={unresolved}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
        />
      </label>
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
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
