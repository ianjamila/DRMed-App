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
import { PaymentLeavesNotice } from "@/components/staff/payment-leaves-notice";
import { DELETE_CATEGORIES, deleteCategoryHint, type DeleteCategory } from "@/lib/visits/payment-history";
import type { ReleasedCounts, VisitMoney } from "@/lib/visits/payment-edit";
import { voidPaymentAction } from "./actions";
import { openPaymentDialog } from "@/components/staff/payment-dialog-handoff";

// Staff-facing name is "Delete"; underneath it is still the soft void
// (voidPaymentAction) — the row stays, marked deleted, and the reversal
// journal entry posts automatically.
export function VoidPaymentDialog({
  paymentId,
  amount,
  amountLabel,
  methodLabel,
  isGiftCode = false,
  visitNumber,
  visit,
  released,
  canMoveOrEdit,
}: {
  paymentId: string;
  amount: number;
  amountLabel: string;
  methodLabel: string;
  isGiftCode?: boolean;
  visitNumber: string;
  /** The visit as the page loaded it — the notice is a preview; the action re-reads. */
  visit: VisitMoney;
  released: ReleasedCounts;
  /** Move and Edit accept this payment (paymentEditability). */
  canMoveOrEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<DeleteCategory | "">("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const noteRequired = category === "other";
  const ready = category !== "" && (!noteRequired || reason.trim() !== "");
  const hint = deleteCategoryHint(category, canMoveOrEdit);

  function onConfirm() {
    if (category === "") {
      setErr("Choose why you are deleting it.");
      return;
    }
    if (noteRequired && !reason.trim()) {
      setErr("Say why you are deleting it.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await voidPaymentAction(paymentId, { category, reason: reason.trim() });
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setOpen(false);
      setCategory("");
      setReason("");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setCategory("");
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
          <PaymentLeavesNotice
            visit={visit}
            visitNumber={visitNumber}
            amount={amount}
            released={released}
            className="rounded-md bg-[color:var(--color-brand-bg)] p-3 text-xs"
          />
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Why are you deleting it? *</legend>
            {DELETE_CATEGORIES.map((c) => (
              <label key={c.value} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`delete-category-${paymentId}`}
                  value={c.value}
                  checked={category === c.value}
                  onChange={() => {
                    setCategory(c.value);
                    setErr(null);
                  }}
                />
                {c.label}
              </label>
            ))}
            {hint ? (
              <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                <p className="text-xs font-semibold text-amber-800">{hint}</p>
                {canMoveOrEdit && (category === "wrong_visit" || category === "wrong_amount") ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={pending}
                    onClick={() => {
                      setOpen(false);
                      openPaymentDialog(paymentId, category === "wrong_visit" ? "move" : "edit");
                    }}
                  >
                    {category === "wrong_visit" ? "Open Move instead" : "Open Edit instead"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor={`delete-reason-${paymentId}`}>
              {noteRequired ? "What happened? *" : "Note (optional)"}
            </Label>
            <Textarea
              id={`delete-reason-${paymentId}`}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                category === "refunded"
                  ? "e.g. Refunded in cash at the counter"
                  : "e.g. Entered again by the next shift"
              }
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
              disabled={pending || !ready}
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
