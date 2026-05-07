"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  StableInput,
  StableTextarea,
} from "@/components/forms/stable-fields";
import { submitContactMessage, type ContactResult } from "./actions";

export function ContactForm() {
  const [state, formAction, pending] = useActionState<
    ContactResult | null,
    FormData
  >(submitContactMessage, null);

  if (state?.ok) {
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-8">
        <h3 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Thank you — we received your message.
        </h3>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
          Our team will respond during operating hours. For urgent concerns,
          please call us directly.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="grid gap-4">
      {/* Honeypot — hidden from real users via aria-hidden + tabindex. */}
      <div
        aria-hidden="true"
        style={{ position: "absolute", left: "-9999px" }}
      >
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <StableInput id="name" name="name" required maxLength={120} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="email">Email (optional)</Label>
          <StableInput id="email" name="email" type="email" maxLength={160} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="phone">Phone (optional)</Label>
          <StableInput id="phone" name="phone" maxLength={40} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="subject">Subject</Label>
          <StableInput
            id="subject"
            name="subject"
            placeholder="e.g. Appointment, HMO, corporate package"
            maxLength={160}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="message">Message</Label>
        <StableTextarea
          id="message"
          name="message"
          required
          rows={5}
          maxLength={5000}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
        className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        {pending ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}
