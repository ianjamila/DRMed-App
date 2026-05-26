"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadBankStatement } from "../actions";

interface Account {
  id: string;
  code: string;
  name: string;
}

export function UploadForm({
  accounts,
  today,
}: {
  accounts: Account[];
  today: string;
}) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState(monthStart(today));
  const [periodEnd, setPeriodEnd] = useState(today);
  const [label, setLabel] = useState("");
  const [filename, setFilename] = useState("");
  const [csvText, setCsvText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    file.text().then((t) => setCsvText(t));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await uploadBankStatement({
        account_id: accountId,
        period_start: periodStart,
        period_end: periodEnd,
        statement_label: label.trim(),
        raw_filename: filename || null,
        csv_text: csvText,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/staff/admin/accounting/bank-rec/${r.data.id}`);
    });
  }

  const canSubmit =
    !pending &&
    accountId &&
    periodStart &&
    periodEnd &&
    label.trim().length >= 1 &&
    csvText.trim().length > 0;

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-5 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Cash account
          </span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          >
            {accounts.length === 0 ? (
              <option value="">No cash accounts found</option>
            ) : (
              accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Statement label
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. BPI Sept 2026"
            required
            maxLength={120}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Period start
          </span>
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            max={today}
            required
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Period end
          </span>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            max={today}
            required
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Upload CSV (or paste below)
        </span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onFileChange}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          CSV content
        </span>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={10}
          required
          placeholder={`date,description,reference,amount
2026-05-15,Deposit,DEP-1234,15000.00
2026-05-16,POS purchase,POS-9988,-450.00`}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 font-mono text-xs"
        />
      </label>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 whitespace-pre-wrap">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)] disabled:cursor-not-allowed disabled:bg-[color:var(--color-brand-bg-mid)] disabled:text-[color:var(--color-brand-text-soft)]"
        >
          {pending ? "Uploading + matching…" : "Upload + auto-match"}
        </button>
      </div>
    </form>
  );
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}
