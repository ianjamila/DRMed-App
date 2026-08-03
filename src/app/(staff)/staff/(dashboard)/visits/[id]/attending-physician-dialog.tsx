"use client";

import { useState, useTransition } from "react";
import { setVisitAttendingPhysician } from "@/lib/actions/accounting/visits-attending";

interface PhysicianOption {
  id: string;
  full_name: string;
}

// Item 23 gap 3: the visit-level "Assign/Change physician" affordance —
// same inline-expand pattern as undo-release-dialog / waive-balance-dialog.
// Fixes the P0034 dead-end: intake lets a doctor line through with no
// physician, but the release trigger requires coalesce(test_requests.
// attending_physician_id, visits.attending_physician_id) to be non-null, and
// until this component there was no UI anywhere to set it after the visit
// was created.
export function AttendingPhysicianDialog({
  visitId,
  currentPhysicianId,
  currentPhysicianName,
  physicians,
  prominent = false,
}: {
  visitId: string;
  currentPhysicianId: string | null;
  currentPhysicianName: string | null;
  // Active physicians only, ordered like the new-visit picker. If the
  // visit's current physician has since been deactivated, they're appended
  // below so the dropdown never silently drops the recorded name.
  physicians: PhysicianOption[];
  // When true, renders as a loud CTA instead of the subtle "Change" link —
  // used when the visit has doctor lines and no physician set yet.
  prominent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(currentPhysicianId ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const options =
    currentPhysicianId && !physicians.some((p) => p.id === currentPhysicianId)
      ? [
          ...physicians,
          {
            id: currentPhysicianId,
            full_name: `${currentPhysicianName ?? "Unknown"} (inactive)`,
          },
        ]
      : physicians;

  function onSave() {
    startTransition(async () => {
      setErr(null);
      const result = await setVisitAttendingPhysician({
        visit_id: visitId,
        attending_physician_id: selected === "" ? null : selected,
      });
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          prominent
            ? "min-h-[44px] rounded-md bg-amber-700 px-3 text-xs font-bold uppercase tracking-wider text-white hover:bg-amber-800"
            : "text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        }
      >
        {prominent ? "Assign physician" : "Change"}
      </button>
    );
  }

  return (
    <div className="w-72 space-y-2 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-2 text-left text-xs">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
      >
        <option value="">— None —</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name}
          </option>
        ))}
      </select>
      {err ? <p className="text-red-600">{err}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setSelected(currentPhysicianId ?? "");
            setErr(null);
          }}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
