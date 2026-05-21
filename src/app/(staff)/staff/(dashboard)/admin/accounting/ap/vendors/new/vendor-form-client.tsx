"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction, updateVendorAction } from "@/lib/actions/accounting/vendors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CircleAlert } from "lucide-react";

const selectClassName =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

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
          <Input
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>

        <Field label="TIN (optional)" error={fieldError === "tin" ? error : null}>
          <Input
            value={form.tin}
            onChange={(e) => setForm((f) => ({ ...f, tin: e.target.value }))}
            placeholder="123-456-789 or 123-456-789-000"
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Email" error={fieldError === "email" ? error : null}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
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
            className={selectClassName}
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
            <Input
              value={form.default_wt_classification}
              onChange={(e) =>
                setForm((f) => ({ ...f, default_wt_classification: e.target.value }))
              }
              placeholder="WI160"
            />
          </Field>
          <Field
            label="Default WT rate"
            help="Decimal — 0.0200 = 2%."
            error={fieldError === "default_wt_rate" ? error : null}
          >
            <Input
              type="number"
              step="0.0001"
              min="0"
              max="1"
              value={form.default_wt_rate}
              onChange={(e) => setForm((f) => ({ ...f, default_wt_rate: e.target.value }))}
            />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={3}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="brand"
            size="touch"
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            {isPending ? "Saving…" : mode === "create" ? "Create vendor" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => router.back()}
          >
            Cancel
          </Button>
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
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
