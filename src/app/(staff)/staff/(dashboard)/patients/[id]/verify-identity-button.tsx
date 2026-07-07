"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { verifyPatientIdentityAction } from "./actions";

interface Props {
  patientId: string;
}

// Sits next to the amber "Pre-registered — verify identity" badge; clears the
// flag once reception has checked the patient's ID at the counter.
export function VerifyIdentityButton({ patientId }: Props) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={pending}
      className="mt-1 border-amber-300 text-amber-900 hover:bg-amber-50"
      onClick={() => {
        start(async () => {
          const result = await verifyPatientIdentityAction(patientId);
          if (!result.ok) {
            alert(result.error);
            return;
          }
          router.refresh();
        });
      }}
    >
      {pending ? "Marking…" : "Mark identity verified"}
    </Button>
  );
}
