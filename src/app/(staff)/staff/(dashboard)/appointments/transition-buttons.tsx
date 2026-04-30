"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  cancelByStaffAction,
  markArrivedAction,
  markNoShowAction,
} from "./actions";

interface Props {
  appointmentId: string;
  patientId: string | null;
  status: string;
}

export function TransitionButtons({
  appointmentId,
  patientId,
  status,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function fire(action: (id: string) => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const result = await action(appointmentId);
      if (!result.ok && "error" in result) {
        alert(result.error ?? "Action failed.");
        return;
      }
      router.refresh();
    });
  }

  if (status === "confirmed") {
    return (
      <div className="flex flex-wrap gap-2">
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
      </div>
    );
  }

  if (status === "arrived" && patientId) {
    return (
      <Link
        href={`/staff/visits/new?patient_id=${patientId}`}
        className="inline-block rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        + Start visit
      </Link>
    );
  }

  return (
    <span className="text-xs text-[color:var(--color-brand-text-soft)]">—</span>
  );
}
