"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  refundGiftCodeSaleAction,
  type RefundResult,
} from "../../../gift-codes/actions";

interface Props {
  code: string;
}

export function RefundButton({ code }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<
    RefundResult | null,
    FormData
  >(refundGiftCodeSaleAction, null);

  if (state?.ok) {
    router.refresh();
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Refund this sale
      </Button>
    );
  }

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="code" value={code} />
      <div className="grid gap-1.5">
        <Label htmlFor="refund_reason_admin">Reason for the refund</Label>
        <textarea
          id="refund_reason_admin"
          name="refund_reason"
          rows={2}
          maxLength={500}
          required
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          placeholder="e.g. wrong buyer details keyed in, customer changed their mind"
        />
      </div>
      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} variant="destructive">
          {pending ? "Refunding…" : "Confirm refund"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Back
        </Button>
      </div>
    </form>
  );
}
