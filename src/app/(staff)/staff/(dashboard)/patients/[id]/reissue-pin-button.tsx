"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { reissuePatientPinAction } from "./actions";

interface Props {
  patientId: string;
}

export function ReissuePinButton({ patientId }: Props) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() => {
        if (
          !confirm(
            "Re-issue Secure PIN for the latest visit? The previous PIN will stop working immediately.",
          )
        ) {
          return;
        }
        start(async () => {
          // Action redirects to the receipt on success — only the failure
          // path returns a result we need to surface.
          const result = await reissuePatientPinAction(patientId);
          if (result && !result.ok) alert(result.error);
        });
      }}
    >
      {pending ? "Re-issuing…" : "Re-issue PIN"}
    </Button>
  );
}
