"use client";

import { useActionState } from "react";
import Link from "next/link";
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
          placeholder="ABCD1234"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          maxLength={8}
          aria-describedby="pin-hint"
          className="font-mono tracking-wider"
          required
        />
        <p id="pin-hint" className="text-xs text-[color:var(--color-brand-text-soft)]">
          8-character code from your receipt
        </p>
      </div>
      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Access my results"}
      </Button>
      <Link href="/find-my-id" className="text-sm text-cyan-700 hover:underline">Forgot your DRM-ID?</Link>
    </form>
  );
}
