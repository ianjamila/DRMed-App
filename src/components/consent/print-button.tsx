"use client";

import { Button } from "@/components/ui/button";

// Plain print — shared by the bound (patients/[id]/consent/print) and blank
// (patients/consent/print) consent-form routes. Neither needs the receipt
// print-button's flash-clearing dance, so this is the whole interaction.
export function PrintButton() {
  return (
    <Button
      type="button"
      onClick={() => window.print()}
      className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
    >
      Print form
    </Button>
  );
}
