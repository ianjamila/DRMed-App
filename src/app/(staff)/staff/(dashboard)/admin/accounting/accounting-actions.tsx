"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  rewindAndSyncAction,
  runSyncAction,
  type AccountingActionResult,
} from "./actions";

const SCOPE_OPTIONS = [
  { value: "all", label: "All three tabs" },
  { value: "lab_services", label: "Lab Services only" },
  { value: "doctor_consultations", label: "Doctor Consultations only" },
  { value: "doctor_procedures", label: "Doctor Procedures HMO only" },
] as const;

export function AccountingActions() {
  return (
    <div className="grid gap-6">
      <RunNowSection />
      <RewindSection />
    </div>
  );
}

function RunNowSection() {
  const [state, formAction, pending] = useActionState<
    AccountingActionResult | null,
    FormData
  >(runSyncAction, null);

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Run sync now
      </h2>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Picks up rows since the current watermark and appends them to the
        configured Sheets tabs. Same code path the cron uses.
      </p>
      <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="run-scope">Scope</Label>
          <select
            id="run-scope"
            name="scope"
            defaultValue="all"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          >
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Syncing…" : "Run sync"}
        </Button>
      </form>
      <ActionResult state={state} />
    </section>
  );
}

function RewindSection() {
  const [state, formAction, pending] = useActionState<
    AccountingActionResult | null,
    FormData
  >(rewindAndSyncAction, null);

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Rewind & re-sync from a date
      </h2>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Sets the chosen tab&apos;s watermark back to the given Manila-local date,
        then re-runs the sync. Use sparingly — this <strong>will</strong>{" "}
        re-append rows that were already exported, since Sheets has no upsert.
      </p>
      <form
        action={formAction}
        className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="rewind-scope">Scope</Label>
          <select
            id="rewind-scope"
            name="scope"
            defaultValue="all"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          >
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="rewind-from">From (Manila local time)</Label>
          <Input id="rewind-from" name="from" type="datetime-local" required />
        </div>
        <Button
          type="submit"
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Re-syncing…" : "Rewind & sync"}
        </Button>
      </form>
      <ActionResult state={state} />
    </section>
  );
}

function ActionResult({ state }: { state: AccountingActionResult | null }) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <p className="mt-3 text-sm text-red-600" role="alert">
        {state.error}
      </p>
    );
  }
  const { result } = state;
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">
      <p className="font-bold">
        Sync finished — {result.totalRowsAppended} row
        {result.totalRowsAppended === 1 ? "" : "s"} appended.
      </p>
      <ul className="mt-1 grid gap-0.5">
        {result.tabs.map((t) => (
          <li key={t.key}>
            <span className="font-semibold">{t.label}:</span>{" "}
            {t.skippedReason
              ? `skipped (${t.skippedReason})`
              : `${t.rowsAppended} row${t.rowsAppended === 1 ? "" : "s"}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
