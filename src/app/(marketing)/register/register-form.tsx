"use client";

import * as React from "react";
import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { submitRegistrationAction, type RegistrationResult } from "./actions";

// The text/email/tel/date fields use the shared <Input> (h-11 + focus ring,
// matching /schedule). Only the <select> keeps this hand-rolled class — with a
// matching focus ring + 44px min-height for parity.
const INPUT =
  "w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm min-h-[44px] focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/40";

export function RegisterForm() {
  const [state, formAction, pending] = useActionState<RegistrationResult | null, FormData>(
    submitRegistrationAction,
    null,
  );

  const [f, setF] = React.useState({
    first_name: "",
    last_name: "",
    middle_name: "",
    birthdate: "",
    sex: "" as "" | "male" | "female",
    phone: "",
    email: "",
    address: "",
    data_privacy_consent: false,
    marketing_consent: false,
  });

  if (state?.ok && state.matched === false) {
    return (
      <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-6 text-center">
        <h2 className="font-heading text-xl font-extrabold text-emerald-900">You&apos;re registered.</h2>
        <p className="mt-3 text-sm text-emerald-900">Your DRM-ID</p>
        <p className="font-mono text-2xl font-bold text-emerald-900">{state.drm_id}</p>
        <p className="mt-3 text-sm text-emerald-800">
          We&apos;ve emailed it to you too. Show this at the clinic — reception verifies your identity at the counter.
        </p>
      </div>
    );
  }
  if (state?.ok && state.matched === true) {
    return (
      <div className="rounded-xl border border-sky-300 bg-sky-50 p-6 text-center">
        <h2 className="font-heading text-xl font-extrabold text-sky-900">We found your record.</h2>
        <p className="mt-3 text-sm text-sky-900">
          It looks like you&apos;re already in our system — we&apos;ve emailed your DRM-ID to the address on file. Check your inbox,
          or visit reception if you don&apos;t receive it.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* Honeypot — hidden from humans, bots fill it. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          First name
          <Input name="first_name" required value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Last name
          <Input name="last_name" required value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Middle name (optional)
          <Input name="middle_name" value={f.middle_name} onChange={(e) => setF({ ...f, middle_name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Birthdate
          <Input type="date" name="birthdate" required value={f.birthdate} onChange={(e) => setF({ ...f, birthdate: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Sex
          <select name="sex" value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value as "" | "male" | "female" })} className={INPUT}>
            <option value="">—</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Phone
          <Input type="tel" name="phone" required placeholder="+639XXXXXXXXX or 09XX…" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Email
        <Input type="email" name="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">We email your DRM-ID here.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Address (optional)
        <Input name="address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="data_privacy_consent"
          required
          checked={f.data_privacy_consent}
          onChange={(e) => setF({ ...f, data_privacy_consent: e.target.checked })}
          className="mt-1 h-5 w-5"
        />
        <span>
          I consent to drmed.ph processing my personal and health information for registration and care under the Philippine
          Data Privacy Act (RA 10173). See the{" "}
          <a href="/privacy" className="underline" target="_blank" rel="noreferrer">Privacy Notice</a>.
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="marketing_consent"
          checked={f.marketing_consent}
          onChange={(e) => setF({ ...f, marketing_consent: e.target.checked })}
          className="mt-1"
        />
        <span className="text-[color:var(--color-brand-text-soft)]">
          Optional: send me occasional updates on new tests, promos, and announcements. One-click unsubscribe in every email.
        </span>
      </label>

      {state && !state.ok && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2.5 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-60"
      >
        {pending ? "Registering…" : "Register"}
      </button>
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        New patients are pre-registered — reception verifies your identity at the counter on arrival.
      </p>
    </form>
  );
}
