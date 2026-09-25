"use client";

import { useState, useTransition } from "react";
import { emailMyStatementAction } from "./email-action";

// "Email it to me" — the patient's own copy, to the address on their record.
// Inline confirm (no browser dialog) naming the address, then an inline
// outcome: the portal has no toast host.
export function PatientEmailStatementButton({
  visitId,
  email,
}: {
  visitId: string;
  email: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!email) {
    return (
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        To have it emailed, ask reception to add your email address.
      </p>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-navy)] px-4 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          Email it to me
        </button>
        {message ? (
          <p
            role={message.ok ? "status" : "alert"}
            className={`max-w-64 text-right text-xs ${message.ok ? "text-emerald-700" : "text-red-600"}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    );
  }

  function onSend() {
    startTransition(async () => {
      const result = await emailMyStatementAction(visitId);
      setMessage(
        result.ok
          ? { ok: true, text: `Sent to ${result.data.to}. Check your inbox (and spam folder).` }
          : { ok: false, text: result.error },
      );
      setOpen(false);
    });
  }

  return (
    <div
      role="group"
      aria-label="Email my statement"
      className="w-72 max-w-full space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3 text-left text-xs"
    >
      <p className="text-[color:var(--color-brand-text-mid)]">
        Send this statement to <b className="break-all">{email}</b>?
      </p>
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
          onClick={() => setOpen(false)}
          disabled={pending}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
