"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { claimTestAction } from "./actions";
import { claimPanelAction } from "./consolidated/[visitId]/[groupId]/actions";

// One test, or a whole consolidated chemistry panel — the panel is named by
// (visit, report group) and its members are resolved on the server, because
// the list may show only part of it.
type Target =
  | { testRequestId: string; panel?: never }
  | { panel: { visitId: string; groupId: string }; testRequestId?: never };

type Props = Target & { navigateOnClaim?: boolean };

export function ClaimButton({ testRequestId, panel, navigateOnClaim }: Props) {
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
          const result = panel
            ? await claimPanelAction(panel)
            : await claimTestAction(testRequestId!);
          if (!result.ok) {
            alert(result.error);
            return;
          }
          if (navigateOnClaim) {
            router.push(
              panel
                ? `/staff/queue/consolidated/${panel.visitId}/${panel.groupId}`
                : `/staff/queue/${testRequestId}`,
            );
          }
        })
      }
    >
      {pending ? "Claiming…" : "Claim"}
    </Button>
  );
}
