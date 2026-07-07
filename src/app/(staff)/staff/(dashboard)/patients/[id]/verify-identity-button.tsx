"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
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
    <button
      type="button"
      disabled={pending}
      className="mt-1 inline-block rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-60"
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
    </button>
  );
}
