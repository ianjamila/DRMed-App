"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { logPfSlipPrintAction } from "./log-print-action";

interface Props {
  disbursementId: string;
  batchLabel: string;
}

// Print both copies and leave an audit row behind. The log call is started
// before window.print() so the request is already in flight while the browser
// blocks on the print dialog; a failed log never blocks the print.
export function SlipPrintButton({ disbursementId, batchLabel }: Props) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      disabled={pending}
      aria-label={`Print acknowledgment slip for payout ${batchLabel}`}
      className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      onClick={() => {
        start(async () => {
          await logPfSlipPrintAction(disbursementId);
        });
        window.print();
      }}
    >
      Print both copies
    </Button>
  );
}
