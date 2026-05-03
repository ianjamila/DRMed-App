"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createClosureAction,
  deleteClosureAction,
  type ClosureResult,
} from "./actions";

export interface ClosureRow {
  closed_on: string;
  reason: string;
  created_at: string;
  created_by_name: string | null;
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
              <th className="px-4 py-3">Added by</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {closures.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
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
  const [state, formAction, pending] = useActionState<
    ClosureResult | null,
    FormData
  >(deleteClosureAction, null);

  // sv-SE on a YYYY-MM-DD literal renders without timezone drift.
  const dateLabel = new Date(`${row.closed_on}T00:00:00+08:00`).toLocaleString(
    "en-PH",
    { dateStyle: "full", timeZone: "Asia/Manila" },
  );

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
      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
        {row.created_by_name ?? "system"}
      </td>
      <td className="px-4 py-3 text-right">
        <form action={formAction} className="inline-block">
          <input type="hidden" name="closed_on" value={row.closed_on} />
          <button
            type="submit"
            disabled={pending}
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
            {pending ? "Removing…" : "Remove"}
          </button>
        </form>
        {state && !state.ok ? (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {state.error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
