"use client";

import { useState, useTransition } from "react";
import { recordHmoSettlementAction } from "../../../actions";
import { ActionModal } from "./action-modal";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

function todayManilaISODate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type SettlementItem = {
  id: string;
  service_name: string;
  billed_amount_php: number;
  paid_amount_php: number;
  patient_billed_amount_php: number;
  written_off_amount_php: number;
};

function unresolvedOf(it: SettlementItem): number {
  return (
    Number(it.billed_amount_php) -
    Number(it.paid_amount_php) -
    Number(it.patient_billed_amount_php) -
    Number(it.written_off_amount_php)
  );
}

export function RecordSettlementModal({
  open,
  onClose,
  batchId,
  items,
}: {
  open: boolean;
  onClose: () => void;
  batchId: string;
  items: SettlementItem[];
}) {
  return (
    <ActionModal
      open={open}
      onClose={onClose}
      title="Record HMO settlement"
      description="Records a payment per visit and allocates against the selected items."
      size="lg"
    >
      {open ? (
        <RecordSettlementModalInner
          onClose={onClose}
          batchId={batchId}
          items={items}
        />
      ) : null}
    </ActionModal>
  );
}

function RecordSettlementModalInner({
  onClose,
  batchId,
  items,
}: {
  onClose: () => void;
  batchId: string;
  items: SettlementItem[];
}) {
  const today = todayManilaISODate();
  const [totalAmount, setTotalAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [bankRef, setBankRef] = useState("");
  const [perItem, setPerItem] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      items.map((it) => {
        const u = unresolvedOf(it);
        return [it.id, u > 0 ? u.toFixed(2) : "0.00"];
      }),
    ),
  );
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sum = Object.values(perItem).reduce(
    (a, v) => a + (Number(v) || 0),
    0,
  );
  const total = Number(totalAmount) || 0;
  const sumMatches = total > 0 && Math.abs(sum - total) < 0.005;

  function onSave() {
    if (!total || total <= 0) {
      setErr("Total amount required.");
      return;
    }
    if (!sumMatches) {
      setErr(
        `Sum of per-item amounts (₱${sum.toFixed(2)}) must equal total (₱${total.toFixed(2)}).`,
      );
      return;
    }
    const itemList = items
      .map((it) => ({
        item_id: it.id,
        amount_php: Number(perItem[it.id]) || 0,
      }))
      .filter((it) => it.amount_php > 0);
    if (itemList.length === 0) {
      setErr("At least one item must have a positive amount.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const res = await recordHmoSettlementAction({
        batch_id: batchId,
        total_amount_php: total,
        payment_date: paymentDate,
        bank_reference: bankRef.trim() || null,
        items: itemList,
      });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      onClose();
    });
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="block text-sm">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            Total (₱)
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            Date
          </span>
          <input
            type="date"
            value={paymentDate}
            max={today}
            onChange={(e) => setPaymentDate(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            Bank reference
          </span>
          <input
            type="text"
            value={bankRef}
            onChange={(e) => setBankRef(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
          />
        </label>
      </div>
      <div className="mt-4 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)]">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-2">Service</th>
              <th className="px-4 py-2 text-right">Billed</th>
              <th className="px-4 py-2 text-right">Unresolved</th>
              <th className="px-4 py-2 text-right">Allocate</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const u = unresolvedOf(it);
              return (
                <tr
                  key={it.id}
                  className="border-t border-[color:var(--color-brand-bg-mid)]"
                >
                  <td className="px-4 py-2 text-xs">{it.service_name}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {PHP.format(Number(it.billed_amount_php))}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {PHP.format(u)}
                  </td>
                  <td className="px-4 py-2">
                    <label className="sr-only" htmlFor={`alloc-${it.id}`}>
                      Allocate for {it.service_name}
                    </label>
                    <input
                      id={`alloc-${it.id}`}
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={perItem[it.id] ?? ""}
                      onChange={(e) =>
                        setPerItem((p) => ({ ...p, [it.id]: e.target.value }))
                      }
                      className="min-h-[44px] w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 text-right font-mono text-xs"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)]">
              <td
                colSpan={3}
                className="px-4 py-2 text-right text-xs font-bold text-[color:var(--color-brand-navy)]"
              >
                Sum of allocations
              </td>
              <td
                className={
                  "px-4 py-2 text-right font-mono text-xs font-bold " +
                  (sumMatches
                    ? "text-[color:var(--color-brand-navy)]"
                    : "text-red-700")
                }
              >
                {PHP.format(sum)}
                {sumMatches ? "" : " ≠"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {err ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
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
          onClick={onSave}
          disabled={pending || !sumMatches}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Record settlement"}
        </button>
      </div>
    </div>
  );
}
