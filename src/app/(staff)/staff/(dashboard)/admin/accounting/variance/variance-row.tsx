"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setBudget } from "./actions";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export function VarianceRow({
  fiscalYear,
  accountId,
  code,
  name,
  accountType,
  annualBudget,
  actualYtd,
  proration,
}: {
  fiscalYear: number;
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  annualBudget: number;
  actualYtd: number;
  proration: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    annualBudget > 0 ? String(annualBudget) : "",
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const ytdBudget = annualBudget * proration;
  const variance = actualYtd - ytdBudget;
  const variancePct =
    ytdBudget > 0 ? (variance / ytdBudget) * 100 : actualYtd === 0 ? 0 : null;

  // Positive variance is GOOD for revenue, BAD for expense/contra_revenue.
  const isFavorable =
    accountType === "revenue" ? variance >= 0 : variance <= 0;

  const varianceColor =
    Math.abs(variance) < 1
      ? "text-[color:var(--color-brand-text-soft)]"
      : isFavorable
        ? "text-emerald-700"
        : "text-red-700";

  function save() {
    setError(null);
    const amt = Number(draft);
    if (!Number.isFinite(amt) || amt < 0) {
      setError("Amount must be a non-negative number.");
      return;
    }
    startTransition(async () => {
      const r = await setBudget({
        fiscal_year: fiscalYear,
        account_id: accountId,
        annual_amount_php: amt,
        notes: null,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setDraft(annualBudget > 0 ? String(annualBudget) : "");
    setEditing(false);
    setError(null);
  }

  return (
    <tr className="hover:bg-[color:var(--color-brand-bg)]/40">
      <td className="px-4 py-2">
        <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
          {code}
        </span>{" "}
        <span className="text-[color:var(--color-brand-text)]">{name}</span>
      </td>
      <td className="px-4 py-2 text-right font-mono">
        {editing ? (
          <div className="flex items-center justify-end gap-1">
            <input
              type="number"
              min="0"
              step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="w-28 rounded-md border border-[color:var(--color-brand-cyan)] px-2 py-1 text-right text-xs"
            />
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-md bg-[color:var(--color-brand-cyan)] px-2 py-1 text-xs text-white"
            >
              {pending ? "…" : "✓"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={pending}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-xs"
            >
              ✕
            </button>
          </div>
        ) : annualBudget > 0 ? (
          PHP.format(annualBudget)
        ) : (
          <span className="text-[color:var(--color-brand-text-soft)]">—</span>
        )}
        {error ? (
          <p className="text-[10px] text-red-700">{error}</p>
        ) : null}
      </td>
      <td className="px-4 py-2 text-right font-mono text-[color:var(--color-brand-text-soft)]">
        {annualBudget > 0 ? PHP.format(ytdBudget) : "—"}
      </td>
      <td className="px-4 py-2 text-right font-mono">
        {PHP.format(actualYtd)}
      </td>
      <td className={`px-4 py-2 text-right font-mono ${varianceColor}`}>
        {annualBudget > 0
          ? `${variance >= 0 ? "+" : ""}${PHP.format(variance)}`
          : "—"}
      </td>
      <td className={`px-4 py-2 text-right font-mono ${varianceColor}`}>
        {variancePct === null
          ? "—"
          : `${variancePct >= 0 ? "+" : ""}${variancePct.toFixed(1)}%`}
      </td>
      <td className="px-4 py-2 text-right">
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-[color:var(--color-brand-cyan)] hover:underline"
          >
            {annualBudget > 0 ? "Edit" : "Set budget"}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
