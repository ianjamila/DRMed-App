"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { emailStatementAction } from "./email-action";

// "Email to patient" — same inline-expand confirm as undo-release: the
// address is shown before anything is sent, so reception can read it back to
// the patient. It only ever goes to the email on the patient's record.
export function EmailStatementButton({
  visitId,
  patientId,
  patientEmail,
}: {
  visitId: string;
  patientId: string;
  patientEmail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const email = patientEmail?.trim() || null;

  if (!email) {
    return (
      <p className="max-w-56 text-right text-xs text-[color:var(--color-brand-text-soft)]">
        No email on file —{" "}
        <Link
          href={`/staff/patients/${patientId}/edit`}
          className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          add one
        </Link>{" "}
        to email this statement.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] rounded-md border border-[color:var(--color-brand-navy)] px-4 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
      >
        Email to patient
      </button>
    );
  }

  function onSend() {
    startTransition(async () => {
      setErr(null);
      const result = await emailStatementAction(visitId);
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      toast.success(`Statement emailed to ${result.data.to}`);
      setOpen(false);
    });
  }

  return (
    <div
      role="group"
      aria-label="Email the statement"
      className="w-72 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3 text-left text-xs"
    >
      <p className="text-[color:var(--color-brand-text-mid)]">
        Send this statement to <b className="break-all">{email}</b>? Read the
        address back to the patient first. The send is audit-logged.
      </p>
      {err ? (
        <p role="alert" className="text-red-600">
          {err}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSend}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send email"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setErr(null);
          }}
          disabled={pending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
