"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPhp } from "@/lib/marketing/format";
import { createVisitAction, type CreateVisitResult } from "./actions";

export interface ServiceLite {
  id: string;
  code: string;
  name: string;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
}

interface PatientLite {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
}

interface HmoProviderLite {
  id: string;
  name: string;
}

interface Props {
  services: ServiceLite[];
  patient: PatientLite;
  hmoProviders: HmoProviderLite[];
}

// Discount kinds match the test_requests.discount_kind check constraint.
type DiscountKind =
  | ""
  | "senior_pwd_20"
  | "pct_10"
  | "pct_5"
  | "other_pct_20"
  | "custom";

interface LineState {
  discountKind: DiscountKind;
  customDiscount: string; // raw input; parsed at submit time
}

const DISCOUNT_OPTIONS: { value: DiscountKind; label: string }[] = [
  { value: "", label: "No discount" },
  { value: "senior_pwd_20", label: "Senior / PWD 20%" },
  { value: "pct_10", label: "10% off" },
  { value: "pct_5", label: "5% off" },
  { value: "other_pct_20", label: "Other 20% off" },
  { value: "custom", label: "Custom amount (₱)" },
];

function basePriceFor(s: ServiceLite, hmoSelected: boolean): number {
  if (hmoSelected && s.hmo_price_php != null) return s.hmo_price_php;
  return s.price_php;
}

function discountFor(
  s: ServiceLite,
  base: number,
  kind: DiscountKind,
  customRaw: string,
): number {
  switch (kind) {
    case "senior_pwd_20":
      // Use the curated peso amount on the service when the lab has set
      // one; otherwise fall back to the statutory 20%.
      return s.senior_discount_php != null
        ? Math.min(s.senior_discount_php, base)
        : Math.round(base * 0.2 * 100) / 100;
    case "pct_10":
      return Math.round(base * 0.1 * 100) / 100;
    case "pct_5":
      return Math.round(base * 0.05 * 100) / 100;
    case "other_pct_20":
      return Math.round(base * 0.2 * 100) / 100;
    case "custom": {
      const n = Number(customRaw);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(n, base);
    }
    default:
      return 0;
  }
}

export function VisitForm({ services, patient, hmoProviders }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hmoProviderId, setHmoProviderId] = useState<string>("");
  const [lineState, setLineState] = useState<Record<string, LineState>>({});
  const [state, formAction, pending] = useActionState<
    CreateVisitResult | null,
    FormData
  >(createVisitAction, null);

  const hmoSelected = hmoProviderId !== "";

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function getLine(id: string): LineState {
    return lineState[id] ?? { discountKind: "", customDiscount: "" };
  }

  function updateLine(id: string, patch: Partial<LineState>) {
    setLineState((prev) => ({ ...prev, [id]: { ...getLine(id), ...patch } }));
  }

  // Per-line computed values, recomputed when HMO / discount / selection changes.
  const lines = useMemo(() => {
    return services
      .filter((s) => selected.has(s.id))
      .map((s) => {
        const ls = getLine(s.id);
        const base = basePriceFor(s, hmoSelected);
        const discount = discountFor(s, base, ls.discountKind, ls.customDiscount);
        const final = Math.max(0, base - discount);
        return { service: s, base, discount, final, ls };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, selected, hmoSelected, lineState]);

  const total = lines.reduce((sum, l) => sum + l.final, 0);

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

      <fieldset className="grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] p-4">
        <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          HMO authorisation (optional)
        </legend>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Selecting a provider switches each service to its HMO price (when
          set on the service) and stamps the authorisation onto every test
          request created on this visit.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1 sm:col-span-3">
            <Label htmlFor="hmo_provider_id">Provider</Label>
            <select
              id="hmo_provider_id"
              name="hmo_provider_id"
              value={hmoProviderId}
              onChange={(e) => setHmoProviderId(e.target.value)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              <option value="">— Cash / no HMO —</option>
              {hmoProviders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
          {hmoSelected ? (
            <>
              <div className="grid gap-1">
                <Label htmlFor="hmo_approval_date">Approval date</Label>
                <Input
                  id="hmo_approval_date"
                  name="hmo_approval_date"
                  type="date"
                />
              </div>
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="hmo_authorization_no">Authorization no.</Label>
                <Input
                  id="hmo_authorization_no"
                  name="hmo_authorization_no"
                  maxLength={80}
                  placeholder="e.g. ABC-123456"
                />
              </div>
            </>
          ) : null}
        </div>
      </fieldset>

      <div>
        <Label className="text-sm">Select services</Label>
        <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
          Pick services first; per-line discounts appear once selected.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {services.map((s) => {
            const checked = selected.has(s.id);
            const display = basePriceFor(s, hmoSelected);
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
                  {formatPhp(display)}
                  {hmoSelected && s.hmo_price_php != null ? (
                    <span className="ml-1 text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      hmo
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {lines.length > 0 ? (
        <fieldset className="grid gap-2 rounded-xl border border-[color:var(--color-brand-bg-mid)] p-4">
          <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Line discounts
          </legend>
          <div className="overflow-hidden rounded-lg border border-[color:var(--color-brand-bg-mid)]">
            <div className="grid grid-cols-12 gap-2 bg-[color:var(--color-brand-bg)] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <div className="col-span-12 sm:col-span-4">Test</div>
              <div className="col-span-6 sm:col-span-3">Discount kind</div>
              <div className="col-span-6 sm:col-span-2 text-right">Base</div>
              <div className="col-span-6 sm:col-span-1 text-right">Discount</div>
              <div className="col-span-6 sm:col-span-2 text-right">Final</div>
            </div>
            {lines.map(({ service: s, base, discount, final, ls }) => (
              <div
                key={s.id}
                className="grid grid-cols-12 items-center gap-2 border-t border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
              >
                <div className="col-span-12 sm:col-span-4">
                  <p className="font-semibold text-[color:var(--color-brand-navy)]">
                    {s.name}
                  </p>
                  <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                    {s.code}
                  </p>
                </div>
                <div className="col-span-6 sm:col-span-3">
                  <select
                    name={`discount_kind__${s.id}`}
                    value={ls.discountKind}
                    onChange={(e) =>
                      updateLine(s.id, {
                        discountKind: e.target.value as DiscountKind,
                      })
                    }
                    className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                  >
                    {DISCOUNT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {ls.discountKind === "custom" ? (
                    <input
                      name={`custom_discount__${s.id}`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={ls.customDiscount}
                      onChange={(e) =>
                        updateLine(s.id, { customDiscount: e.target.value })
                      }
                      placeholder="₱"
                      className="mt-1 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 font-mono text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                    />
                  ) : null}
                </div>
                <div className="col-span-6 sm:col-span-2 text-right font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  {formatPhp(base)}
                </div>
                <div className="col-span-6 sm:col-span-1 text-right font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  {discount > 0 ? `−${formatPhp(discount)}` : "—"}
                </div>
                <div className="col-span-6 sm:col-span-2 text-right font-mono text-sm font-semibold text-[color:var(--color-brand-navy)]">
                  {formatPhp(final)}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="receptionist_remarks">Receptionist initials</Label>
          <Input
            id="receptionist_remarks"
            name="receptionist_remarks"
            maxLength={40}
            placeholder="e.g. JD"
          />
          <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
            Stamped on each test_request line for the export.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="notes">Visit notes (optional)</Label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={2000}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </div>
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
