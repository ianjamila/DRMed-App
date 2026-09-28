"use client";

// "End now" on the Active role views panel (spec addendum A3). Same
// useActionState/pending/error shape as ViewAsExitButton; adds a plain-words
// "notice" line for the ended:false case (the view already ended — nothing
// left to do, not an error).
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { endViewAsForAction } from "./actions";

export function EndRoleViewButton({ targetId }: { targetId: string }) {
  const [state, formAction, pending] = useActionState(endViewAsForAction, {
    error: null,
    notice: null,
  });
  return (
    <form action={formAction} aria-busy={pending} className="inline-flex flex-col items-start">
      <input type="hidden" name="target_id" value={targetId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Ending…" : "End now"}
      </Button>
      {state.error ? (
        <p role="alert" className="mt-1 text-[11px] text-red-700">
          {state.error}
        </p>
      ) : state.notice ? (
        <p className="mt-1 text-[11px] text-[color:var(--color-brand-text-soft)]">{state.notice}</p>
      ) : null}
    </form>
  );
}
