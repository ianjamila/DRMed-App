"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  cancelByStaffAction,
  deleteAppointmentAction,
  markArrivedAction,
  markNoShowAction,
  revertToConfirmedAction,
} from "./actions";

interface Props {
  appointmentIds: ReadonlyArray<string>;
  patientId: string | null;
  status: string;
  isAdmin: boolean;
  // When this card represents a multi-service booking, the buttons fire
  // bulk transitions across all sibling rows. Used in confirmation copy.
  groupSize: number;
}

export function TransitionButtons({
  appointmentIds,
  patientId,
  status,
  isAdmin,
  groupSize,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function fire(
    action: (
      ids: ReadonlyArray<string>,
    ) => Promise<{ ok: boolean; error?: string }>,
  ) {
    start(async () => {
      const result = await action(appointmentIds);
      if (!result.ok && "error" in result) {
        alert(result.error ?? "Action failed.");
        return;
      }
      router.refresh();
    });
  }

  const showRevert =
    status === "arrived" ||
    status === "no_show" ||
    status === "cancelled" ||
    status === "pending_callback";

  const groupSuffix =
    groupSize > 1 ? ` (${groupSize} services)` : "";

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {status === "confirmed" ? (
        <>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => fire(markArrivedAction)}
          >
            {pending ? "…" : `Mark arrived${groupSuffix}`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => fire(markNoShowAction)}
          >
            No-show
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (
                !confirm(
                  groupSize > 1
                    ? `Cancel all ${groupSize} services on this booking?`
                    : "Cancel this appointment?",
                )
              )
                return;
              fire(cancelByStaffAction);
            }}
          >
            Cancel
          </Button>
        </>
      ) : null}

      {status === "pending_callback" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (
              !confirm(
                groupSize > 1
                  ? `Cancel all ${groupSize} services on this pending request?`
                  : "Cancel this pending request?",
              )
            )
              return;
            fire(cancelByStaffAction);
          }}
        >
          Cancel
        </Button>
      ) : null}

      {status === "arrived" && patientId ? (
        <Link
          href={`/staff/visits/new?patient_id=${patientId}`}
          className="inline-block rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + Start visit
        </Link>
      ) : null}

      {showRevert ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => fire(revertToConfirmedAction)}
          title="Bounce this back to confirmed (for accidental presses)"
        >
          ↶ Revert
        </Button>
      ) : null}

      {isAdmin ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (
              !confirm(
                groupSize > 1
                  ? `Permanently delete all ${groupSize} services on this booking? Audit log keeps a record.`
                  : "Permanently delete this appointment? Audit log keeps a record.",
              )
            )
              return;
            fire(deleteAppointmentAction);
          }}
          className="border-red-200 text-red-700 hover:bg-red-50"
        >
          Delete
        </Button>
      ) : null}

      {status === "completed" && !isAdmin && !showRevert ? (
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
          —
        </span>
      ) : null}
    </div>
  );
}
