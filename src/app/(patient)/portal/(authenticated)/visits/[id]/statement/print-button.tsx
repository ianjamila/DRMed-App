"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { logPatientStatementPrintAction } from "./print-action";

// Same shape as the staff statement's print button: the audit call starts
// before window.print() so it is in flight while the dialog blocks, and a
// failed log never blocks the print.
export function PatientStatementPrintButton({ visitId }: { visitId: string }) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      disabled={pending}
      className="min-h-[44px] bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
      onClick={() => {
        start(async () => {
          await logPatientStatementPrintAction(visitId);
        });
        window.print();
      }}
    >
      Print or save as PDF
    </Button>
  );
}
