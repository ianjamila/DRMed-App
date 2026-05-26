"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordMovement } from "../actions";

type MovementType = "receive" | "issue" | "adjust" | "expire" | "count";

const TYPE_OPTIONS: { value: MovementType; label: string; hint: string }[] = [
  { value: "receive", label: "Receive", hint: "Stock coming in (purchase, transfer)" },
  { value: "issue", label: "Issue", hint: "Stock going out (test consumed)" },
  { value: "adjust", label: "Adjust", hint: "Manual correction — quantity can be ±" },
  { value: "expire", label: "Expire", hint: "Pull expired stock from inventory" },
  { value: "count", label: "Count", hint: "Cycle-count delta (signed)" },
];

export function MovementForm({
  itemId,
  expiryTracking,
}: {
  itemId: string;
  expiryTracking: boolean;
}) {
  const router = useRouter();
  const [type, setType] = useState<MovementType>("receive");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const allowNegativeQty = type === "adjust" || type === "count";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty === 0) {
      setError("Quantity must be a non-zero number.");
      return;
    }
    if (!allowNegativeQty && qty < 0) {
      setError(`${type} expects a positive quantity (sign is applied automatically).`);
      return;
    }

    const payload = {
      item_id: itemId,
      movement_type: type,
      quantity: qty,
      unit_cost_php: unitCost ? Number(unitCost) : null,
      expiry_date: expiryDate || null,
      lot_number: lotNumber.trim() || null,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
    };

    startTransition(async () => {
      const r = await recordMovement(payload);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Reset for fast back-to-back entry.
      setQuantity("");
      setUnitCost("");
      setExpiryDate("");
      setLotNumber("");
      setReference("");
      setNotes("");
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
    >
      <div className="flex flex-wrap gap-2">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setType(opt.value)}
            className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              type === opt.value
                ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
            }`}
            title={opt.hint}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        {TYPE_OPTIONS.find((t) => t.value === type)?.hint}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Quantity {allowNegativeQty ? "(signed: + or −)" : "(positive)"}
          </span>
          <input
            type="number"
            step="0.01"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-right font-mono text-sm"
          />
        </label>

        {type === "receive" ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Unit cost (₱, optional)
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-right font-mono text-sm"
            />
          </label>
        ) : null}

        {(type === "receive" || type === "expire") && expiryTracking ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Expiry date
            </span>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
            />
          </label>
        ) : null}

        {type === "receive" ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Lot number (optional)
            </span>
            <input
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              maxLength={80}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Reference (PO number, test request, etc.)
          </span>
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={200}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Notes (optional)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={2000}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending || !quantity}
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)] disabled:cursor-not-allowed disabled:bg-[color:var(--color-brand-bg-mid)] disabled:text-[color:var(--color-brand-text-soft)]"
        >
          {pending ? "Recording…" : `Record ${type}`}
        </button>
      </div>
    </form>
  );
}
