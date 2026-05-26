"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInventoryItem, updateInventoryItem } from "./actions";

const SECTIONS = [
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "imaging_xray",
  "imaging_ultrasound",
  "send_out",
  "front_desk",
  "general",
] as const;

interface VendorOption {
  id: string;
  name: string;
}

interface InitialItem {
  id: string;
  code: string | null;
  name: string;
  section: string | null;
  unit: string;
  reorder_threshold: number;
  expiry_tracking: boolean;
  vendor_id: string | null;
  notes: string | null;
  is_active: boolean;
}

export function ItemForm({
  vendors,
  initial,
}: {
  vendors: VendorOption[];
  initial?: InitialItem;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [section, setSection] = useState(initial?.section ?? "");
  const [unit, setUnit] = useState(initial?.unit ?? "pcs");
  const [reorderThreshold, setReorderThreshold] = useState(
    String(initial?.reorder_threshold ?? 0),
  );
  const [expiryTracking, setExpiryTracking] = useState(
    initial?.expiry_tracking ?? false,
  );
  const [vendorId, setVendorId] = useState(initial?.vendor_id ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = {
      code: code.trim() || null,
      name: name.trim(),
      section: section || null,
      unit: unit.trim(),
      reorder_threshold: Number(reorderThreshold) || 0,
      expiry_tracking: expiryTracking,
      vendor_id: vendorId || null,
      notes: notes.trim() || null,
      is_active: isActive,
    };
    startTransition(async () => {
      const r = isEdit
        ? await updateInventoryItem(initial!.id, payload)
        : await createInventoryItem(payload);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/staff/admin/inventory/${r.data.id}`);
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Code (optional)
          </span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={40}
            placeholder="e.g. REG-CBC-100"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Section
          </span>
          <select
            value={section}
            onChange={(e) => setSection(e.target.value)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {SECTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Unit
          </span>
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            required
            maxLength={20}
            placeholder="pcs / ml / box"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Reorder threshold
          </span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={reorderThreshold}
            onChange={(e) => setReorderThreshold(e.target.value)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
            Below this, the item flags as Low.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Default vendor (optional)
          </span>
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={expiryTracking}
            onChange={(e) => setExpiryTracking(e.target.checked)}
          />
          Track expiry dates (reagents, vaccines)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Active
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
        />
      </label>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)] disabled:cursor-not-allowed disabled:bg-[color:var(--color-brand-bg-mid)] disabled:text-[color:var(--color-brand-text-soft)]"
        >
          {pending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create item"}
        </button>
      </div>
    </form>
  );
}
