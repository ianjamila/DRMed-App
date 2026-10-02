"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { claimTestAction } from "./actions";
import { claimPanelAction } from "./panel-actions";
import { claimBenchHref, claimReportHref } from "@/lib/queue/claim-undo-link";

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
          // Both a panel claim and a single-test claim carry an Undo batch
          // (minted server-side); an older server may omit it.
          let batchId: string | undefined;
          let result;
          if (panel) {
            const r = await claimPanelAction(panel);
            if (r.ok) batchId = r.batchId;
            result = r;
          } else {
            const r = await claimTestAction(testRequestId!);
            if (r.ok) batchId = r.batchId;
            result = r;
          }
          if (!result.ok) {
            alert(result.error);
            return;
          }
          const href = panel
            ? claimReportHref(panel, batchId, Date.now())
            : claimBenchHref(testRequestId!, batchId, Date.now());
          // The queue row goes to the page that shows the Undo notice.
          if (navigateOnClaim) router.push(href);
          // The bench page's own Claim stays on the page: show its Undo notice
          // there too. With no batch nothing changes — the action's
          // revalidatePath already re-renders the page.
          else if (batchId) router.replace(href, { scroll: false });
        })
      }
    >
      {pending ? "Claiming…" : "Claim"}
    </Button>
  );
}
