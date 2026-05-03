"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SlotPicker,
  type ClosureLite,
} from "@/components/marketing/slot-picker";
import { submitBookingAction, type BookingResult } from "./actions";

export type ServiceKind = "lab_test" | "lab_package" | "doctor_consultation";

interface ServiceLite {
  id: string;
  code: string;
  name: string;
  kind: ServiceKind;
}

type Branch = "lab" | "doctor";

interface Props {
  services: ServiceLite[];
  closures: ClosureLite[];
  startDate: string; // tomorrow Manila YYYY-MM-DD
}

export function BookingForm({ services, closures, startDate }: Props) {
  const [state, formAction, pending] = useActionState<
    BookingResult | null,
    FormData
  >(submitBookingAction, null);
  const [branch, setBranch] = useState<Branch>("lab");

  const filteredServices = useMemo(
    () =>
      services.filter((s) =>
        branch === "lab"
          ? s.kind === "lab_test" || s.kind === "lab_package"
          : s.kind === "doctor_consultation",
      ),
    [services, branch],
  );

  if (state?.ok && state.appointment_id) {
    const when = state.scheduled_at
      ? new Date(state.scheduled_at).toLocaleString("en-PH", {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: "Asia/Manila",
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
    <form action={formAction} className="grid gap-5">
      {/* Honeypot */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          What are you booking?
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <BranchOption
            checked={branch === "lab"}
            onChange={() => setBranch("lab")}
            value="lab"
            title="Laboratory request"
            blurb="Blood work, urinalysis, ECG, X-ray, ultrasound, panels."
          />
          <BranchOption
            checked={branch === "doctor"}
            onChange={() => setBranch("doctor")}
            value="doctor"
            title="Doctor appointment"
            blurb="Consultation with one of our specialists."
          />
        </div>
      </fieldset>

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

      <div className="grid gap-1.5">
        <Label htmlFor="service_id">
          {branch === "lab" ? "Lab service" : "Specialty"}
        </Label>
        {/* Re-mount the select when branch changes so the value resets. */}
        <select
          key={branch}
          id="service_id"
          name="service_id"
          required
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">
            — Pick a {branch === "lab" ? "service" : "specialty"} —
          </option>
          {filteredServices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </select>
        {branch === "doctor" ? (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Reception assigns the specific doctor based on availability —
            we&apos;ll confirm by SMS/email after booking.
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4">
        <SlotPicker startDate={startDate} closures={closures} />
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

interface BranchOptionProps {
  checked: boolean;
  onChange: () => void;
  value: Branch;
  title: string;
  blurb: string;
}

function BranchOption({
  checked,
  onChange,
  value,
  title,
  blurb,
}: BranchOptionProps) {
  return (
    <label
      className={`flex cursor-pointer flex-col rounded-xl border p-4 transition ${
        checked
          ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] shadow"
          : "border-[color:var(--color-brand-bg-mid)] bg-white hover:border-[color:var(--color-brand-cyan)]"
      }`}
    >
      <input
        type="radio"
        name="branch"
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span className="text-sm font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </span>
      <span className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        {blurb}
      </span>
    </label>
  );
}
