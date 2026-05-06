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
  appointmentId: string;
  patientId: string | null;
  status: string;
  isAdmin: boolean;
}

export function TransitionButtons({
  appointmentId,
  patientId,
  status,
  isAdmin,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function fire(
    action: (id: string) => Promise<{ ok: boolean; error?: string }>,
  ) {
    start(async () => {
      const result = await action(appointmentId);
      if (!result.ok && "error" in result) {
        alert(result.error ?? "Action failed.");
        return;
      }
      router.refresh();
    });
  }

  const showRevert =
    status === "arrived" || status === "no_show" || status === "cancelled";

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
            {pending ? "…" : "Mark arrived"}
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
              if (!confirm("Cancel this appointment?")) return;
              fire(cancelByStaffAction);
            }}
          >
            Cancel
          </Button>
        </>
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
                "Permanently delete this appointment? Audit log keeps a record.",
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
