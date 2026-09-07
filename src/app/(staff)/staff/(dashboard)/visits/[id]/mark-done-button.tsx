"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { markConsultationDoneAction, markProcedureDoneAction } from "./actions";

interface Props {
  testRequestId: string;
  visitId: string;
  moneySettled: boolean;
  // Consults and procedures both skip the lab queue and release directly
  // (see markDoctorLineDoneAction) — only the label/action/gate copy differs.
  kind: "doctor_consultation" | "doctor_procedure";
}

const COPY = {
  doctor_consultation: {
    label: "Mark consultation done",
    gateTitle: "Visit must be paid, waived, or HMO-covered before completing the consultation",
    action: markConsultationDoneAction,
  },
  doctor_procedure: {
    label: "Mark procedure done",
    gateTitle: "Visit must be paid, waived, or HMO-covered before completing the procedure",
    action: markProcedureDoneAction,
  },
} as const;

export function MarkDoneButton({ testRequestId, visitId, moneySettled, kind }: Props) {
  const [pending, start] = useTransition();
  const disabled = pending || !moneySettled;
  const { label, gateTitle, action } = COPY[kind];
  const title = !moneySettled ? gateTitle : undefined;

  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled}
      title={title}
      className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
      onClick={() =>
        start(async () => {
          const result = await action(testRequestId, visitId);
          if (!result.ok) alert(result.error);
        })
      }
    >
      {pending ? "Saving…" : label}
    </Button>
  );
}
