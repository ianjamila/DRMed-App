"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { markConsultationDoneAction } from "./actions";

interface Props {
  testRequestId: string;
  visitId: string;
  paid: boolean;
}

export function MarkDoneButton({ testRequestId, visitId, paid }: Props) {
  const [pending, start] = useTransition();
  const disabled = pending || !paid;
  const title = !paid ? "Visit must be paid before completing the consultation" : undefined;

  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled}
      title={title}
      className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
      onClick={() =>
        start(async () => {
          const result = await markConsultationDoneAction(testRequestId, visitId);
          if (!result.ok) alert(result.error);
        })
      }
    >
      {pending ? "Saving…" : "Mark consultation done"}
    </Button>
  );
}
