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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatPhp } from "@/lib/marketing/format";
import {
  EDITABLE_PAYMENT_METHODS,
  balanceAfterEdit,
  isEditablePaymentMethod,
  isMoneyChange,
  paymentSnapshot,
} from "@/lib/visits/payment-edit";
import { editPaymentAction } from "./actions";
import { usePaymentDialogHandoff } from "@/components/staff/payment-dialog-handoff";

const SELECT_CLASS =
  "h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none";

export function EditPaymentDialog({
  paymentId,
  amount,
  method,
  methodLabel,
  referenceNumber,
  notes,
  receivedLabel,
  receivedOnOtherDay,
  visitTotal,
  visitPaid,
}: {
  paymentId: string;
  amount: number;
  method: string | null;
  methodLabel: string;
  referenceNumber: string | null;
  notes: string | null;
  receivedLabel: string;
  /** The Manila date it was received, when that is not today; else null. */
  receivedOnOtherDay: string | null;
  visitTotal: number;
  visitPaid: number;
}) {
  // A legacy method the counter no longer offers (bpi / maybank) starts
  // blank: defaulting it to Cash would let a reference-only fix silently turn
  // a bank receipt into drawer cash. Staff must pick the replacement.
  const initialMethod: string = isEditablePaymentMethod(method) ? method : "";
  const [open, setOpen] = useState(false);
  const [newMethod, setNewMethod] = useState<string>(initialMethod);
  const [newAmount, setNewAmount] = useState(amount.toFixed(2));
  const [newReference, setNewReference] = useState(referenceNumber ?? "");
  const [newNotes, setNewNotes] = useState(notes ?? "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The Delete dialog's "Open Edit instead" (Wrong amount).
  usePaymentDialogHandoff(paymentId, "edit", () => {
    reset();
    setOpen(true);
  });

  function reset() {
    setNewMethod(initialMethod);
    setNewAmount(amount.toFixed(2));
    setNewReference(referenceNumber ?? "");
    setNewNotes(notes ?? "");
    setReason("");
    setErr(null);
  }

  const parsedAmount = Number(newAmount);
  const amountValid = newAmount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount > 0;
  const methodChosen = newMethod !== "";
  const moneyChanged =
    amountValid && methodChosen && isMoneyChange({ amount_php: amount, method }, { amount_php: parsedAmount, method: newMethod });
  const textChanged =
    newReference.trim() !== (referenceNumber ?? "") || newNotes.trim() !== (notes ?? "");
  const nothingChanged = amountValid && methodChosen && !moneyChanged && !textChanged;
  const balance = amountValid
    ? balanceAfterEdit({ visitTotal, visitPaid, oldAmount: amount, newAmount: parsedAmount })
    : null;
  const newMethodLabel =
    EDITABLE_PAYMENT_METHODS.find((m) => m.value === newMethod)?.label ?? newMethod;

  function onSave() {
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    startTransition(async () => {
      setErr(null);
      const result = await editPaymentAction({
        paymentId,
        amount: newAmount,
        method: newMethod,
        referenceNumber: newReference,
        notes: newNotes,
        reason: reason.trim(),
        expected: paymentSnapshot({ amount_php: amount, method, reference_number: referenceNumber, notes }),
      });
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
          reset();
          setOpen(true);
        }}
        className="min-h-[44px] text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Edit
      </button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit payment</DialogTitle>
            <DialogDescription>
              {formatPhp(amount)} · {methodLabel} · received {receivedLabel}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`edit-method-${paymentId}`}>Method</Label>
              <select
                id={`edit-method-${paymentId}`}
                value={newMethod}
                onChange={(e) => setNewMethod(e.target.value)}
                className={SELECT_CLASS}
              >
                {!methodChosen ? (
                  <option value="" disabled>
                    Choose the new method (was {methodLabel})
                  </option>
                ) : null}
                {EDITABLE_PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`edit-amount-${paymentId}`}>Amount (PHP)</Label>
              <Input
                id={`edit-amount-${paymentId}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`edit-ref-${paymentId}`}>Reference number (optional)</Label>
              <Input
                id={`edit-ref-${paymentId}`}
                maxLength={80}
                value={newReference}
                onChange={(e) => setNewReference(e.target.value)}
                placeholder="GCash ref, OR number, etc."
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`edit-notes-${paymentId}`}>Notes (optional)</Label>
              <Textarea
                id={`edit-notes-${paymentId}`}
                rows={2}
                maxLength={2000}
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`edit-reason-${paymentId}`}>Why are you changing it? *</Label>
              <Textarea
                id={`edit-reason-${paymentId}`}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Patient paid by GCash, keyed as Cash"
              />
            </div>

            <div
              className="rounded-md bg-[color:var(--color-brand-bg)] p-3 text-xs text-[color:var(--color-brand-text-mid)]"
              aria-live="polite"
            >
              {!methodChosen ? (
                <p>{methodLabel} is no longer a counter method. Choose what the payment should be recorded as.</p>
              ) : !amountValid ? (
                <p>Enter an amount greater than zero.</p>
              ) : nothingChanged ? (
                <p>Nothing has changed yet.</p>
              ) : moneyChanged ? (
                <p>
                  The {formatPhp(amount)} {methodLabel} payment moves to the
                  history below as <b>edited</b>, and a {formatPhp(parsedAmount)}{" "}
                  {newMethodLabel} payment takes its place with the same
                  received date. The books and the cash drawer correct
                  themselves.
                </p>
              ) : (
                <p>Only the reference or notes change. The amount and the books stay as they are.</p>
              )}
              {moneyChanged && receivedOnOtherDay ? (
                <p className="mt-2">
                  It was received on {receivedOnOtherDay}, so that day’s collection totals change too
                  {method === "cash" || newMethod === "cash" ? ", including the cash that day’s drawer should hold" : ""}.
                </p>
              ) : null}
              {moneyChanged && balance !== null && balance > 0 ? (
                <p className="mt-2 font-semibold text-amber-800">
                  This leaves {formatPhp(balance)} unpaid on the visit.
                </p>
              ) : null}
              {moneyChanged && balance !== null && balance < 0 ? (
                <p className="mt-2 font-semibold text-amber-800">
                  This records {formatPhp(-balance)} more than the visit total.
                </p>
              ) : null}
            </div>

            {err ? (
              <p className="text-sm text-red-600" role="alert">
                {err}
              </p>
            ) : null}
          </div>

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
              onClick={onSave}
              disabled={pending || !methodChosen || !amountValid || nothingChanged || !reason.trim()}
              className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
