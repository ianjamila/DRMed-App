"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeStaffEmailAction, type EmailChangeResult } from "../../actions";

interface Props {
  staffUserId: string;
  currentEmail: string;
}

export function EmailForm({ staffUserId, currentEmail }: Props) {
  const action = changeStaffEmailAction.bind(null, staffUserId);
  const [state, formAction, pending] = useActionState<
    EmailChangeResult | null,
    FormData
  >(action, null);

  // The schema normalises the address (trim + lowercase), so after a save the
  // input should show what was actually stored, not what was typed. Remounting
  // via a key is how an uncontrolled input picks up a new defaultValue — keyed
  // on a success counter so a later failed attempt never wipes the admin's
  // in-progress retry. `useActionState` hands back a new `state` identity per
  // submission, so this adjusts the counter during render (React's documented
  // "storing information from previous renders" pattern) rather than in an
  // effect — no extra commit-then-re-render flash for what's really a pure
  // derivation of the last result.
  const [savedCount, setSavedCount] = useState(0);
  const [lastState, setLastState] = useState(state);
  if (state !== lastState) {
    setLastState(state);
    if (state?.ok) setSavedCount((n) => n + 1);
  }

  return (
    <form action={formAction} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="signin_email">New email</Label>
        {/* id is signin_email, not email: the profile form above renders its
            own disabled id="email" field, and duplicate ids would point this
            label at that one instead. The form field NAME stays "email"
            because changeStaffEmailAction reads formData.get("email"). */}
        <Input
          key={savedCount}
          id="signin_email"
          name="email"
          type="email"
          required
          defaultValue={currentEmail}
          autoComplete="off"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          This is the Google account they sign in with. Changing it takes effect
          immediately and does not send a confirmation email.
        </p>
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      {state && state.ok ? (
        <p
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
        >
          {state.message}
        </p>
      ) : null}

      <div>
        <Button type="submit" variant="brand" disabled={pending}>
          {pending ? "Saving…" : "Save sign-in email"}
        </Button>
      </div>
    </form>
  );
}
