"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createPatientAction,
  type PatientCreateResult,
} from "./actions";
import {
  updatePatientAction,
  type PatientUpdateResult,
} from "./[id]/edit-actions";

interface PatientDefaults {
  id?: string;
  first_name?: string;
  last_name?: string;
  middle_name?: string | null;
  birthdate?: string | null;
  sex?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  referral_source?: string | null;
  referred_by_doctor?: string | null;
  preferred_release_medium?: string | null;
  senior_pwd_id_kind?: string | null;
  senior_pwd_id_number?: string | null;
  consent_signed_at?: string | null;
}

interface Props {
  initial?: PatientDefaults;
}

const REFERRAL_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "doctor_referral", label: "Doctor referral" },
  { value: "customer_referral", label: "Customer referral" },
  { value: "online_facebook", label: "Facebook" },
  { value: "online_website", label: "Website" },
  { value: "online_google", label: "Google" },
  { value: "walk_in", label: "Walk-in" },
  { value: "tenant_employee_northridge", label: "Northridge tenant / employee" },
  { value: "other", label: "Other" },
];

const RELEASE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "physical", label: "Physical pickup at clinic" },
  { value: "email", label: "Email" },
  { value: "viber", label: "Viber" },
  { value: "gcash", label: "GCash" },
  { value: "pickup", label: "Pickup at counter" },
];

export function PatientForm({ initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const action = isEdit
    ? updatePatientAction.bind(null, initial!.id!)
    : createPatientAction;

  const [state, formAction, pending] = useActionState<
    PatientCreateResult | PatientUpdateResult | null,
    FormData
  >(action, null);

  const [referralSource, setReferralSource] = useState<string>(
    initial?.referral_source ?? "",
  );

  const consentAlreadySigned = !!initial?.consent_signed_at;

  return (
    <form action={formAction} className="grid gap-5">
      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Identity
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="First name"
            name="first_name"
            required
            maxLength={80}
            defaultValue={initial?.first_name ?? ""}
          />
          <Field
            label="Last name"
            name="last_name"
            required
            maxLength={80}
            defaultValue={initial?.last_name ?? ""}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Middle name (optional)"
            name="middle_name"
            maxLength={80}
            defaultValue={initial?.middle_name ?? ""}
          />
          <Field
            label="Birthdate"
            name="birthdate"
            type="date"
            required
            defaultValue={initial?.birthdate ?? ""}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sex">Sex</Label>
            <select
              id="sex"
              name="sex"
              defaultValue={initial?.sex ?? ""}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>
          <Field
            label="Phone"
            name="phone"
            placeholder="+639XXXXXXXXX"
            maxLength={40}
            defaultValue={initial?.phone ?? ""}
          />
          <Field
            label="Email"
            name="email"
            type="email"
            maxLength={160}
            defaultValue={initial?.email ?? ""}
          />
        </div>
        <Field
          label="Address"
          name="address"
          maxLength={240}
          defaultValue={initial?.address ?? ""}
        />
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Marketing & preferences
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="referral_source">Referral source</Label>
            <select
              id="referral_source"
              name="referral_source"
              value={referralSource}
              onChange={(e) => setReferralSource(e.target.value)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              {REFERRAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="preferred_release_medium">
              Preferred result release
            </Label>
            <select
              id="preferred_release_medium"
              name="preferred_release_medium"
              defaultValue={initial?.preferred_release_medium ?? ""}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              {RELEASE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {referralSource === "doctor_referral" ? (
          <Field
            label="Referred by doctor"
            name="referred_by_doctor"
            maxLength={120}
            placeholder="e.g. DR. KATHERINE GAYO"
            defaultValue={initial?.referred_by_doctor ?? ""}
          />
        ) : (
          <input
            type="hidden"
            name="referred_by_doctor"
            value={initial?.referred_by_doctor ?? ""}
          />
        )}
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Senior / PWD ID (optional)
        </legend>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Recorded once at registration so reception doesn&apos;t re-ask each
          visit. Required to apply the Sr/PWD discount on a test request line.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="senior_pwd_id_kind">ID kind</Label>
            <select
              id="senior_pwd_id_kind"
              name="senior_pwd_id_kind"
              defaultValue={initial?.senior_pwd_id_kind ?? ""}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">— None —</option>
              <option value="senior">Senior Citizen</option>
              <option value="pwd">PWD</option>
            </select>
          </div>
          <Field
            label="ID number"
            name="senior_pwd_id_number"
            maxLength={40}
            defaultValue={initial?.senior_pwd_id_number ?? ""}
          />
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Data privacy consent (RA 10173)
        </legend>
        {consentAlreadySigned ? (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            ✓ Consent already on file (signed{" "}
            {new Date(initial!.consent_signed_at!).toLocaleDateString("en-PH")})
          </p>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="consent_given_today"
              className="mt-1"
            />
            <span>
              Patient has signed the printed registration & consent form today.
              Required before reception can release any results.
            </span>
          </label>
        )}
      </fieldset>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create patient"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
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
  defaultValue?: string;
}

function Field({ label, name, type = "text", ...rest }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} {...rest} />
    </div>
  );
}
