"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { claimTestAction } from "./actions";

interface Props {
  testRequestId: string;
  navigateOnClaim?: boolean;
}

export function ClaimButton({ testRequestId, navigateOnClaim }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
      onClick={() =>
        start(async () => {
          const result = await claimTestAction(testRequestId);
          if (!result.ok) {
            alert(result.error);
            return;
          }
          if (navigateOnClaim) {
            router.push(`/staff/queue/${testRequestId}`);
          }
        })
      }
    >
      {pending ? "Claiming…" : "Claim"}
    </Button>
  );
}
