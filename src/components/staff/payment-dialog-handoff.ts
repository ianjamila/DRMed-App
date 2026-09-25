"use client";

// Hands one payment dialog over to a sibling on the same visit page: the
// Delete dialog's "Open Move instead" / "Open Edit instead" (Wrong visit /
// Wrong amount). The three dialogs are independent client islands rendered by
// a server page, so they cannot share state; a window event keyed by payment
// id is the smallest seam that keeps each dialog self-contained.
import { useEffect, useRef } from "react";

export const PAYMENT_DIALOG_EVENT = "drmed:open-payment-dialog";

export type PaymentDialogKind = "move" | "edit";

interface Detail {
  paymentId: string;
  dialog: PaymentDialogKind;
}

/** Ask the `dialog` for `paymentId` to open (after the caller has closed itself). */
export function openPaymentDialog(paymentId: string, dialog: PaymentDialogKind): void {
  // Next tick: let the closing dialog release focus and its scroll lock first.
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent<Detail>(PAYMENT_DIALOG_EVENT, { detail: { paymentId, dialog } }));
  }, 0);
}

/** Open this dialog when a sibling hands over to it. */
export function usePaymentDialogHandoff(paymentId: string, dialog: PaymentDialogKind, onOpen: () => void): void {
  const cb = useRef(onOpen);
  useEffect(() => {
    cb.current = onOpen;
  });
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<Detail>).detail;
      if (d?.paymentId === paymentId && d.dialog === dialog) cb.current();
    };
    window.addEventListener(PAYMENT_DIALOG_EVENT, handler);
    return () => window.removeEventListener(PAYMENT_DIALOG_EVENT, handler);
  }, [paymentId, dialog]);
}
