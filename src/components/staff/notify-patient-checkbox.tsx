"use client";

import type { NotifyOffer } from "@/lib/results/copy-followups";

// Opt-in "let the patient know" checkbox for a result edit form (0179). The
// server re-checks the offer before sending — this box only asks; it never
// sends by itself. `checked`/`onChange` are omitted for the one uncontrolled
// FormData form (amend-form.tsx's uploaded branch), which reads the box via
// its `name` on submit instead.
export function NotifyPatientCheckbox({
  offer,
  checked,
  onChange,
  name,
  id,
}: {
  offer: NotifyOffer;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  name?: string;
  id: string;
}) {
  if (!offer.offered) {
    return (
      <p className="text-xs text-slate-500">
        Patient notice not available: {offer.reason}
      </p>
    );
  }
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        name={name}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
      />
      <span>
        Let the patient know an updated copy is ready
        <span className="block text-xs text-slate-500">
          Sends one email/SMS. It never says why the result changed.
        </span>
      </span>
    </label>
  );
}
