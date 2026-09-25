"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { logStatementPrintAction } from "./log-print-action";

// Print and leave an audit row behind. As on the PF payout slip, the log call
// starts before window.print() so it is already in flight while the browser
// blocks on the dialog; a failed log never blocks the print.
export function StatementPrintButton({ visitId }: { visitId: string }) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      disabled={pending}
      className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      onClick={() => {
        start(async () => {
          await logStatementPrintAction(visitId);
        });
        window.print();
      }}
    >
      Print statement
    </Button>
  );
}
