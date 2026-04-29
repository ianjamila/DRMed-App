"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInPatient, type SignInResult } from "./actions";

export function PatientLoginForm() {
  const [state, formAction, pending] = useActionState<
    SignInResult | null,
    FormData
  >(signInPatient, null);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="drm_id">DRM-ID</Label>
        <Input
          id="drm_id"
          name="drm_id"
          placeholder="DRM-0001"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pin">Secure PIN</Label>
        <Input
          id="pin"
          name="pin"
          placeholder="From your receipt"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          maxLength={8}
          required
        />
      </div>
      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Access my results"}
      </Button>
    </form>
  );
}
