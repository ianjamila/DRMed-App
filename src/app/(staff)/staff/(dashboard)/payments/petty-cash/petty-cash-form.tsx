"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "@/components/ui/panel";
import {
  PETTY_CASH_CATEGORY_OPTIONS,
  type ExpenseCategory,
} from "@/lib/accounting/expense-mappings";
import { createPettyCashExpenseAction } from "./actions";

interface Props {
  defaultDate: string;
  /** Manila today — a till payout can not be dated into the future. */
  maxDate: string;
  /** The shift the page is currently viewing — recorded onto the entry. */
  shiftId: string;
}

export function PettyCashForm({ defaultDate, maxDate, shiftId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [expenseDate, setExpenseDate] = useState(defaultDate);
  const [category, setCategory] = useState<ExpenseCategory | "">("");
  const [amountText, setAmountText] = useState("");
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");

  const categoryHint = PETTY_CASH_CATEGORY_OPTIONS.find(
    (c) => c.value === category,
  )?.hint;

  function reset() {
    setCategory("");
    setAmountText("");
    setVendor("");
    setDescription("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);

    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErr("Amount must be a positive number.");
      return;
    }
    if (!category) {
      setErr("Pick what it was for.");
      return;
    }

    startTransition(async () => {
      const r = await createPettyCashExpenseAction({
        expense_date: expenseDate,
        category,
        amount_php: amount,
        vendor_label: vendor || null,
        description: description || null,
        shift_id: shiftId,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      // entry_number comes from the journal entry the DB bridge posts; fall
      // back to a plain confirmation rather than "Recorded — ." if that
      // read-back ever comes up empty.
      setOk(
        r.data.entry_number
          ? `Recorded — ${r.data.entry_number}. Taken out of the drawer.`
          : "Recorded. Taken out of the drawer.",
      );
      reset();
      router.refresh();
    });
  }

  return (
    <Panel className="p-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {err && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
          >
            {err}
          </div>
        )}
        {ok && (
          <div
            role="status"
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          >
            {ok}
          </div>
        )}

        <div className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg-soft)] px-3 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Paid from <strong>petty cash on hand</strong> (the till). This takes the
          money out of the drawer: the day&apos;s expected cash drops by this
          amount, so the count at closing still ties.
        </div>

        <Field label="Date" required>
          <input
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            max={maxDate}
            required
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          />
        </Field>

        <Field label="What was it for?" required hint={categoryHint}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory | "")}
            required
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          >
            <option value="">— Pick one —</option>
            {PETTY_CASH_CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value} title={c.hint}>
                {c.value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Amount (₱)" required>
          <input
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            required
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 font-mono text-sm"
          />
        </Field>

        <Field
          label="Paid to (optional)"
          hint="Who got the money — e.g. 'Wilcon Depot', 'LBC', 'tricycle'."
        >
          <input
            type="text"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            maxLength={200}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Note (optional)">
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={pending}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {pending ? "Recording…" : "Record petty cash"}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={pending}
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 text-sm font-semibold"
          >
            Clear
          </button>
        </div>
      </form>
    </Panel>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
        {required ? " *" : ""}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
