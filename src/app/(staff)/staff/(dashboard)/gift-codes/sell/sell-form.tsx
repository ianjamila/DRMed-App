"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sellGiftCodeAction, type SellResult } from "../actions";

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "gcash", label: "GCash" },
  { value: "maya", label: "Maya" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
];

interface Props {
  initialCode?: string;
}

export function SellGiftCodeForm({ initialCode = "" }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<
    SellResult | null,
    FormData
  >(sellGiftCodeAction, null);

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="code">Gift code</Label>
        <Input
          id="code"
          name="code"
          required
          autoComplete="off"
          autoFocus={!initialCode}
          defaultValue={initialCode}
          placeholder="GC-XXXX-YYYY-ZZZZ"
          className="font-mono uppercase"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Letters/numbers only — case and dashes don&apos;t matter.
        </p>
      </div>

      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Buyer
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="buyer_name">Name</Label>
            <Input
              id="buyer_name"
              name="buyer_name"
              required
              maxLength={120}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="buyer_contact">Contact</Label>
            <Input
              id="buyer_contact"
              name="buyer_contact"
              required
              maxLength={120}
              placeholder="0917… or email"
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Payment
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="purchase_method">Method</Label>
            <select
              id="purchase_method"
              name="purchase_method"
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
            <Label htmlFor="purchase_reference_number">Reference (optional)</Label>
            <Input
              id="purchase_reference_number"
              name="purchase_reference_number"
              maxLength={80}
              placeholder="GCash ref, OR no., etc."
            />
          </div>
        </div>
      </fieldset>

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
          {pending ? "Recording…" : "Record sale"}
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
