"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitBookingAction, type BookingResult } from "./actions";

interface ServiceLite {
  id: string;
  code: string;
  name: string;
}

interface Props {
  services: ServiceLite[];
  defaultMin: string; // local datetime-local string for `min`
  defaultMax: string;
}

export function BookingForm({ services, defaultMin, defaultMax }: Props) {
  const [state, formAction, pending] = useActionState<
    BookingResult | null,
    FormData
  >(submitBookingAction, null);

  if (state?.ok && state.appointment_id) {
    const when = state.scheduled_at
      ? new Date(state.scheduled_at).toLocaleString("en-PH", {
          dateStyle: "long",
          timeStyle: "short",
        })
      : "";
    return (
      <div className="rounded-2xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-8">
        <h3 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          Booking confirmed.
        </h3>
        <p className="mt-3 text-base text-[color:var(--color-brand-text-mid)]">
          {state.service_name} · {when}
        </p>
        <div className="mt-5 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Your DRM-ID
          </p>
          <p className="mt-1 font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            {state.drm_id}
          </p>
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            Save this. After your visit, your Secure PIN is printed on the
            receipt — both are required to access results online.
          </p>
        </div>
        <p className="mt-5 text-sm text-[color:var(--color-brand-text-mid)]">
          We&apos;ve sent SMS + email confirmation with a cancel link. See
          you soon.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="grid gap-4">
      {/* Honeypot */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" name="first_name" required maxLength={80} />
        <Field label="Last name" name="last_name" required maxLength={80} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Middle name (optional)" name="middle_name" maxLength={80} />
        <Field label="Birthdate" name="birthdate" type="date" required />
        <div className="grid gap-1.5">
          <Label htmlFor="sex">Sex</Label>
          <select
            id="sex"
            name="sex"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">—</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Phone"
          name="phone"
          type="tel"
          required
          placeholder="+639XXXXXXXXX or 09XX..."
          maxLength={40}
        />
        <Field label="Email" name="email" type="email" required maxLength={160} />
      </div>

      <Field label="Address (optional)" name="address" maxLength={200} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="service_id">Service</Label>
          <select
            id="service_id"
            name="service_id"
            required
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">— Pick a service —</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="scheduled_at">Date and time</Label>
          <Input
            id="scheduled_at"
            name="scheduled_at"
            type="datetime-local"
            required
            min={defaultMin}
            max={defaultMax}
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Mon–Sat, 8 AM – 5 PM. Up to 60 days ahead.
          </p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={2000}
          placeholder="HMO, fasting needed, mobility, etc."
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
        {pending ? "Booking…" : "Confirm booking"}
      </Button>

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        By submitting, you agree to receive SMS + email confirmation. Your
        details are processed under the Philippine Data Privacy Act
        (RA 10173). See our{" "}
        <a
          href="/privacy"
          className="text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Privacy Notice
        </a>
        .
      </p>
    </form>
  );
}

interface FieldProps {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
}

function Field({ label, name, type = "text", ...rest }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} {...rest} />
    </div>
  );
}
