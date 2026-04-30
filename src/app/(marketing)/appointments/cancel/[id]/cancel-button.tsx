"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cancelAppointmentAction } from "./actions";

interface Props {
  appointmentId: string;
}

export function CancelButton({ appointmentId }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
            router.refresh();
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
