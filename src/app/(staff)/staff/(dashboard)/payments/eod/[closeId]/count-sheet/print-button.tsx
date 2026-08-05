"use client";

import { Button } from "@/components/ui/button";

// Plain print — unlike the visit receipt there's no PIN flash to clear, so this
// is the whole interaction.
export function PrintButton() {
  return (
    <Button
      type="button"
      onClick={() => window.print()}
      className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
    >
      Print count sheet
    </Button>
  );
}
