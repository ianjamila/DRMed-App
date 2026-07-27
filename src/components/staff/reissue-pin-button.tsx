"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { reissuePatientPinAction } from "@/lib/actions/visits/reissue-pin";

interface Props {
  patientId: string;
  /** Target this visit instead of the patient's latest one. */
  visitId?: string;
  /** Defaults to the patient-page wording. */
  label?: string;
  /** Defaults to the patient-page confirmation. */
  confirmText?: string;
}

export function ReissuePinButton({
  patientId,
  visitId,
  label = "Re-issue PIN",
  confirmText = "Re-issue Secure PIN for the latest visit? The previous PIN will stop working immediately.",
}: Props) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() => {
        if (!confirm(confirmText)) return;
        start(async () => {
          // Action redirects to the receipt on success — only the failure
          // path returns a result we need to surface.
          const result = await reissuePatientPinAction(patientId, visitId);
          if (result && !result.ok) alert(result.error);
        });
      }}
    >
      {pending ? "Working…" : label}
    </Button>
  );
}
