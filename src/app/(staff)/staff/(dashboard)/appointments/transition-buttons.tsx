"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AttachPatientSheet } from "./attach-patient-sheet";
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
  walkInName: string | null;
  walkInPhone: string | null;
  status: string;
  isAdmin: boolean;
  // When this card represents a multi-service booking, the buttons fire
  // bulk transitions across all sibling rows. Used in confirmation copy.
  groupSize: number;
}

export function TransitionButtons({
  appointmentIds,
  patientId,
  walkInName,
  walkInPhone,
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

  // M7: pending_callback -> confirmed gets its own honest "Confirm" button
  // below (same revertToConfirmedAction transition, different affordance) —
  // it's not an undo, it's the normal "reception called back, booking is
  // on" step. The genuine revert path (bounce an accidental arrived /
  // no_show / cancelled press back to confirmed) keeps this label.
  const showRevert =
    status === "arrived" ||
    status === "no_show" ||
    status === "cancelled";

  const groupSuffix =
    groupSize > 1 ? ` (${groupSize} services)` : "";

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {status === "confirmed" ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="success"
            disabled={pending}
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
        <>
          <Button
            type="button"
            size="sm"
            variant="success"
            disabled={pending}
            onClick={() => fire(revertToConfirmedAction)}
            title="Reception called back and the booking is on — this becomes a normal confirmed appointment."
          >
            {pending ? "…" : "Confirm"}
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
        </>
      ) : null}

      {status === "arrived" && patientId && appointmentIds.length > 0 ? (
        <Link
          href={`/staff/visits/new?patient_id=${patientId}&appointment_id=${appointmentIds[0]}`}
          className="inline-block rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + Start visit
        </Link>
      ) : null}

      {/* H2: a walk-in (no patient_id yet) that's confirmed or already
          arrived needs a way to gain a patient record before a visit can
          ever start for it — otherwise it's a dead end reception can only
          abandon. */}
      {(status === "confirmed" || status === "arrived") &&
      !patientId &&
      appointmentIds.length > 0 ? (
        <AttachPatientSheet
          appointmentId={appointmentIds[0]!}
          walkInName={walkInName}
          walkInPhone={walkInPhone}
        />
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
          variant="destructive"
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
