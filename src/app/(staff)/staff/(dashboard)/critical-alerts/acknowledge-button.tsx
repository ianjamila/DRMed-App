"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeCriticalAlertAction } from "./actions";

export function AcknowledgeButton({ alertId }: { alertId: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onAcknowledge() {
    startTransition(async () => {
      setErr(null);
      const result = await acknowledgeCriticalAlertAction(alertId);
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onAcknowledge}
        disabled={pending}
        className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Acknowledging…" : "Acknowledge"}
      </button>
      {err ? <p className="text-xs text-red-600">{err}</p> : null}
    </div>
  );
}
