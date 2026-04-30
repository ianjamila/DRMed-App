"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createServiceAction,
  updateServiceAction,
  type ServiceResult,
} from "./actions";

interface ServiceDefaults {
  id?: string;
  code: string;
  name: string;
  description: string | null;
  price_php: number | string;
  turnaround_hours: number | null;
  is_active: boolean;
  requires_signoff: boolean;
}

interface Props {
  initial?: ServiceDefaults;
}

export function ServiceForm({ initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);

  const action = isEdit
    ? updateServiceAction.bind(null, initial!.id!)
    : createServiceAction;

  const [state, formAction, pending] = useActionState<
    ServiceResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            name="code"
            required
            defaultValue={initial?.code ?? ""}
            placeholder="e.g. CBC"
            maxLength={40}
            className="font-mono uppercase"
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            required
            defaultValue={initial?.name ?? ""}
            maxLength={160}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="description">Description (optional)</Label>
        <textarea
          id="description"
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={initial?.description ?? ""}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="price_php">Price (PHP)</Label>
          <Input
            id="price_php"
            name="price_php"
            type="number"
            step="0.01"
            min="0"
            required
            defaultValue={initial?.price_php?.toString() ?? "0"}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="turnaround_hours">Turnaround (hours, optional)</Label>
          <Input
            id="turnaround_hours"
            name="turnaround_hours"
            type="number"
            min="1"
            step="1"
            defaultValue={initial?.turnaround_hours?.toString() ?? ""}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_active"
            defaultChecked={initial?.is_active ?? true}
          />
          <span>Active (visible on the marketing site)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="requires_signoff"
            defaultChecked={initial?.requires_signoff ?? false}
          />
          <span>Requires pathologist sign-off</span>
        </label>
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
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create service"}
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
