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
  createPhysicianAction,
  updatePhysicianAction,
  type PhysicianResult,
} from "./actions";

export interface PhysicianDefaults {
  id?: string;
  slug?: string;
  full_name?: string;
  specialty?: string;
  group_label?: string | null;
  bio?: string | null;
  is_active?: boolean;
  display_order?: number;
}

interface Props {
  initial?: PhysicianDefaults;
}

export function PhysicianForm({ initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const action = isEdit
    ? updatePhysicianAction.bind(null, initial!.id!)
    : createPhysicianAction;
  const [state, formAction, pending] = useActionState<
    PhysicianResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="full_name">Full name</Label>
        <StableInput
          id="full_name"
          name="full_name"
          required
          maxLength={160}
          defaultValue={initial?.full_name ?? ""}
          placeholder="Dr. Juan dela Cruz"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="slug">Slug</Label>
          <StableInput
            id="slug"
            name="slug"
            required
            maxLength={80}
            pattern="[a-z0-9-]+"
            defaultValue={initial?.slug ?? ""}
            placeholder="juan-dela-cruz"
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            URL-friendly identifier. Used as the photo filename.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="display_order">Display order</Label>
          <StableInput
            id="display_order"
            name="display_order"
            type="number"
            min="0"
            max="9999"
            step="1"
            defaultValue={String(initial?.display_order ?? 0)}
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Lower numbers show first on /physicians.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="specialty">Specialty</Label>
          <StableInput
            id="specialty"
            name="specialty"
            required
            maxLength={160}
            defaultValue={initial?.specialty ?? ""}
            placeholder="Internal Medicine · Cardiologist"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="group_label">Group (optional)</Label>
          <StableInput
            id="group_label"
            name="group_label"
            maxLength={160}
            defaultValue={initial?.group_label ?? ""}
            placeholder="Internal Medicine Subspecialties"
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="bio">Bio (optional)</Label>
        <StableTextarea
          id="bio"
          name="bio"
          rows={4}
          maxLength={4000}
          defaultValue={initial?.bio ?? ""}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="is_active"
          defaultChecked={initial?.is_active ?? true}
        />
        <span>
          Active — appears on /physicians and in the booking picker.
        </span>
      </label>

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
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create physician"}
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
