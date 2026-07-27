"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StableInput } from "@/components/forms/stable-fields";
import {
  createDiscountTypeAction,
  updateDiscountTypeAction,
  type DiscountTypeResult,
} from "./actions";

interface DiscountTypeDefaults {
  id?: string;
  code?: string;
  label?: string;
  kind?: "percent" | "fixed" | "custom";
  percent?: number | null;
  amount_php?: number | null;
  is_statutory?: boolean;
  active?: boolean;
  sort_order?: number | null;
}

interface Props {
  initial?: DiscountTypeDefaults;
}

export function DiscountTypeForm({ initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);
  const isStatutory = Boolean(initial?.is_statutory);
  const isCustomKind = initial?.kind === "custom";
  // Built-in rows (statutory Senior/PWD + the counter-typed custom row) only
  // allow label / active / order edits; the rate is locked.
  const isBuiltin = isStatutory || isCustomKind;

  const [kind, setKind] = useState<"percent" | "fixed">(
    initial?.kind === "fixed" ? "fixed" : "percent",
  );

  const action = isEdit
    ? updateDiscountTypeAction.bind(null, initial!.id!)
    : createDiscountTypeAction;

  const [state, formAction, pending] = useActionState<
    DiscountTypeResult | null,
    FormData
  >(action, null);

  return (
    <form action={formAction} className="grid gap-5">
      {isStatutory ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Senior / PWD is the statutory discount (RA 9994 / RA 10754). The 20%
          rate is set by law — only the display label and ordering can change,
          and it can&apos;t be switched off.
        </p>
      ) : null}
      {isCustomKind ? (
        <p className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-3 py-2 text-sm text-[color:var(--color-brand-text-soft)]">
          This is the counter-typed discount — reception enters the peso amount
          per line, so it has no rate of its own.
        </p>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="label">Label</Label>
        <StableInput
          id="label"
          name="label"
          required
          maxLength={80}
          defaultValue={initial?.label ?? ""}
          placeholder="e.g. Employee 15% off"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Shown to reception in the new-visit form and on the visit detail.
        </p>
      </div>

      {isEdit && initial?.code ? (
        <div className="grid gap-1.5">
          <Label htmlFor="code_display">Code</Label>
          <input
            id="code_display"
            value={initial.code}
            disabled
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-3 py-2 font-mono text-sm text-[color:var(--color-brand-text-soft)]"
          />
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            Fixed once created — past visits and the accounting export refer to
            it.
          </p>
        </div>
      ) : null}

      {!isBuiltin ? (
        <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-4">
          <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Rate
          </legend>

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="kind"
                value="percent"
                checked={kind === "percent"}
                onChange={() => setKind("percent")}
              />
              <span>Percent off</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="kind"
                value="fixed"
                checked={kind === "fixed"}
                onChange={() => setKind("fixed")}
              />
              <span>Fixed peso amount</span>
            </label>
          </div>

          {kind === "percent" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="percent">Percent (%)</Label>
              <StableInput
                id="percent"
                name="percent"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                required
                defaultValue={
                  initial?.percent != null ? String(initial.percent) : ""
                }
                placeholder="e.g. 10"
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="amount_php">Amount (₱)</Label>
              <StableInput
                id="amount_php"
                name="amount_php"
                type="number"
                min="0.01"
                step="0.01"
                required
                defaultValue={
                  initial?.amount_php != null ? String(initial.amount_php) : ""
                }
                placeholder="e.g. 50"
              />
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                Capped at the line&apos;s price — a ₱50 discount on a ₱30 test
                takes it to ₱0, never below.
              </p>
            </div>
          )}
        </fieldset>
      ) : null}

      {!isStatutory ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="active"
            defaultChecked={initial?.active ?? true}
          />
          <span>
            Active — appears in reception&apos;s discount dropdown. Past visits
            keep their recorded discount either way.
          </span>
        </label>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="sort_order">Order</Label>
        <StableInput
          id="sort_order"
          name="sort_order"
          type="number"
          min="0"
          max="9999"
          step="1"
          defaultValue={
            initial?.sort_order != null ? String(initial.sort_order) : ""
          }
          placeholder="e.g. 100"
        />
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Lower numbers list first in the dropdown.
        </p>
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
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create discount"}
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
