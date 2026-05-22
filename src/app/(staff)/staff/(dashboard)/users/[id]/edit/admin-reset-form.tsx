"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adminResetStaffPasswordAction,
  type AdminResetResult,
} from "../../actions";

interface Props {
  staffUserId: string;
}

export function AdminResetForm({ staffUserId }: Props) {
  const action = adminResetStaffPasswordAction.bind(null, staffUserId);
  const [state, formAction, pending] = useActionState<
    AdminResetResult | null,
    FormData
  >(action, null);
  const fieldKey = state?.ok ? "after-success" : "open";

  return (
    <form action={formAction} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="new_password">New password</Label>
        <Input
          key={`new-${fieldKey}`}
          id="new_password"
          name="new_password"
          type="text"
          required
          minLength={10}
          placeholder="At least 10 characters"
          autoComplete="off"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Visible while you type — share it with the user securely (Signal,
          handed in person, etc.) and tell them to change it via{" "}
          <span className="font-mono">/staff/profile</span> after sign-in.
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
        <Button
          type="submit"
          variant="outline"
          disabled={pending}
          className="border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
        >
          {pending ? "Resetting…" : "Reset password"}
        </Button>
      </div>
    </form>
  );
}
