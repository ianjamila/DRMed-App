"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { releasePackageHeaderAction } from "./actions";

interface Props {
  headerId: string;
  visitId: string;
  // Mirrors moneySettled (src/lib/visits/money-settled.ts) — the same value
  // every other release control on this page disables against. The trigger
  // still enforces this; this is only the friendly disabled state.
  moneySettled: boolean;
}

// A3 (go-live): admin-only manual release for a package header stuck at
// ready_for_release with every component already terminal. Normally
// migration 0109's Leg A trigger auto-releases the header the moment the
// last component goes terminal — this button only ever renders when the
// page's own canManuallyReleasePackageHeader check says that should already
// have happened and didn't.
export function ReleasePackageHeaderButton({
  headerId,
  visitId,
  moneySettled,
}: Props) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const disabled = pending || !moneySettled;
  const title = !moneySettled
    ? "Visit must be paid, waived, or HMO-covered before release"
    : "Admin override — releases this package header directly";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        title={title}
        className="border border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100"
        onClick={() =>
          start(async () => {
            setErr(null);
            const result = await releasePackageHeaderAction(headerId, visitId);
            if (!result.ok) setErr(result.error);
          })
        }
      >
        {pending ? "Releasing…" : "Release package header"}
      </Button>
      {err ? <p className="text-[10px] text-red-600">{err}</p> : null}
    </div>
  );
}
