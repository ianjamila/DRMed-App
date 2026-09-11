"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { clearVisitPinFlashAction } from "./clear-pin-action";

interface Props {
  hasFlash: boolean;
  // A8: audits `receipt.printed` — bound by the caller to the visit or
  // group id (`logReceiptPrintAction.bind(null, visit.id)` /
  // `logGroupReceiptPrintAction.bind(null, groupId)`), since a shared
  // button can't know which resource it's printing.
  onPrint: () => Promise<void>;
}

// Print, log the disclosure, then clear the flash cookie (so a later reload
// shows "Already viewed"). Both the audit write and the flash-clear run in
// the same transition so the button's pending state covers both.
export function PrintButton({ hasFlash, onPrint }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      disabled={pending}
      className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      onClick={() => {
        window.print();
        start(async () => {
          await onPrint();
          if (hasFlash) {
            await clearVisitPinFlashAction();
          }
          router.refresh();
        });
      }}
    >
      {pending ? "Finishing…" : "Print & mark as printed"}
    </Button>
  );
}
