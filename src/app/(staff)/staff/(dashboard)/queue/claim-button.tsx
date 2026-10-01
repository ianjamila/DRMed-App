"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { claimTestAction } from "./actions";
import { claimPanelAction } from "./panel-actions";

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
          // Only a panel claim carries an Undo batch (minted server-side).
          let batchId: string | undefined;
          let result;
          if (panel) {
            const r = await claimPanelAction(panel);
            if (r.ok) batchId = r.batchId;
            result = r;
          } else {
            result = await claimTestAction(testRequestId!);
          }
          if (!result.ok) {
            alert(result.error);
            return;
          }
          if (navigateOnClaim) {
            // The panel claim's Undo batch rides along to the report page.
            router.push(
              panel
                ? `/staff/queue/consolidated/${panel.visitId}/${panel.groupId}` +
                    (batchId ? `?claimed=${encodeURIComponent(batchId)}&at=${Date.now()}` : "")
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
