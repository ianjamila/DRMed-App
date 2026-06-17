"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  checkPatientDuplicatesAction,
  type PublicCandidate,
} from "@/lib/patients/check-duplicates-action";
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
  referralOptions: { value: string; label: string }[];
}

const RELEASE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "physical", label: "Physical pickup at clinic" },
  { value: "email", label: "Email" },
  { value: "viber", label: "Viber" },
  { value: "gcash", label: "GCash" },
  { value: "pickup", label: "Pickup at counter" },
];

export function PatientForm({ initial, referralOptions }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const action = isEdit
    ? updatePatientAction.bind(null, initial!.id!)
    : createPatientAction;

  const [state, formAction, pending] = useActionState<
    PatientCreateResult | PatientUpdateResult | null,
    FormData
  >(action, null);

  // Selects also need controlled state so React 19's form-action reset
  // doesn't blank them out on validation error.
  const [referralSource, setReferralSource] = useState<string>(
    initial?.referral_source ?? "",
  );
  const [sex, setSex] = useState<string>(initial?.sex ?? "");
  const [releaseMedium, setReleaseMedium] = useState<string>(
    initial?.preferred_release_medium ?? "",
  );
  const [seniorPwdKind, setSeniorPwdKind] = useState<string>(
    initial?.senior_pwd_id_kind ?? "",
  );
  const [consentSignatory, setConsentSignatory] = useState<string>("self");

  const consentAlreadySigned = !!initial?.consent_signed_at;

  // Near-match advisory (create mode only). Fields are tracked via onValueChange
  // callbacks because the inputs are self-controlled inside <Field>.
  const [dupFields, setDupFields] = useState({
    first_name: initial?.first_name ?? "",
    last_name: initial?.last_name ?? "",
    birthdate: initial?.birthdate ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
  });
  const [dupCandidates, setDupCandidates] = useState<PublicCandidate[]>([]);

  useEffect(() => {
    if (isEdit) return;
    if (
      !dupFields.last_name.trim() ||
      (!dupFields.email && !dupFields.phone && !dupFields.birthdate)
    ) {
      setDupCandidates([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await checkPatientDuplicatesAction({
        first_name: dupFields.first_name,
        last_name: dupFields.last_name,
        birthdate: dupFields.birthdate || null,
        email: dupFields.email || null,
        phone: dupFields.phone || null,
      });
      if (res.ok) setDupCandidates(res.candidates);
    }, 400);
    return () => clearTimeout(t);
  }, [
    isEdit,
    dupFields.first_name,
    dupFields.last_name,
    dupFields.birthdate,
    dupFields.email,
    dupFields.phone,
  ]);

  return (
    <form
      action={formAction}
      className="grid gap-5"
      onSubmit={(e) => {
        const hasExact = dupCandidates.some((c) => c.tier === "exact_dup");
        if (
          hasExact &&
          !window.confirm(
            "This looks like an exact match for an existing patient. Create a SEPARATE record anyway?",
          )
        ) {
          e.preventDefault();
        }
      }}
    >
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
            onValueChange={(v) => setDupFields((f) => ({ ...f, first_name: v }))}
          />
          <Field
            label="Last name"
            name="last_name"
            required
            maxLength={80}
            defaultValue={initial?.last_name ?? ""}
            onValueChange={(v) => setDupFields((f) => ({ ...f, last_name: v }))}
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
            onValueChange={(v) => setDupFields((f) => ({ ...f, birthdate: v }))}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sex">Sex</Label>
            <select
              id="sex"
              name="sex"
              value={sex}
              onChange={(e) => setSex(e.target.value)}
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
            onValueChange={(v) => setDupFields((f) => ({ ...f, phone: v }))}
          />
          <Field
            label="Email"
            name="email"
            type="email"
            maxLength={160}
            defaultValue={initial?.email ?? ""}
            onValueChange={(v) => setDupFields((f) => ({ ...f, email: v }))}
          />
        </div>
        <Field
          label="Address"
          name="address"
          maxLength={240}
          defaultValue={initial?.address ?? ""}
        />
      </fieldset>

      {!isEdit && dupCandidates.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="mb-2 font-semibold text-amber-900">
            Possible existing patient{dupCandidates.length > 1 ? "s" : ""}:
          </p>
          <ul className="space-y-2">
            {dupCandidates.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-amber-900">
                  {c.first_name} {c.last_name} · {c.drm_id} ·{" "}
                  {c.birthdate ?? "—"}
                  {c.tier === "exact_dup" && (
                    <span className="ml-1 font-bold text-red-700">
                      exact match
                    </span>
                  )}
                </span>
                <Link
                  href={`/staff/patients/${c.id}`}
                  className="shrink-0 rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                >
                  Use this patient
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

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
              {referralOptions.map((o) => (
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
              value={releaseMedium}
              onChange={(e) => setReleaseMedium(e.target.value)}
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
              value={seniorPwdKind}
              onChange={(e) => setSeniorPwdKind(e.target.value)}
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
          <Alert variant="success">
            <AlertDescription>
              ✓ Consent already on file (signed{" "}
              {new Date(initial!.consent_signed_at!).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })})
            </AlertDescription>
          </Alert>
        ) : (
          <>
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
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="consent_signatory">Signed by</Label>
                <select
                  id="consent_signatory"
                  name="consent_signatory"
                  value={consentSignatory}
                  onChange={(e) => setConsentSignatory(e.target.value)}
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                >
                  <option value="self">Patient signed</option>
                  <option value="guardian">Guardian signed</option>
                  <option value="representative">Representative signed</option>
                </select>
              </div>
              <Field
                label="Signatory name (if not patient)"
                name="consent_signatory_name"
                placeholder="Full name"
              />
              <Field
                label="Relationship"
                name="consent_signatory_relationship"
                placeholder="e.g. Mother"
              />
            </div>
          </>
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
  onValueChange?: (value: string) => void;
}

function Field({
  label,
  name,
  type = "text",
  defaultValue = "",
  onValueChange,
  ...rest
}: FieldProps) {
  // Self-controlled to survive React 19's form-action reset on error.
  const [value, setValue] = useState(defaultValue);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onValueChange?.(e.target.value);
        }}
        {...rest}
      />
    </div>
  );
}
