"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StableTextarea } from "@/components/forms/stable-fields";
import { refundGiftCodeSaleAction, type RefundResult } from "../actions";

interface Props {
  code: string;
}

export function RefundGiftCodeForm({ code }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<
    RefundResult | null,
    FormData
  >(refundGiftCodeSaleAction, null);

  if (state?.ok) {
    router.refresh();
  }

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="code" value={code} />
      <div className="grid gap-1.5">
        <Label htmlFor="refund_reason">Reason for the refund</Label>
        <StableTextarea
          id="refund_reason"
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
      <div>
        <Button
          type="submit"
          disabled={pending}
          variant="destructive"
        >
          {pending ? "Refunding…" : "Refund this sale"}
        </Button>
      </div>
    </form>
  );
}
