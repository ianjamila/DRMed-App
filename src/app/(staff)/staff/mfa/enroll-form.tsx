"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  beginEnrollmentAction,
  verifyEnrollmentAction,
  type EnrollPayload,
  type ActionResult,
} from "./actions";
import { Panel } from "@/components/ui/panel";

// Enrolment is opt-in for every role, so reaching this screen is always a
// deliberate choice — no role needs a different entry path.
export function EnrollForm() {
  const [enroll, setEnroll] = useState<EnrollPayload | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [verifyState, verifyAction, verifyPending] = useActionState<
    ActionResult | null,
    FormData
  >(verifyEnrollmentAction, null);

  async function start() {
    setStarting(true);
    setEnrollError(null);
    const result = await beginEnrollmentAction();
    setStarting(false);
    if (result.ok) {
      setEnroll(result.data);
    } else {
      setEnrollError(result.error);
    }
  }

  if (!enroll) {
    return (
      <Panel className="p-5">
        <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Set up two-factor authentication
        </h2>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
          You&apos;ll need an authenticator app — Google Authenticator,
          1Password, Authy, or similar.
        </p>
        {enrollError ? (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {enrollError}
          </p>
        ) : null}
        <Button onClick={start} disabled={starting} className="mt-4 w-full">
          {starting ? "Preparing…" : "Begin setup"}
        </Button>
      </Panel>
    );
  }

  return (
    <Panel className="p-5">
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Scan the QR code
      </h2>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Open your authenticator app, add a new account, and scan this code.
        Then type the 6-digit code it shows.
      </p>

      <div className="mt-4 flex justify-center rounded-lg bg-white p-3">
        <Image
          src={enroll.qrCode.trimEnd()}
          alt="TOTP QR code"
          width={200}
          height={200}
          className="h-48 w-48"
          unoptimized
        />
      </div>

      <details className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
        <summary className="cursor-pointer">
          Can&apos;t scan? Show secret key
        </summary>
        <p className="mt-2 break-all rounded-md bg-[color:var(--color-brand-bg)] px-3 py-2 font-mono text-[11px] text-[color:var(--color-brand-navy)]">
          {enroll.secret}
        </p>
        <p className="mt-2">
          Save this somewhere safe. Two-step sign-in is optional, but once
          you&apos;re enrolled the code is required on every sign-in —
          Google included — and a lost authenticator can only be cleared by
          someone with access to the Supabase project.
        </p>
      </details>

      <form action={verifyAction} className="mt-5 grid gap-3">
        <input type="hidden" name="factor_id" value={enroll.factorId} />
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
            placeholder="123456"
            className="text-center font-mono tracking-widest"
          />
        </div>
        {verifyState && !verifyState.ok ? (
          <p className="text-sm text-red-600" role="alert">
            {verifyState.error}
          </p>
        ) : null}
        <Button type="submit" disabled={verifyPending}>
          {verifyPending ? "Verifying…" : "Verify and continue"}
        </Button>
      </form>
    </Panel>
  );
}
