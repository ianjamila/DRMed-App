"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPhp } from "@/lib/marketing/format";
import {
  createServiceAction,
  updateServiceAction,
  type ServiceResult,
} from "./actions";

const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "lab_test", label: "Lab test" },
  { value: "lab_package", label: "Lab package" },
  { value: "doctor_consultation", label: "Doctor consultation" },
  { value: "doctor_procedure", label: "Doctor procedure" },
  { value: "home_service", label: "Home service" },
  { value: "vaccine", label: "Vaccine" },
];

const SECTION_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "— None —" },
  { value: "package", label: "Package" },
  { value: "chemistry", label: "Chemistry" },
  { value: "hematology", label: "Hematology" },
  { value: "immunology", label: "Immunology" },
  { value: "urinalysis", label: "Urinalysis" },
  { value: "microbiology", label: "Microbiology" },
  { value: "imaging_xray", label: "Imaging — X-Ray" },
  { value: "imaging_ultrasound", label: "Imaging — Ultrasound" },
  { value: "vaccine", label: "Vaccine" },
  { value: "send_out", label: "Send-out" },
  { value: "consultation", label: "Consultation" },
  { value: "procedure", label: "Procedure" },
  { value: "home_service", label: "Home service" },
];

interface ServiceDefaults {
  id?: string;
  code: string;
  name: string;
  description: string | null;
  price_php: number | string;
  hmo_price_php: number | string | null;
  senior_discount_php: number | string | null;
  turnaround_hours: number | null;
  kind: string;
  section: string | null;
  is_send_out: boolean;
  send_out_lab: string | null;
  is_active: boolean;
  requires_signoff: boolean;
}

interface Props {
  initial?: ServiceDefaults;
}

function n(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(x) ? x : null;
}

export function ServiceForm({ initial }: Props) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);

  const action = isEdit
    ? updateServiceAction.bind(null, initial!.id!)
    : createServiceAction;

  const [state, formAction, pending] = useActionState<
    ServiceResult | null,
    FormData
  >(action, null);

  const formRef = useRef<HTMLFormElement>(null);
  const skipConfirmRef = useRef(false);
  const [confirming, setConfirming] = useState<{
    next: { price: number | null; hmo: number | null; senior: number | null };
  } | null>(null);

  // Intercept submit to surface a confirmation when any price field has changed.
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (!isEdit || !initial) return;
    if (skipConfirmRef.current) {
      skipConfirmRef.current = false;
      return;
    }
    const fd = new FormData(e.currentTarget);
    const next = {
      price: n(fd.get("price_php") as string),
      hmo: n(fd.get("hmo_price_php") as string),
      senior: n(fd.get("senior_discount_php") as string),
    };
    const prior = {
      price: n(initial.price_php),
      hmo: n(initial.hmo_price_php),
      senior: n(initial.senior_discount_php),
    };
    const changed =
      next.price !== prior.price ||
      next.hmo !== prior.hmo ||
      next.senior !== prior.senior;
    if (changed) {
      e.preventDefault();
      setConfirming({ next });
    }
  }

  return (
    <>
      <form
        ref={formRef}
        action={formAction}
        onSubmit={onSubmit}
        className="grid gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              name="code"
              required
              defaultValue={initial?.code ?? ""}
              placeholder="e.g. CBC"
              maxLength={40}
              className="font-mono uppercase"
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              required
              defaultValue={initial?.name ?? ""}
              maxLength={160}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="description">Description (optional)</Label>
          <textarea
            id="description"
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={initial?.description ?? ""}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </div>

        <fieldset className="grid gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)]/30 p-4 sm:grid-cols-3">
          <legend className="px-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Pricing
          </legend>
          <div className="grid gap-1.5">
            <Label htmlFor="price_php">DRMed price (PHP)</Label>
            <Input
              id="price_php"
              name="price_php"
              type="number"
              step="0.01"
              min="0"
              required
              defaultValue={initial?.price_php?.toString() ?? "0"}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="hmo_price_php">HMO price (PHP, optional)</Label>
            <Input
              id="hmo_price_php"
              name="hmo_price_php"
              type="number"
              step="0.01"
              min="0"
              defaultValue={initial?.hmo_price_php?.toString() ?? ""}
            />
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Leave blank if not HMO billable.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="senior_discount_php">
              Senior discount (PHP, optional)
            </Label>
            <Input
              id="senior_discount_php"
              name="senior_discount_php"
              type="number"
              step="0.01"
              min="0"
              defaultValue={initial?.senior_discount_php?.toString() ?? ""}
            />
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Peso amount, not a percentage.
            </p>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="turnaround_hours">
              Turnaround (hours, optional)
            </Label>
            <Input
              id="turnaround_hours"
              name="turnaround_hours"
              type="number"
              min="1"
              step="1"
              defaultValue={initial?.turnaround_hours?.toString() ?? ""}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="kind">Kind</Label>
            <select
              id="kind"
              name="kind"
              defaultValue={initial?.kind ?? "lab_test"}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="section">Section</Label>
            <select
              id="section"
              name="section"
              defaultValue={initial?.section ?? ""}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              {SECTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="is_send_out"
              defaultChecked={initial?.is_send_out ?? false}
            />
            <span>Send-out test</span>
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="send_out_lab">Send-out lab (optional)</Label>
            <Input
              id="send_out_lab"
              name="send_out_lab"
              maxLength={160}
              defaultValue={initial?.send_out_lab ?? ""}
              placeholder="e.g. Hi Precision"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="is_active"
              defaultChecked={initial?.is_active ?? true}
            />
            <span>Active (visible on the marketing site)</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="requires_signoff"
              defaultChecked={initial?.requires_signoff ?? false}
            />
            <span>Requires pathologist sign-off</span>
          </label>
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
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create service"}
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

      {confirming ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="price-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="price-confirm-title"
              className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
            >
              Confirm price change
            </h2>
            <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
              This change will be recorded in price history with your name.
              Continue?
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <dt className="text-[color:var(--color-brand-text-soft)]">
                DRMed
              </dt>
              <dd className="text-right font-semibold">
                {n(initial?.price_php) != null
                  ? formatPhp(n(initial?.price_php)!)
                  : "—"}{" "}
                →{" "}
                {confirming.next.price != null
                  ? formatPhp(confirming.next.price)
                  : "—"}
              </dd>
              <dt className="text-[color:var(--color-brand-text-soft)]">HMO</dt>
              <dd className="text-right font-semibold">
                {n(initial?.hmo_price_php) != null
                  ? formatPhp(n(initial?.hmo_price_php)!)
                  : "—"}{" "}
                →{" "}
                {confirming.next.hmo != null
                  ? formatPhp(confirming.next.hmo)
                  : "—"}
              </dd>
              <dt className="text-[color:var(--color-brand-text-soft)]">
                Senior disc.
              </dt>
              <dd className="text-right font-semibold">
                {n(initial?.senior_discount_php) != null
                  ? formatPhp(n(initial?.senior_discount_php)!)
                  : "—"}{" "}
                →{" "}
                {confirming.next.senior != null
                  ? formatPhp(confirming.next.senior)
                  : "—"}
              </dd>
            </dl>
            <div className="mt-6 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
                onClick={() => {
                  setConfirming(null);
                  skipConfirmRef.current = true;
                  formRef.current?.requestSubmit();
                }}
              >
                Yes, save
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
