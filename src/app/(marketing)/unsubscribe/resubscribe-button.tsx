"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { resubscribeAction, type ResubscribeResult } from "./actions";

interface Props {
  token: string;
}

export function ResubscribeButton({ token }: Props) {
  const [state, formAction, pending] = useActionState<
    ResubscribeResult | null,
    FormData
  >(async () => resubscribeAction(token), null);

  if (state?.ok) {
    return (
      <p className="text-sm text-emerald-700">
        Welcome back — you&apos;re on the list again.
      </p>
    );
  }

  return (
    <form action={formAction}>
      <Button
        type="submit"
        disabled={pending}
        className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        {pending ? "Restoring…" : "I changed my mind"}
      </Button>
      {state && !state.ok ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
