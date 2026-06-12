"use client";

import { useActionState } from "react";
import {
  StableInput,
  StableTextarea,
} from "@/components/forms/stable-fields";
import { submitContactMessage, type ContactResult } from "./actions";

// Subject options for the select (C15 enhancement).
const SUBJECT_OPTIONS = [
  "Doctor's Consultation",
  "Laboratory Tests",
  "X-Ray Imaging",
  "ECG",
  "Ultrasound",
  "Home Service",
  "Corporate / HMO",
  "Other",
] as const;

// Shared field input class applied to inputs and textarea.
const fieldInput =
  "w-full rounded-[12px] border border-[color:var(--color-warm-line)] bg-white px-[13px] text-[15px] text-[color:var(--color-ink)] outline-none transition focus:border-[color:var(--color-brand-cyan)] focus:shadow-[0_0_0_3px_rgba(8,168,226,0.22)]";

// Shared label class.
const fieldLabel = "text-[13.5px] font-semibold text-[color:var(--color-ink)]";

export function ContactForm() {
  const [state, formAction, pending] = useActionState<
    ContactResult | null,
    FormData
  >(submitContactMessage, null);

  if (state?.ok) {
    return (
      <div className="rounded-[16px] border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-warm-bg)] p-8">
        <h3 className="font-[family-name:var(--font-display)] text-xl text-[color:var(--color-brand-navy)]">
          Thank you — we received your message.
        </h3>
        <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
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

      {/* Row 1: Name + Email */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className={fieldLabel}>
            Name
          </label>
          <StableInput
            id="name"
            name="name"
            required
            maxLength={120}
            className={`${fieldInput} h-[46px]`}
            placeholder="Juan dela Cruz"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className={fieldLabel}>
            Email{" "}
            <span className="font-normal text-[color:var(--color-ink-soft)]">
              (optional)
            </span>
          </label>
          <StableInput
            id="email"
            name="email"
            type="email"
            maxLength={160}
            className={`${fieldInput} h-[46px]`}
            placeholder="juan@email.com"
          />
        </div>
      </div>

      {/* Row 2: Phone + Subject (select) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="phone" className={fieldLabel}>
            Phone{" "}
            <span className="font-normal text-[color:var(--color-ink-soft)]">
              (optional)
            </span>
          </label>
          <StableInput
            id="phone"
            name="phone"
            maxLength={40}
            className={`${fieldInput} h-[46px]`}
            placeholder="0916 000 0000"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          {/* C15: subject changed from StableInput text to a <select>. A
              select's value isn't wiped on re-render the way an uncontrolled
              text input would be, so StableSelect isn't needed here. */}
          <label htmlFor="subject" className={fieldLabel}>
            Service{" "}
            <span className="font-normal text-[color:var(--color-ink-soft)]">
              (optional)
            </span>
          </label>
          <select
            id="subject"
            name="subject"
            defaultValue=""
            className={`${fieldInput} h-[46px] cursor-pointer appearance-none`}
          >
            <option value="" disabled>
              Select a service
            </option>
            {SUBJECT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Message */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="message" className={fieldLabel}>
          Message
        </label>
        <StableTextarea
          id="message"
          name="message"
          required
          rows={5}
          maxLength={5000}
          placeholder="How can we help?"
          className={`${fieldInput} py-[11px]`}
        />
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center rounded-full bg-[color:var(--color-brand-cyan)] px-6 py-3 text-sm font-bold text-[color:var(--color-ink)] transition-all hover:-translate-y-px hover:bg-[color:var(--color-brand-navy)] hover:text-white disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send us a Message"}
      </button>
    </form>
  );
}
