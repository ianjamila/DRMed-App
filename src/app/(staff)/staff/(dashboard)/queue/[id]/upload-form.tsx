"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  uploadResultAction,
  type UploadResult,
} from "./actions";

interface Props {
  testRequestId: string;
}

export function UploadResultForm({ testRequestId }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<UploadResult | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        start(async () => {
          const result = await uploadResultAction(testRequestId, formData);
          setState(result);
          if (result.ok) router.refresh();
        });
      }}
      className="grid gap-4"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="file">PDF result</Label>
        <input
          id="file"
          name="file"
          type="file"
          accept="application/pdf"
          required
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Max 10 MB. PDF only.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Internal notes (optional)</Label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={2000}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Visible to staff only — never shown to the patient.
        </p>
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="text-sm text-emerald-700" role="status">
          ✓ Uploaded. The test status moved forward.
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
        className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        {pending ? "Uploading…" : "Upload result"}
      </Button>
    </form>
  );
}
