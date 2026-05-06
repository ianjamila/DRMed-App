"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  cancelGiftCodeAction,
  type GiftCodeResult,
} from "../actions";

interface Props {
  giftCodeId: string;
}

export function CancelButton({ giftCodeId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const action = cancelGiftCodeAction.bind(null, giftCodeId);
  const [state, formAction, pending] = useActionState<
    GiftCodeResult | null,
    FormData
  >(action, null);

  if (state?.ok) {
    router.refresh();
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="border-red-200 text-red-700 hover:bg-red-50"
      >
        Cancel this code
      </Button>
    );
  }

  return (
    <form action={formAction} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="cancellation_reason">Cancellation reason</Label>
        <textarea
          id="cancellation_reason"
          name="cancellation_reason"
          rows={2}
          maxLength={500}
          required
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          placeholder="e.g. misprinted, voided, lost"
        />
      </div>
      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending}
          className="bg-red-600 text-white hover:bg-red-700"
        >
          {pending ? "Cancelling…" : "Confirm cancellation"}
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
