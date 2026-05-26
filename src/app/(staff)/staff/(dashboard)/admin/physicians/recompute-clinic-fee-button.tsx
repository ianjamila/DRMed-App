"use client";

import { useState, useTransition } from "react";
import { recomputeClinicFeeForUnreleased } from "@/lib/actions/accounting/physicians-compensation";

export function RecomputeClinicFeeButton() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function handleClick() {
    startTransition(async () => {
      const res = await recomputeClinicFeeForUnreleased();
      if (res.ok) {
        setResult(`Done. ${res.data.rows_affected} test${res.data.rows_affected === 1 ? "" : "s"} updated.`);
      } else {
        setResult(`Error: ${res.error}`);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        title="Runs after you classify rent-paying / shareholder doctors. Touches only tests that haven't been released yet."
        className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)] disabled:opacity-50"
      >
        {isPending ? "Running…" : "Recompute clinic-fee on unreleased tests"}
      </button>
      {result ? (
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">{result}</span>
      ) : null}
    </div>
  );
}
