"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  generateBatchAction,
  type GiftCodeResult,
} from "../actions";

export function GenerateBatchForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<
    GiftCodeResult | null,
    FormData
  >(generateBatchAction, null);

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="count">How many codes?</Label>
          <Input
            id="count"
            name="count"
            type="number"
            min="1"
            max="100"
            step="1"
            required
            defaultValue="10"
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Up to 100 per batch.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="face_value_php">Face value (PHP)</Label>
          <Input
            id="face_value_php"
            name="face_value_php"
            type="number"
            min="1"
            step="1"
            required
            defaultValue="500"
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="batch_label">Batch label (optional)</Label>
        <Input
          id="batch_label"
          name="batch_label"
          maxLength={120}
          placeholder="e.g. Holiday 2026"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Used to filter the list and find the codes you just minted.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={2000}
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
          {pending ? "Generating…" : "Generate batch"}
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
