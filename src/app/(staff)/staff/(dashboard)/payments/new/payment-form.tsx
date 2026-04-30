"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordPaymentAction, type PaymentResult } from "./actions";

interface Props {
  visitId: string;
  balance: number;
}

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "gcash", label: "GCash" },
  { value: "maya", label: "Maya" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
];

export function PaymentForm({ visitId, balance }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<
    PaymentResult | null,
    FormData
  >(recordPaymentAction, null);

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="visit_id" value={visitId} />

      <div className="grid gap-1.5">
        <Label htmlFor="amount_php">Amount (PHP)</Label>
        <Input
          id="amount_php"
          name="amount_php"
          type="number"
          step="0.01"
          min="0.01"
          defaultValue={balance > 0 ? balance.toFixed(2) : ""}
          required
        />
        {balance > 0 ? (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Pre-filled with current balance.
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="method">Method</Label>
        <select
          id="method"
          name="method"
          required
          defaultValue="cash"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="reference_number">Reference number (optional)</Label>
        <Input
          id="reference_number"
          name="reference_number"
          maxLength={80}
          placeholder="GCash ref, OR number, etc."
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={2000}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Saving…" : "Record payment"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
