"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  bulkRescheduleForClosureAction,
  createClosureAction,
  deleteClosureAction,
  type BulkRescheduleResult,
  type ClosureResult,
} from "./actions";

export interface ClosureRow {
  closed_on: string;
  reason: string;
  created_at: string;
  created_by_name: string | null;
  affected_count: number;
}

interface Props {
  initialClosures: ClosureRow[];
}

export function ClosuresClient({ initialClosures }: Props) {
  return (
    <div className="grid gap-8">
      <NewClosureForm />
      <ClosuresTable closures={initialClosures} />
    </div>
  );
}

function NewClosureForm() {
  const [state, formAction, pending] = useActionState<
    ClosureResult | null,
    FormData
  >(createClosureAction, null);

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Add closure
      </h2>
      <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="closed_on">Date</Label>
          <Input id="closed_on" name="closed_on" type="date" required />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="reason">Reason</Label>
          <Input
            id="reason"
            name="reason"
            type="text"
            placeholder="e.g. Independence Day"
            maxLength={200}
            required
          />
        </div>
        <div className="sm:col-span-3 flex items-center justify-between gap-3">
          {state && !state.ok ? (
            <p className="text-sm text-red-600" role="alert">
              {state.error}
            </p>
          ) : state?.ok ? (
            <p className="text-sm text-emerald-700" role="status">
              Closure added.
            </p>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            disabled={pending}
            className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            {pending ? "Saving…" : "Add closure"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ClosuresTable({ closures }: { closures: ClosureRow[] }) {
  return (
    <section>
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Upcoming closures ({closures.length})
      </h2>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Past closures are hidden. The public slot picker only ever reads the
        next 60 days.
      </p>
      <div className="mt-3 overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Affected</th>
              <th className="px-4 py-3">Added by</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {closures.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No upcoming closures.
                </td>
              </tr>
            ) : (
              closures.map((c) => <ClosureRow key={c.closed_on} row={c} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClosureRow({ row }: { row: ClosureRow }) {
  const [deleteState, deleteAction, deletePending] = useActionState<
    ClosureResult | null,
    FormData
  >(deleteClosureAction, null);
  const [bulkState, bulkAction, bulkPending] = useActionState<
    BulkRescheduleResult | null,
    FormData
  >(bulkRescheduleForClosureAction, null);

  // sv-SE on a YYYY-MM-DD literal renders without timezone drift.
  const dateLabel = new Date(`${row.closed_on}T00:00:00+08:00`).toLocaleString(
    "en-PH",
    { dateStyle: "full", timeZone: "Asia/Manila" },
  );

  // After a successful bulk reschedule, the page revalidates and
  // affected_count drops to 0 — but until that round-trip completes
  // we want to suppress the button. Track via the action state.
  const justRescheduled = bulkState?.ok === true;
  const showBulkButton = row.affected_count > 0 && !justRescheduled;

  return (
    <tr className="hover:bg-[color:var(--color-brand-bg)]">
      <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
        {row.closed_on}
        <span className="ml-2 text-[10px] text-[color:var(--color-brand-text-soft)]">
          {dateLabel}
        </span>
      </td>
      <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
        {row.reason}
      </td>
      <td className="px-4 py-3">
        {row.affected_count === 0 && !justRescheduled ? (
          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
            None
          </span>
        ) : showBulkButton ? (
          <form action={bulkAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="closed_on" value={row.closed_on} />
            <span className="text-xs font-semibold text-amber-800">
              {row.affected_count} confirmed
            </span>
            <button
              type="submit"
              disabled={bulkPending}
              onClick={(e) => {
                if (
                  !window.confirm(
                    `Move ${row.affected_count} confirmed appointment(s) on ${row.closed_on} to pending callback? Reception will need to phone each patient to propose a new slot.`,
                  )
                ) {
                  e.preventDefault();
                }
              }}
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              {bulkPending ? "Moving…" : "Move to callback"}
            </button>
          </form>
        ) : (
          <span className="text-xs text-emerald-700">
            Moved · reception to call
          </span>
        )}
        {bulkState && !bulkState.ok ? (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {bulkState.error}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
        {row.created_by_name ?? "system"}
      </td>
      <td className="px-4 py-3 text-right">
        <form action={deleteAction} className="inline-block">
          <input type="hidden" name="closed_on" value={row.closed_on} />
          <button
            type="submit"
            disabled={deletePending}
            onClick={(e) => {
              if (
                !window.confirm(
                  `Remove closure on ${row.closed_on}? Patients will be able to book that day again.`,
                )
              ) {
                e.preventDefault();
              }
            }}
            className="text-xs font-bold text-red-600 hover:underline disabled:text-[color:var(--color-brand-text-soft)]"
          >
            {deletePending ? "Removing…" : "Remove"}
          </button>
        </form>
        {deleteState && !deleteState.ok ? (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {deleteState.error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
