"use client";

// Exit for the View-as banner: same pending/error/return_to pattern as
// ViewAsSelect. return_to is filled on click, before the form submits.
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { exitViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import { currentPageForReturn } from "./view-as-select";

export function ViewAsExitButton() {
  const [state, formAction, pending] = useActionState(exitViewAsAction, { error: null });
  return (
    <form action={formAction} aria-busy={pending} className="flex flex-col items-start">
      <input type="hidden" name="return_to" defaultValue="" />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={(e) => {
          const rt = e.currentTarget.form?.elements.namedItem("return_to");
          if (rt instanceof HTMLInputElement) rt.value = currentPageForReturn();
        }}
      >
        {pending ? "Exiting…" : "Exit"}
      </Button>
      {state.error && (
        <p role="alert" className="mt-1 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
    </form>
  );
}
