"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeMyPasswordAction, type ProfileResult } from "./actions";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<
    ProfileResult | null,
    FormData
  >(changeMyPasswordAction, null);

  // After a successful change, remount the input fields by keying off the
  // updated_at marker so they reset to empty strings — no setState-in-effect.
  const fieldsKey = state?.ok ? "after-success" : "open";

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="current_password">Current password</Label>
        <Input
          key={`current-${fieldsKey}`}
          id="current_password"
          name="current_password"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new_password">New password</Label>
        <Input
          key={`new-${fieldsKey}`}
          id="new_password"
          name="new_password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="confirm_password">Confirm new password</Label>
        <Input
          key={`confirm-${fieldsKey}`}
          id="confirm_password"
          name="confirm_password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
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
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Updating…" : "Update password"}
        </Button>
      </div>
    </form>
  );
}
