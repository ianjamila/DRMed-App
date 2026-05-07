"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  submitChallengeAction,
  type ActionResult,
} from "./actions";

export function ChallengeForm() {
  const [state, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(submitChallengeAction, null);

  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Enter your authenticator code
      </h2>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Open your authenticator app and enter the current 6-digit code for
        drmed.staff.
      </p>

      <form action={formAction} className="mt-5 grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="code">6-digit code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            placeholder="123456"
            className="text-center font-mono tracking-widest"
          />
        </div>
        {state && !state.ok ? (
          <p className="text-sm text-red-600" role="alert">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Verify"}
        </Button>
      </form>
    </div>
  );
}
