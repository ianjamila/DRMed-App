"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { clearVisitPinFlashAction } from "./clear-pin-action";

interface Props {
  hasFlash: boolean;
}

// Print, then clear the flash cookie (so a later reload shows "Already
// viewed"). If there's no flash to clear (e.g. revisiting an old receipt),
// just print.
export function PrintButton({ hasFlash }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      disabled={pending}
      className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      onClick={() => {
        window.print();
        if (hasFlash) {
          start(async () => {
            await clearVisitPinFlashAction();
            router.refresh();
          });
        }
      }}
    >
      {pending ? "Finishing…" : "Print & mark as printed"}
    </Button>
  );
}
