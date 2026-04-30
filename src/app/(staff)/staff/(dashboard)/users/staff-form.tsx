"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createStaffUserAction,
  updateStaffUserAction,
  type StaffResult,
} from "./actions";

interface StaffDefaults {
  id?: string;
  email?: string;
  full_name: string;
  role: "reception" | "medtech" | "pathologist" | "admin";
  is_active?: boolean;
}

interface Props {
  initial?: StaffDefaults;
}

const ROLE_OPTIONS: { value: StaffDefaults["role"]; label: string }[] = [
  { value: "reception", label: "Reception" },
  { value: "medtech", label: "Medical Tech" },
  { value: "pathologist", label: "Pathologist" },
  { value: "admin", label: "Admin" },
];

export function StaffForm({ initial }: Props) {
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
        <Input
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
            Email cannot be changed here. Contact Supabase support if needed.
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="full_name">Full name</Label>
        <Input
          id="full_name"
          name="full_name"
          required
          defaultValue={initial?.full_name ?? ""}
          maxLength={160}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="role">Role</Label>
        <select
          id="role"
          name="role"
          required
          defaultValue={initial?.role ?? "reception"}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {!isEdit ? (
        <div className="grid gap-1.5">
          <Label htmlFor="password">Initial password</Label>
          <Input
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_active"
            defaultChecked={initial?.is_active ?? true}
          />
          <span>Active (can sign into the staff portal)</span>
        </label>
      )}

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
