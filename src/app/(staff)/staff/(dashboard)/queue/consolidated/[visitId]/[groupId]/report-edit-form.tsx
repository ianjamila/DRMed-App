"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { amendConsolidated } from "./actions";
import {
  ConsolidatedValuesTable,
  useConsolidatedValues,
  type ConsolidatedParam,
  type ValueCells,
} from "./consolidated-values-table";

/**
 * Edit a finished combined report in place. Pre-filled with the report's
 * current values; a reason is required. The page renders this only when the
 * signed-in user may read the report's values (staff_can_read_finished_result),
 * and the Server Action re-checks everything, including that nobody else saved
 * an edit since the page was opened (the hidden version below).
 */
export function ReportEditForm({
  resultId,
  expectedAmendmentCount,
  params,
  editableParamIds,
  initial,
  doneHref,
}: {
  resultId: string;
  expectedAmendmentCount: number;
  params: ConsolidatedParam[];
  editableParamIds: string[];
  initial: ValueCells;
  /** Where Save / Cancel go (the page without ?edit). */
  doneHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const enabled = new Set(editableParamIds);
  const { values, updateSi, updateConv, payload } = useConsolidatedValues(initial);

  function save() {
    setError(null);
    if (reason.trim().length < 5) {
      setError({ message: "Please describe the reason for the edit (5+ characters).", stale: false });
      return;
    }
    startTransition(async () => {
      const res = await amendConsolidated({
        resultId,
        expectedAmendmentCount,
        reason: reason.trim(),
        values: payload(params, enabled),
      });
      if (!res.ok) {
        setError({ message: res.error, stale: Boolean(res.stale) });
        return;
      }
      router.replace(doneHref);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mt-4 space-y-4 rounded-lg border border-amber-300 bg-amber-50/60 p-4"
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-amber-900">Edit results</p>
        <p className="mt-1 text-xs text-amber-900">
          Change the values below and give a reason. Saving makes a new PDF that replaces the
          current one — the patient sees only the new version. The replaced PDF and its values
          are kept in the edit history. A patient who already downloaded the old PDF is not told
          automatically.
        </p>
      </div>

      <ConsolidatedValuesTable
        params={params}
        enabled={enabled}
        values={values}
        onSi={updateSi}
        onConv={updateConv}
        disabled={pending}
      />

      <div className="grid gap-1.5">
        <label htmlFor={`edit-reason-${resultId}`} className="text-sm font-semibold text-amber-900">
          Reason for the edit <span className="text-red-600">*</span>
        </label>
        <textarea
          id={`edit-reason-${resultId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          rows={3}
          disabled={pending}
          className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm"
          placeholder="e.g. Glucose re-run after a sample mix-up"
        />
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
          {error.message}{" "}
          {error.stale ? (
            <button
              type="button"
              // A full reload: the form's own state was seeded from the old
              // values, so a soft refresh would keep showing them.
              onClick={() => window.location.reload()}
              className="font-semibold underline"
            >
              Reload
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending || reason.trim().length < 5}
          className="min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save edit"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => router.replace(doneHref)}
          className="min-h-[44px] rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
