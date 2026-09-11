"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cancelAppointmentAction } from "./actions";

interface Props {
  appointmentId: string;
}

export function CancelButton({ appointmentId }: Props) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cancelledCount, setCancelledCount] = useState<number | null>(null);

  // N11: show a durable confirmation here (rather than router.refresh()ing
  // straight into the page's "Already cancelled" copy) so the patient sees
  // how many appointments the cancellation covered before this button
  // unmounts — a multi-service booking cancels as a group.
  if (cancelledCount != null) {
    return (
      <p className="text-sm font-semibold text-emerald-700" role="status">
        {cancelledCount > 1
          ? `Cancelled — all ${cancelledCount} services in this booking.`
          : "Cancelled."}
      </p>
    );
  }

  return (
    <div>
      <Button
        type="button"
        disabled={pending}
        className="bg-red-600 text-white hover:bg-red-700"
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await cancelAppointmentAction(appointmentId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setCancelledCount(result.cancelledCount);
          })
        }
      >
        {pending ? "Cancelling…" : "Yes, cancel my appointment"}
      </Button>
      {error ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
