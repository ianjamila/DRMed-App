"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createRecurringTemplateAction,
  updateRecurringTemplateAction,
  deactivateRecurringTemplateAction,
  reactivateRecurringTemplateAction,
} from "@/lib/actions/accounting/recurring-templates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CircleAlert } from "lucide-react";
import { StatusBadge } from "@/lib/ui/status-badge";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Account = { id: string; code: string; name: string };
type Vendor = { id: string; name: string };

// Matches TemplateRow returned by listRecurringTemplatesAction (vendor_name is flattened).
type Template = {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  description: string;
  cadence: string;
  due_day_of_month: number;
  bill_date_offset_days: number;
  amount_php: number | null;
  default_account_id: string;
  default_wt_classification: string | null;
  default_wt_rate: number | null;
  default_wt_exempt: boolean;
  next_run_date: string;
  is_active: boolean;
  created_at: string;
};

type EditMode = { kind: "new" } | { kind: "edit"; template: Template } | null;

export function RecurringClient({
  initialTemplates,
  vendors,
  expenseAccounts,
}: {
  initialTemplates: Template[];
  vendors: Vendor[];
  expenseAccounts: Account[];
}) {
  const router = useRouter();
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(t: Template) {
    setRowError(null);
    startTransition(async () => {
      const r = t.is_active
        ? await deactivateRecurringTemplateAction(t.id)
        : await reactivateRecurringTemplateAction(t.id);
      if (r.ok) router.refresh();
      else setRowError(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[color:var(--color-brand-text-soft)]">
          {initialTemplates.length} template
          {initialTemplates.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={() => setEditMode({ kind: "new" })}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New template
        </button>
      </div>

      {rowError && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{rowError}</AlertDescription>
        </Alert>
      )}

      <Dialog
        open={editMode !== null}
        onOpenChange={(open) => { if (!open) setEditMode(null); }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editMode?.kind === "edit" ? "Edit template" : "New template"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editMode?.kind === "edit"
                ? "Edit the recurring bill template."
                : "Create a new recurring bill template."}
            </DialogDescription>
          </DialogHeader>

          {editMode && (
            <TemplateForm
              key={editMode.kind === "edit" ? editMode.template.id : "new"}
              mode={editMode}
              vendors={vendors}
              accounts={expenseAccounts}
              onClose={() => setEditMode(null)}
              onSaved={() => {
                setEditMode(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Due day</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Next run</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialTemplates.map((t) => (
              <tr key={t.id} className={t.is_active ? "" : "opacity-60"}>
                <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                  {t.vendor_name ?? "—"}
                </td>
                <td className="px-3 py-2">{t.description}</td>
                <td className="px-3 py-2 tabular-nums">{t.due_day_of_month}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {t.amount_php == null ? (
                    <em className="text-[color:var(--color-brand-text-soft)]">variable</em>
                  ) : (
                    PHP.format(t.amount_php)
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{t.next_run_date}</td>
                <td className="px-3 py-2 text-xs">
                  <StatusBadge status={t.is_active ? "active" : "inactive"} />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setEditMode({ kind: "edit", template: t })}
                    className="mr-3 text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(t)}
                    className={
                      t.is_active
                        ? "text-red-700 hover:underline"
                        : "text-green-700 hover:underline"
                    }
                  >
                    {t.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {initialTemplates.length === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No templates yet. Add the first one above.
        </p>
      )}
    </div>
  );
}

function TemplateForm({
  mode,
  vendors,
  accounts,
  onClose,
  onSaved,
}: {
  mode: { kind: "new" } | { kind: "edit"; template: Template };
  vendors: Vendor[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = mode.kind === "edit";
  const initial = isEdit ? mode.template : null;

  const [form, setForm] = useState({
    vendor_id: initial?.vendor_id ?? "",
    description: initial?.description ?? "",
    due_day_of_month: initial?.due_day_of_month ?? 5,
    bill_date_offset_days: initial?.bill_date_offset_days ?? 0,
    amount_php: initial?.amount_php == null ? "" : String(initial.amount_php),
    default_account_id: initial?.default_account_id ?? "",
    default_wt_classification: initial?.default_wt_classification ?? "",
    default_wt_rate:
      initial?.default_wt_rate == null ? "" : String(initial.default_wt_rate),
    default_wt_exempt: initial?.default_wt_exempt ?? false,
    next_run_date: initial?.next_run_date ?? new Date().toISOString().slice(0, 10),
  });
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = {
      vendor_id: form.vendor_id,
      description: form.description.trim(),
      cadence: "monthly" as const,
      due_day_of_month: Number(form.due_day_of_month),
      bill_date_offset_days: Number(form.bill_date_offset_days),
      amount_php: form.amount_php === "" ? null : Number(form.amount_php),
      default_account_id: form.default_account_id,
      default_wt_classification: form.default_wt_classification.trim() || null,
      default_wt_rate: form.default_wt_rate === "" ? null : Number(form.default_wt_rate),
      default_wt_exempt: form.default_wt_exempt,
      next_run_date: form.next_run_date,
    };

    startTransition(async () => {
      const r = isEdit
        ? await updateRecurringTemplateAction(mode.template.id, payload)
        : await createRecurringTemplateAction(payload);
      if (r.ok) onSaved();
      else setError(r.error);
    });
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4"
    >
      {error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Vendor *">
          <select
            required
            value={form.vendor_id}
            onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">— pick a vendor —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Description *">
          <input
            required
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Default account *">
          <select
            required
            value={form.default_account_id}
            onChange={(e) =>
              setForm((f) => ({ ...f, default_account_id: e.target.value }))
            }
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">— pick an account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Amount (₱)"
          help="Leave blank for variable amounts (e.g. utility bills)."
        >
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.amount_php}
            onChange={(e) => setForm((f) => ({ ...f, amount_php: e.target.value }))}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field
          label="Due day of month *"
          help="1–31. If shorter month, falls back to last day."
        >
          <input
            type="number"
            min="1"
            max="31"
            required
            value={form.due_day_of_month}
            onChange={(e) =>
              setForm((f) => ({ ...f, due_day_of_month: Number(e.target.value) }))
            }
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field
          label="Bill date offset (days)"
          help="Negative = bill_date posted earlier than the run date."
        >
          <input
            type="number"
            min="-30"
            max="0"
            value={form.bill_date_offset_days}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                bill_date_offset_days: Number(e.target.value),
              }))
            }
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Next run date *">
          <input
            type="date"
            required
            value={form.next_run_date}
            onChange={(e) => setForm((f) => ({ ...f, next_run_date: e.target.value }))}
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Default WT classification">
          <input
            value={form.default_wt_classification}
            onChange={(e) =>
              setForm((f) => ({ ...f, default_wt_classification: e.target.value }))
            }
            placeholder="WI160"
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <Field label="Default WT rate" help="Decimal — 0.0200 = 2%.">
          <input
            type="number"
            step="0.0001"
            min="0"
            max="1"
            value={form.default_wt_rate}
            onChange={(e) =>
              setForm((f) => ({ ...f, default_wt_rate: e.target.value }))
            }
            className="min-h-[44px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.default_wt_exempt}
            onChange={(e) =>
              setForm((f) => ({ ...f, default_wt_exempt: e.target.checked }))
            }
            className="h-4 w-4"
          />
          WT-exempt by default
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {isPending ? "Saving…" : isEdit ? "Save changes" : "Create template"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
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
    </label>
  );
}
