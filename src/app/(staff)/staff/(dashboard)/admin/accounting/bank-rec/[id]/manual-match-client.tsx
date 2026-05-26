"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { manualMatch } from "../actions";

interface Candidate {
  id: string;
  entryNumber: string;
  postingDate: string;
  description: string;
  signed: number; // signed amount = debit - credit
}

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export function ManualMatchClient({
  bankLineId,
  transactionDate,
  description,
  reference,
  amount,
  candidates,
}: {
  bankLineId: string;
  transactionDate: string;
  description: string | null;
  reference: string | null;
  amount: number;
  candidates: Candidate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  function onMatch() {
    if (!selectedId) return;
    setError(null);
    startTransition(async () => {
      const r = await manualMatch({
        bank_line_id: bankLineId,
        je_line_id: selectedId,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  const exactMatches = candidates.filter((c) => c.signed === amount);

  return (
    <article className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {transactionDate}
          </p>
          <p className="mt-1 font-medium text-[color:var(--color-brand-navy)]">
            {description ?? "(no description)"}
          </p>
          {reference ? (
            <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
              ref: {reference}
            </p>
          ) : null}
        </div>
        <p className="shrink-0 font-mono text-lg font-semibold">
          {amount >= 0 ? (
            <span className="text-emerald-700">{PHP.format(amount)}</span>
          ) : (
            <span className="text-red-700">{PHP.format(amount)}</span>
          )}
        </p>
      </div>

      {candidates.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-amber-300 bg-white p-3 text-sm text-[color:var(--color-brand-text-soft)]">
          No candidate JE lines on this account within ±7 days. Likely missing
          a journal entry —{" "}
          <Link
            href="/staff/admin/accounting/journal/new"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            create one
          </Link>{" "}
          then re-run auto-match.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {exactMatches.length === 0
              ? "No exact-amount candidates — review by date / description."
              : exactMatches.length === 1
                ? "1 exact-amount candidate."
                : `${exactMatches.length} candidates tied on amount — pick by date.`}
          </p>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          >
            <option value="">— pick a journal line —</option>
            {candidates.map((c) => {
              const match = c.signed === amount ? " ✓" : "";
              return (
                <option key={c.id} value={c.id}>
                  {c.entryNumber} · {c.postingDate} · {PHP.format(c.signed)}
                  {match} · {c.description.slice(0, 60)}
                </option>
              );
            })}
          </select>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onMatch}
              disabled={!selectedId || pending}
              className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)] disabled:cursor-not-allowed disabled:bg-[color:var(--color-brand-bg-mid)] disabled:text-[color:var(--color-brand-text-soft)]"
            >
              {pending ? "Matching…" : "Match"}
            </button>
            <Link
              href="/staff/admin/accounting/journal/new"
              className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
            >
              + Post a JE for this
            </Link>
          </div>
          {error ? (
            <p className="text-xs text-red-700">{error}</p>
          ) : null}
        </div>
      )}
    </article>
  );
}
