"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { releaseTestAction } from "./actions";

interface Props {
  testRequestId: string;
  visitId: string;
  paid: boolean;
}

export function ReleaseButton({ testRequestId, visitId, paid }: Props) {
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      disabled={pending || !paid}
      title={paid ? undefined : "Visit must be paid before release"}
      className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
      onClick={() =>
        start(async () => {
          const result = await releaseTestAction(testRequestId, visitId);
          if (!result.ok) alert(result.error);
        })
      }
    >
      {pending ? "Releasing…" : "Release"}
    </Button>
  );
}
