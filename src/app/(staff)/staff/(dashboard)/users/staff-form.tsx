"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  StableInput,
  StableSelect,
} from "@/components/forms/stable-fields";
import {
  createStaffUserAction,
  updateStaffUserAction,
  type StaffResult,
} from "./actions";

interface StaffDefaults {
  id?: string;
  email?: string;
  full_name: string;
  role:
    | "reception"
    | "medtech"
    | "pathologist"
    | "admin"
    | "xray_technician";
  is_active?: boolean;
  // PRC license info — drives the medtech signature line on auto-generated
  // result PDFs. Optional; only meaningful for medtech / pathologist /
  // xray_technician roles.
  prc_license_kind?: "RMT" | "MD" | "RT" | "pathologist" | null;
  prc_license_no?: string | null;
}

interface Props {
  initial?: StaffDefaults;
  // H7: true when this form is an admin editing their OWN account. The role
  // select and Active checkbox stay visible but non-changeable so an admin
  // can't lock themselves out — the server action enforces the same rule
  // (see admin-lockout.ts), this just keeps the form from offering a change
  // it will reject anyway.
  isSelf?: boolean;
}

const ROLE_OPTIONS: { value: StaffDefaults["role"]; label: string }[] = [
  { value: "reception", label: "Reception" },
  { value: "medtech", label: "Medical Tech" },
  { value: "xray_technician", label: "X-ray Technician" },
  { value: "pathologist", label: "Pathologist" },
  { value: "admin", label: "Admin" },
];

export function StaffForm({ initial, isSelf = false }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);

  const action = isEdit
    ? updateStaffUserAction.bind(null, initial!.id!)
    : createStaffUserAction;

  const [state, formAction, pending] = useActionState<
    StaffResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <StableInput
          id="email"
          name="email"
          type="email"
          required={!isEdit}
          disabled={isEdit}
          defaultValue={initial?.email ?? ""}
          placeholder="staff@drmed.ph"
        />
        {isEdit ? (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Change the sign-in email in the “Sign-in email” panel below.
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="full_name">Full name</Label>
        <StableInput
          id="full_name"
          name="full_name"
          required
          defaultValue={initial?.full_name ?? ""}
          maxLength={160}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="role">Role</Label>
        <StableSelect
          id="role"
          name="role"
          required
          defaultValue={initial?.role ?? "reception"}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          {ROLE_OPTIONS.map((r) => (
            <option
              key={r.value}
              value={r.value}
              disabled={isSelf && r.value !== "admin"}
            >
              {r.label}
            </option>
          ))}
        </StableSelect>
        {isSelf ? (
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            You can&apos;t change your own role. Ask another admin.
          </p>
        ) : null}
      </div>

      {!isEdit ? (
        <div className="grid gap-1.5">
          <Label htmlFor="password">Initial password</Label>
          <StableInput
            id="password"
            name="password"
            type="text"
            required
            minLength={10}
            placeholder="At least 10 characters"
            autoComplete="off"
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Share securely with the new staff member. They can change it via
            password reset after signing in.
          </p>
        </div>
      ) : (
        <>
          {isSelf ? (
            <>
              {/* Disabled checkboxes don't submit — the hidden input keeps
                  is_active=true in the payload while the visible control
                  can't be unticked. */}
              <input type="hidden" name="is_active" value="true" />
              <label className="flex items-center gap-2 text-sm text-[color:var(--color-brand-text-soft)]">
                <input type="checkbox" checked disabled readOnly />
                <span>
                  Active — you can&apos;t deactivate your own account. Ask
                  another admin.
                </span>
              </label>
            </>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="is_active"
                defaultChecked={initial?.is_active ?? true}
              />
              <span>Active (can sign into the staff portal)</span>
            </label>
          )}

          <fieldset className="grid gap-3 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
            <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              PRC license
            </legend>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Printed on the signature line of every result PDF this user
              finalises. Required for medtechs and pathologists; optional for
              other roles.
            </p>

            <div className="grid gap-1.5">
              <Label htmlFor="prc_license_kind">License kind</Label>
              <StableSelect
                id="prc_license_kind"
                name="prc_license_kind"
                defaultValue={initial?.prc_license_kind ?? ""}
                className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              >
                <option value="">— None —</option>
                <option value="RMT">RMT (Medical Tech)</option>
                <option value="MD">MD (Physician)</option>
                <option value="RT">RT (Rad Tech)</option>
                <option value="pathologist">Pathologist</option>
              </StableSelect>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="prc_license_no">License number</Label>
              <StableInput
                id="prc_license_no"
                name="prc_license_no"
                defaultValue={initial?.prc_license_no ?? ""}
                maxLength={40}
                placeholder="e.g. 0063443"
                autoComplete="off"
              />
            </div>
          </fieldset>
        </>
      )}

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      {state && state.ok && state.message ? (
        <p
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
        >
          {state.message}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create staff user"}
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
