"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createJournalEntryAction } from "./actions";

interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface LineDraft {
  account_id: string;
  debit_php: string; // string in form, parsed before submit
  credit_php: string;
  description: string;
}

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

function blankLine(): LineDraft {
  return { account_id: "", debit_php: "", credit_php: "", description: "" };
}

export interface InitialLine {
  account_id: string;
  debit_php: number;
  credit_php: number;
  description: string;
}

export function ManualJeForm({
  accounts,
  defaultDate,
  today,
  initialDescription,
  initialLines,
}: {
  accounts: AccountOption[];
  defaultDate: string;
  today: string;
  initialDescription?: string;
  initialLines?: InitialLine[];
}) {
  const router = useRouter();
  const [postingDate, setPostingDate] = useState(defaultDate);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(
    initialLines && initialLines.length >= 2
      ? initialLines.map((l) => ({
          account_id: l.account_id,
          debit_php: l.debit_php > 0 ? String(l.debit_php) : "",
          credit_php: l.credit_php > 0 ? String(l.credit_php) : "",
          description: l.description,
        }))
      : [blankLine(), blankLine()],
  );
  const [submitMode, setSubmitMode] = useState<"draft" | "posted">("posted");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Group accounts by type for picker readability.
  const accountsByType = useMemo(() => {
    const groups: Record<string, AccountOption[]> = {};
    for (const a of accounts) {
      (groups[a.type] = groups[a.type] ?? []).push(a);
    }
    for (const t of Object.keys(groups)) {
      groups[t].sort((a, b) => a.code.localeCompare(b.code));
    }
    return groups;
  }, [accounts]);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      debit += Number(l.debit_php) || 0;
      credit += Number(l.credit_php) || 0;
    }
    return { debit, credit, balanced: Math.abs(debit - credit) < 0.005 };
  }, [lines]);

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  }

  function addLine() {
    setLines((prev) => [...prev, blankLine()]);
  }

  function removeLine(i: number) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = {
      posting_date: postingDate,
      description,
      notes: notes.trim() ? notes : null,
      status: submitMode,
      lines: lines.map((l) => ({
        account_id: l.account_id,
        debit_php: Number(l.debit_php) || 0,
        credit_php: Number(l.credit_php) || 0,
        description: l.description.trim() ? l.description : null,
      })),
    };

    startTransition(async () => {
      const result = await createJournalEntryAction(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/staff/admin/accounting/journal/${result.id}`);
    });
  }

  const canSubmit =
    !pending &&
    postingDate.length === 10 &&
    description.trim().length >= 3 &&
    lines.length >= 2 &&
    lines.every(
      (l) =>
        l.account_id &&
        ((Number(l.debit_php) > 0 && !(Number(l.credit_php) > 0)) ||
          (Number(l.credit_php) > 0 && !(Number(l.debit_php) > 0))),
    ) &&
    totals.balanced &&
    totals.debit > 0;

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Posting date
          </span>
          <input
            type="date"
            value={postingDate}
            onChange={(e) => setPostingDate(e.target.value)}
            max={today}
            required
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
          <span className="text-xs font-normal normal-case text-[color:var(--color-brand-text-soft)]">
            The date this entry lands in the books.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Description
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Quarter-end depreciation accrual"
            required
            minLength={3}
            maxLength={500}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
          />
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
          placeholder="Anything an auditor would need to know."
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm"
        />
      </label>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Lines
          </h2>
          <button
            type="button"
            onClick={addLine}
            className="text-sm font-medium text-[color:var(--color-brand-cyan)] hover:underline"
          >
            + Add line
          </button>
        </div>

        <p className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Each line puts an amount in either the <strong>Debit</strong> or the{" "}
          <strong>Credit</strong> column. An entry must balance — the Debit and
          Credit totals have to match — before it can be posted.
        </p>

        <div className="overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2 w-32 text-right">Debit (₱)</th>
                <th className="px-3 py-2 w-32 text-right">Credit (₱)</th>
                <th className="px-3 py-2">Memo</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-t border-[color:var(--color-brand-bg-mid)]">
                  <td className="px-3 py-2">
                    <select
                      value={line.account_id}
                      onChange={(e) =>
                        updateLine(i, { account_id: e.target.value })
                      }
                      required
                      className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
                    >
                      <option value="">— pick account —</option>
                      {Object.keys(accountsByType)
                        .sort()
                        .map((type) => (
                          <optgroup key={type} label={typeLabel(type)}>
                            {accountsByType[type].map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} — {a.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.debit_php}
                      onChange={(e) =>
                        updateLine(i, { debit_php: e.target.value })
                      }
                      disabled={Number(line.credit_php) > 0}
                      className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-right font-mono text-sm disabled:bg-[color:var(--color-brand-bg)] disabled:text-[color:var(--color-brand-text-soft)]"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.credit_php}
                      onChange={(e) =>
                        updateLine(i, { credit_php: e.target.value })
                      }
                      disabled={Number(line.debit_php) > 0}
                      className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-right font-mono text-sm disabled:bg-[color:var(--color-brand-bg)] disabled:text-[color:var(--color-brand-text-soft)]"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) =>
                        updateLine(i, { description: e.target.value })
                      }
                      maxLength={500}
                      placeholder="Per-line memo (optional)"
                      className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    {lines.length > 2 ? (
                      <button
                        type="button"
                        onClick={() => removeLine(i)}
                        aria-label={`Remove line ${i + 1}`}
                        className="text-[color:var(--color-brand-text-soft)] hover:text-red-700"
                      >
                        ✕
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-[color:var(--color-brand-bg)] font-semibold">
              <tr>
                <td className="px-3 py-2 text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Totals
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {PHP.format(totals.debit)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {PHP.format(totals.credit)}
                </td>
                <td colSpan={2} className="px-3 py-2 text-xs">
                  {totals.balanced && totals.debit > 0 ? (
                    <span className="text-emerald-700">Balanced ✓</span>
                  ) : totals.debit === 0 ? (
                    <span className="text-[color:var(--color-brand-text-soft)]">
                      Enter at least one amount
                    </span>
                  ) : (
                    <span className="text-red-700">
                      Off by {PHP.format(Math.abs(totals.debit - totals.credit))}
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Submit as
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="submit_mode"
            value="posted"
            checked={submitMode === "posted"}
            onChange={() => setSubmitMode("posted")}
          />
          Post immediately
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="submit_mode"
            value="draft"
            checked={submitMode === "draft"}
            onChange={() => setSubmitMode("draft")}
          />
          Save as draft
        </label>
        <p className="basis-full text-xs font-normal normal-case text-[color:var(--color-brand-text-soft)]">
          <strong>Post immediately</strong> books it now and it shows in
          reports. <strong>Save as draft</strong> holds it — nothing hits the
          books until you post it later.
        </p>
      </fieldset>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Postings into closed accounting periods are rejected by the
          server.
        </p>
        <button
          type="submit"
          disabled={!canSubmit}
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)] disabled:cursor-not-allowed disabled:bg-[color:var(--color-brand-bg-mid)] disabled:text-[color:var(--color-brand-text-soft)]"
        >
          {pending
            ? "Saving…"
            : submitMode === "posted"
              ? "Post journal entry"
              : "Save as draft"}
        </button>
      </div>
    </form>
  );
}

function typeLabel(t: string): string {
  switch (t) {
    case "asset":
      return "Assets (1xxx)";
    case "liability":
      return "Liabilities (2xxx)";
    case "equity":
      return "Equity (3xxx)";
    case "revenue":
      return "Revenue (4xxx)";
    case "contra_revenue":
      return "Contra revenue (49xx)";
    case "expense":
      return "Expenses (5xxx-7xxx)";
    case "memo":
      return "Memo / suspense";
    default:
      return t;
  }
}
