"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction, updateVendorAction } from "@/lib/actions/accounting/vendors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CircleAlert } from "lucide-react";

type CoaAccount = { id: string; code: string; name: string };

type VendorInitial = {
  name: string;
  tin: string | null;
  email: string | null;
  phone: string | null;
  default_account_id: string | null;
  default_wt_classification: string | null;
  default_wt_rate: number | null;
  notes: string | null;
};

type Props =
  | { mode: "create"; vendorId?: undefined; initial?: undefined; expenseAccounts: CoaAccount[] }
  | { mode: "edit"; vendorId: string; initial: VendorInitial; expenseAccounts: CoaAccount[] };

export function VendorFormClient(props: Props) {
  const { mode, expenseAccounts } = props;
  const router = useRouter();
  const [form, setForm] = useState({
    name: props.initial?.name ?? "",
    tin: props.initial?.tin ?? "",
    email: props.initial?.email ?? "",
    phone: props.initial?.phone ?? "",
    default_account_id: props.initial?.default_account_id ?? "",
    default_wt_classification: props.initial?.default_wt_classification ?? "",
    default_wt_rate:
      props.initial?.default_wt_rate == null ? "" : String(props.initial.default_wt_rate),
    notes: props.initial?.notes ?? "",
  });
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldError(null);

    const payload = {
      name: form.name.trim(),
      tin: form.tin.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      default_account_id: form.default_account_id || null,
      default_wt_classification: form.default_wt_classification.trim() || null,
      default_wt_rate: form.default_wt_rate === "" ? null : Number(form.default_wt_rate),
      notes: form.notes.trim() || null,
    };

    startTransition(async () => {
      const r =
        mode === "create"
          ? await createVendorAction(payload)
          : await updateVendorAction(props.vendorId, payload);

      if (r.ok) {
        const targetId = mode === "create" ? r.data.id : props.vendorId;
        router.push(`/staff/admin/accounting/ap/vendors/${targetId}`);
      } else {
        setError(r.error);
        setFieldError(r.field ?? null);
      }
    });
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.4 · Admin · AP · Vendor
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {mode === "create" ? "New vendor" : "Edit vendor"}
        </h1>
      </header>

      <form onSubmit={submit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Field label="Name *" error={fieldError === "name" ? error : null}>
          <input
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="TIN (optional)" error={fieldError === "tin" ? error : null}>
          <input
            value={form.tin}
            onChange={(e) => setForm((f) => ({ ...f, tin: e.target.value }))}
            placeholder="123-456-789 or 123-456-789-000"
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Email" error={fieldError === "email" ? error : null}>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>
          <Field label="Phone">
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>
        </div>

        <Field
          label="Default account"
          help="Used as the default debit line when posting bills for this vendor. Picks from active debit-normal accounts (expenses, assets, contra-revenue)."
        >
          <select
            value={form.default_account_id}
            onChange={(e) => setForm((f) => ({ ...f, default_account_id: e.target.value }))}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">(none — pick per-bill)</option>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="Default WT classification"
            help="BIR code like WI160, WI100, WI010, WC010."
          >
            <input
              value={form.default_wt_classification}
              onChange={(e) =>
                setForm((f) => ({ ...f, default_wt_classification: e.target.value }))
              }
              placeholder="WI160"
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>
          <Field
            label="Default WT rate"
            help="Decimal — 0.0200 = 2%."
            error={fieldError === "default_wt_rate" ? error : null}
          >
            <input
              type="number"
              step="0.0001"
              min="0"
              max="1"
              value={form.default_wt_rate}
              onChange={(e) => setForm((f) => ({ ...f, default_wt_rate: e.target.value }))}
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={3}
            className="min-h-[88px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="min-h-[44px] w-full rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50 sm:w-auto"
          >
            {isPending ? "Saving…" : mode === "create" ? "Create vendor" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="min-h-[44px] rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
  help,
  error,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
  error?: string | null;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
      {help && (
        <span className="mt-1 block text-xs text-[color:var(--color-brand-text-soft)]">
          {help}
        </span>
      )}
      {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
    </label>
  );
}
