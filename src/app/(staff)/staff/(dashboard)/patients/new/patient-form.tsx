"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createPatientAction,
  type PatientCreateResult,
} from "../actions";

export function PatientForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<
    PatientCreateResult | null,
    FormData
  >(createPatientAction, null);

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" name="first_name" required maxLength={80} />
        <Field label="Last name" name="last_name" required maxLength={80} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Middle name (optional)" name="middle_name" maxLength={80} />
        <Field label="Birthdate" name="birthdate" type="date" required />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
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
        <Field
          label="Phone"
          name="phone"
          placeholder="+639XXXXXXXXX"
          maxLength={40}
        />
        <Field label="Email" name="email" type="email" maxLength={160} />
      </div>

      <Field label="Address" name="address" maxLength={160} />

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
          {pending ? "Saving…" : "Create patient"}
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
}

function Field({ label, name, type = "text", ...rest }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} {...rest} />
    </div>
  );
}
