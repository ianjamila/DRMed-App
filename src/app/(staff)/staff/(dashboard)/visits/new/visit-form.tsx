"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatPhp } from "@/lib/marketing/format";
import { createVisitAction, type CreateVisitResult } from "./actions";

interface ServiceLite {
  id: string;
  code: string;
  name: string;
  price_php: number;
}

interface PatientLite {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
}

interface Props {
  services: ServiceLite[];
  patient: PatientLite;
}

export function VisitForm({ services, patient }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, formAction, pending] = useActionState<
    CreateVisitResult | null,
    FormData
  >(createVisitAction, null);

  const total = useMemo(
    () =>
      services
        .filter((s) => selected.has(s.id))
        .reduce((sum, s) => sum + Number(s.price_php), 0),
    [selected, services],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <form action={formAction} className="grid gap-6">
      <input type="hidden" name="patient_id" value={patient.id} />

      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4 text-sm">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Patient
        </p>
        <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
          {patient.last_name}, {patient.first_name}{" "}
          <span className="font-mono text-[color:var(--color-brand-text-soft)]">
            ({patient.drm_id})
          </span>
        </p>
      </div>

      <div>
        <Label className="text-sm">Select services</Label>
        <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
          Each selection becomes a test request on this visit.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {services.map((s) => {
            const checked = selected.has(s.id);
            return (
              <label
                key={s.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                  checked
                    ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)]"
                    : "border-[color:var(--color-brand-bg-mid)] bg-white hover:bg-[color:var(--color-brand-bg)]"
                }`}
              >
                <input
                  type="checkbox"
                  name="service_ids"
                  value={s.id}
                  checked={checked}
                  onChange={() => toggle(s.id)}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="block font-semibold text-[color:var(--color-brand-navy)]">
                    {s.name}
                  </span>
                  <span className="block text-xs text-[color:var(--color-brand-text-soft)]">
                    {s.code}
                  </span>
                </span>
                <span className="font-semibold text-[color:var(--color-brand-cyan)]">
                  {formatPhp(s.price_php)}
                </span>
              </label>
            );
          })}
        </div>
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

      <div className="flex items-center justify-between rounded-xl bg-[color:var(--color-brand-navy)] p-4 text-white">
        <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Total
        </span>
        <span className="font-[family-name:var(--font-heading)] text-2xl font-extrabold">
          {formatPhp(total)}
        </span>
      </div>

      {state && !state.ok ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={pending || selected.size === 0}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Creating visit…" : "Create visit & issue PIN"}
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

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        After save, a 60-day Secure PIN is issued and shown ONCE on the
        printable receipt. The patient uses it to access lab results online.
      </p>
    </form>
  );
}
