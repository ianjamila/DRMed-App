"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { voidPaymentAction } from "./actions";

// Staff-facing name is "Delete"; underneath it is still the soft void
// (voidPaymentAction) — the row stays, marked deleted, and the reversal
// journal entry posts automatically.
export function VoidPaymentDialog({
  paymentId,
  amountLabel,
  methodLabel,
  isGiftCode = false,
}: {
  paymentId: string;
  amountLabel: string;
  methodLabel: string;
  isGiftCode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await voidPaymentAction(paymentId, reason.trim());
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setOpen(false);
      setReason("");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setReason("");
          setErr(null);
          setOpen(true);
        }}
        className="min-h-[44px] text-xs font-semibold text-red-700 hover:underline"
      >
        Delete
      </button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete this {amountLabel} {methodLabel} payment?
            </DialogTitle>
            <DialogDescription>
              It stays in the payment history below, marked deleted, and the
              visit balance opens up again. The books reverse automatically.
              {isGiftCode ? " The gift code becomes usable again." : null}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`delete-reason-${paymentId}`}>Reason *</Label>
            <Textarea
              id={`delete-reason-${paymentId}`}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Recorded twice by mistake"
            />
          </div>
          {err ? (
            <p className="text-sm text-red-600" role="alert">
              {err}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="touch"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="touch"
              onClick={onConfirm}
              disabled={pending || !reason.trim()}
              className="bg-red-700 text-white hover:bg-red-800"
            >
              {pending ? "Deleting…" : "Delete payment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
