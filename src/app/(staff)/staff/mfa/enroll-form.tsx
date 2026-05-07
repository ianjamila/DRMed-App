"use client";

import Image from "next/image";
import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  beginEnrollmentAction,
  verifyEnrollmentAction,
  type EnrollPayload,
  type ActionResult,
} from "./actions";
import type { StaffSession } from "@/lib/auth/require-staff";

interface Props {
  role: StaffSession["role"];
}

export function EnrollForm({ role }: Props) {
  const [enroll, setEnroll] = useState<EnrollPayload | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [verifyState, verifyAction, verifyPending] = useActionState<
    ActionResult | null,
    FormData
  >(verifyEnrollmentAction, null);

  // Auto-start enrollment for admin (it's required) so they don't need an
  // extra click. Other roles see a "Begin setup" button — for them the
  // page is only reachable via opt-in, so a confirm step is friendlier.
  useEffect(() => {
    if (role !== "admin" || enroll || starting) return;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
        <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          {role === "admin"
            ? "MFA is required for admin accounts"
            : "Set up two-factor authentication"}
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
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Scan the QR code
      </h2>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Open your authenticator app, add a new account, and scan this code.
        Then type the 6-digit code it shows.
      </p>

      <div className="mt-4 flex justify-center rounded-lg bg-white p-3">
        <Image
          src={enroll.qrCode}
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
          Save this somewhere safe — if you lose your authenticator and your
          recovery contact, an admin must reset MFA via the database.
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
    </div>
  );
}
