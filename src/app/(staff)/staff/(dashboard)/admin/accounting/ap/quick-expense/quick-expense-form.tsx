"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  EXPENSE_CATEGORIES,
  MOP_OPTIONS,
  type ExpenseCategory,
  type Mop,
} from "@/lib/accounting/expense-mappings";
import { createQuickExpenseAction } from "@/lib/actions/accounting/quick-expense";

interface Props {
  defaultDate: string;
}

export function QuickExpenseForm({ defaultDate }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [expenseDate, setExpenseDate] = useState(defaultDate);
  const [category, setCategory] = useState<ExpenseCategory | "">("");
  const [mop, setMop] = useState<Mop | "">("");
  const [amountText, setAmountText] = useState("");
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");

  function reset() {
    setCategory("");
    setMop("");
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
      setErr("Pick a category.");
      return;
    }
    if (!mop) {
      setErr("Pick a payment source.");
      return;
    }

    startTransition(async () => {
      const r = await createQuickExpenseAction({
        expense_date: expenseDate,
        category,
        mop,
        amount_php: amount,
        vendor_label: vendor || null,
        description: description || null,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setOk(`Posted ${r.data.entry_number}.`);
      reset();
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
    >
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

      <Field label="Expense date" required>
        <input
          type="date"
          value={expenseDate}
          onChange={(e) => setExpenseDate(e.target.value)}
          required
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Category" required>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ExpenseCategory | "")}
          required
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        >
          <option value="">— Pick a category —</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Amount (PHP)" required>
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

      <Field label="Paid from" required hint="Where did the money come from?">
        <select
          value={mop}
          onChange={(e) => setMop(e.target.value as Mop | "")}
          required
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        >
          <option value="">— Pick a source —</option>
          {MOP_OPTIONS.map((m) => (
            <option key={m.value} value={m.value} title={m.hint}>
              {m.label}
            </option>
          ))}
        </select>
        {mop && (
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {MOP_OPTIONS.find((m) => m.value === mop)?.hint}
          </p>
        )}
      </Field>

      <Field label="Vendor / payee (optional)" hint="Free text, e.g. 'MERALCO' or 'Wilcon Depot'.">
        <input
          type="text"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          maxLength={200}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Description / notes (optional)">
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
          {pending ? "Posting…" : "Post expense"}
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
