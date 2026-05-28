"use client";

import { useState } from "react";
import {
  MarkHistoricBilledModal,
  MarkHistoricPaidModal,
  WriteOffHistoricModal,
  type StaffPick,
  type PaymentMethod,
} from "./historic-claim-modals";

/**
 * Per-claim action buttons. Renders the appropriate buttons for the claim's
 * current status:
 *   - pending/overdue + no date_submitted → Mark billed, Mark paid, Write off
 *   - pending/overdue + has date_submitted (billed) → Mark paid, Write off
 *   - paid → (no actions)
 *   - written_off → (no actions)
 */
export function SingleClaimActions({
  claimId,
  status,
  hasSubmissionDate,
  finalAmount,
  staff,
  paymentMethods,
  size = "default",
}: {
  claimId: string;
  status: "pending" | "overdue" | "paid" | "written_off" | "unknown";
  hasSubmissionDate: boolean;
  finalAmount: number;
  staff: StaffPick[];
  paymentMethods: PaymentMethod[];
  size?: "default" | "compact";
}) {
  const [open, setOpen] = useState<null | "billed" | "paid" | "writeoff">(null);

  // Terminal states — no actions.
  if (status === "paid" || status === "written_off") {
    return null;
  }

  const sizeCls =
    size === "compact"
      ? "min-h-[28px] whitespace-nowrap px-2 py-0.5 text-[10px]"
      : "min-h-[36px] whitespace-nowrap px-2.5 py-1 text-[11px]";

  return (
    <>
      <div className="flex flex-nowrap items-center justify-end gap-1.5">
        {!hasSubmissionDate && (
          <button
            type="button"
            onClick={() => setOpen("billed")}
            className={
              "rounded-md bg-[color:var(--color-brand-navy)] font-bold uppercase tracking-wider text-white " +
              sizeCls
            }
          >
            Mark billed
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen("paid")}
          className={
            "rounded-md border border-emerald-600 bg-white font-bold uppercase tracking-wider text-emerald-700 hover:bg-emerald-600 hover:text-white " +
            sizeCls
          }
        >
          Mark paid
        </button>
        <button
          type="button"
          onClick={() => setOpen("writeoff")}
          className={
            "rounded-md border border-red-600 bg-white font-bold uppercase tracking-wider text-red-700 hover:bg-red-600 hover:text-white " +
            sizeCls
          }
        >
          Write off
        </button>
      </div>
      {open === "billed" && (
        <MarkHistoricBilledModal
          claimIds={[claimId]}
          totalAmount={finalAmount}
          staff={staff}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "paid" && (
        <MarkHistoricPaidModal
          claimIds={[claimId]}
          totalAmount={finalAmount}
          staff={staff}
          paymentMethods={paymentMethods}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "writeoff" && (
        <WriteOffHistoricModal
          claimIds={[claimId]}
          totalAmount={finalAmount}
          staff={staff}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
