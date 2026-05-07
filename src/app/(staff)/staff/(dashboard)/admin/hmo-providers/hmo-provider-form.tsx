"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  StableInput,
  StableTextarea,
} from "@/components/forms/stable-fields";
import {
  createHmoProviderAction,
  updateHmoProviderAction,
  type HmoProviderResult,
} from "./actions";

interface ProviderDefaults {
  id?: string;
  name?: string;
  is_active?: boolean;
  due_days_for_invoice?: number | null;
  contract_start_date?: string | null;
  contract_end_date?: string | null;
  contact_person_name?: string | null;
  contact_person_address?: string | null;
  contact_person_phone?: string | null;
  contact_person_email?: string | null;
  notes?: string | null;
}

interface Props {
  initial?: ProviderDefaults;
}

export function HmoProviderForm({ initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const action = isEdit
    ? updateHmoProviderAction.bind(null, initial!.id!)
    : createHmoProviderAction;

  const [state, formAction, pending] = useActionState<
    HmoProviderResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="name">Provider name</Label>
        <StableInput
          id="name"
          name="name"
          required
          maxLength={120}
          defaultValue={initial?.name ?? ""}
          placeholder="e.g. Maxicare"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="is_active"
          defaultChecked={initial?.is_active ?? true}
        />
        <span>Active — appears in reception&apos;s HMO dropdown.</span>
      </label>

      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Contract
        </legend>

        <div className="grid gap-1.5">
          <Label htmlFor="due_days_for_invoice">Days to pay invoice</Label>
          <StableInput
            id="due_days_for_invoice"
            name="due_days_for_invoice"
            type="number"
            min="0"
            max="365"
            step="1"
            defaultValue={
              initial?.due_days_for_invoice != null
                ? String(initial.due_days_for_invoice)
                : ""
            }
            placeholder="e.g. 30"
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Used by the HMO receivables dashboard to flag overdue invoices.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="contract_start_date">Start date</Label>
            <StableInput
              id="contract_start_date"
              name="contract_start_date"
              type="date"
              defaultValue={initial?.contract_start_date ?? ""}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="contract_end_date">End date</Label>
            <StableInput
              id="contract_end_date"
              name="contract_end_date"
              type="date"
              defaultValue={initial?.contract_end_date ?? ""}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Primary contact
        </legend>

        <div className="grid gap-1.5">
          <Label htmlFor="contact_person_name">Name</Label>
          <StableInput
            id="contact_person_name"
            name="contact_person_name"
            defaultValue={initial?.contact_person_name ?? ""}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="contact_person_address">Address</Label>
          <StableInput
            id="contact_person_address"
            name="contact_person_address"
            defaultValue={initial?.contact_person_address ?? ""}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="contact_person_phone">Phone</Label>
            <StableInput
              id="contact_person_phone"
              name="contact_person_phone"
              defaultValue={initial?.contact_person_phone ?? ""}
              placeholder="0917…"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="contact_person_email">Email</Label>
            <StableInput
              id="contact_person_email"
              name="contact_person_email"
              type="email"
              defaultValue={initial?.contact_person_email ?? ""}
            />
          </div>
        </div>
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes</Label>
        <StableTextarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={initial?.notes ?? ""}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

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
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create provider"}
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
