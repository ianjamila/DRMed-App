"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  uploadPhotoAction,
  type PhysicianResult,
} from "../../actions";

interface Props {
  physicianId: string;
  currentUrl: string;
}

export function PhotoUpload({ physicianId, currentUrl }: Props) {
  const action = uploadPhotoAction.bind(null, physicianId);
  const [state, formAction, pending] = useActionState<
    PhysicianResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-3">
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentUrl}
          alt="Current photo"
          className="h-20 w-20 rounded-full object-cover ring-2 ring-[color:var(--color-brand-bg-mid)]"
        />
        <div className="flex-1">
          <Label htmlFor="photo">Replace photo</Label>
          <input
            id="photo"
            name="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            required
            className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[color:var(--color-brand-bg)] file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-[color:var(--color-brand-navy)] hover:file:bg-[color:var(--color-brand-bg-mid)]"
          />
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            JPG, PNG, or WebP up to 5 MB.
          </p>
        </div>
      </div>

      {state && state.ok ? (
        <p className="text-sm text-emerald-700">Photo updated.</p>
      ) : null}
      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div>
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Uploading…" : "Upload photo"}
        </Button>
      </div>
    </form>
  );
}
