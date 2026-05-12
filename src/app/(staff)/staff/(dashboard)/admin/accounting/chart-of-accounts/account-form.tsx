"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CoaResult } from "./actions";

interface AccountDefaults {
  id?: string;
  code: string;
  name: string;
  type: string;
  parent_id: string | null;
  description: string | null;
  is_active: boolean;
}

interface ParentOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

const TYPE_OPTIONS: { value: string; label: string; normal: "debit" | "credit" }[] = [
  { value: "asset", label: "Asset", normal: "debit" },
  { value: "liability", label: "Liability", normal: "credit" },
  { value: "equity", label: "Equity", normal: "credit" },
  { value: "revenue", label: "Revenue", normal: "credit" },
  { value: "contra_revenue", label: "Contra-revenue", normal: "debit" },
  { value: "expense", label: "Expense", normal: "debit" },
  { value: "contra_expense", label: "Contra-expense", normal: "credit" },
  { value: "memo", label: "Memo / Suspense", normal: "debit" },
];

export function AccountForm({
  mode,
  defaults,
  parents,
  action,
}: {
  mode: "create" | "edit";
  defaults: AccountDefaults;
  parents: ParentOption[];
  action: (prev: CoaResult | null, formData: FormData) => Promise<CoaResult>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();

  // Controlled state for type so we can re-filter parent options + show derived normal balance.
  return (
    <form action={formAction} className="space-y-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      {state && !state.ok ? (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </div>
      ) : null}

      <Field label="Code" hint={mode === "edit" ? "Read-only — codes are stable identifiers." : "e.g. 4100"}>
        <input
          type="text"
          name="code"
          required
          defaultValue={defaults.code}
          readOnly={mode === "edit"}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 font-mono text-sm read-only:bg-[color:var(--color-brand-bg)]"
        />
      </Field>

      <Field label="Name">
        <input
          type="text"
          name="name"
          required
          defaultValue={defaults.name}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Type">
        <select
          name="type"
          required
          defaultValue={defaults.type}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label} (normal: {t.normal})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Parent account (optional)" hint="Must be the same type. Used for roll-up hierarchy.">
        <select
          name="parent_id"
          defaultValue={defaults.parent_id ?? ""}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        >
          <option value="">— None —</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id} data-type={p.type}>
              {p.code} · {p.name} ({p.type})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Description (optional)">
        <textarea
          name="description"
          rows={3}
          defaultValue={defaults.description ?? ""}
          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
      </Field>

      {mode === "edit" ? (
        <Field label="Active">
          <label className="inline-flex min-h-[44px] items-center gap-2">
            <input type="checkbox" name="is_active" defaultChecked={defaults.is_active} value="true" />
            <span className="text-sm">Account is active and accepts new postings</span>
          </label>
        </Field>
      ) : null}

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 text-sm font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        >
          {pending ? "Saving…" : mode === "create" ? "Create account" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 text-sm font-semibold"
        >
          Cancel
        </button>
        <Link
          href="/staff/admin/accounting/chart-of-accounts"
          className="ml-auto min-h-[44px] inline-flex items-center text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        >
          ← Back to list
        </Link>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-[color:var(--color-brand-text-soft)]">{hint}</span>
      ) : null}
    </label>
  );
}
