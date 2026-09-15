"use client";

import { useActionState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StableInput } from "@/components/forms/stable-fields";
import {
  bulkRescheduleForClosureAction,
  createClosureAction,
  deleteClosureAction,
  type BulkRescheduleResult,
  type ClosureResult,
} from "./actions";
import { Panel } from "@/components/ui/panel";
import { friendlyManilaDate } from "@/lib/dates/manila";
import {
  ariaSortFor,
  buildListHref,
  nextSort,
  parseSort,
  type SortDir,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";

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

const BASE_PATH = "/staff/admin/closures";

// Sortable columns for the upcoming-closures table. `created_at` isn't
// here — it isn't rendered as its own column, so there's nothing for a
// header click to point at.
const SORTABLE_COLUMNS = ["closed_on", "reason", "affected_count", "created_by_name"] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "closed_on", dir: "asc" };

function valueFor(row: ClosureRow, key: SortColumn): string | number | null {
  switch (key) {
    case "closed_on":
      return row.closed_on;
    case "reason":
      return row.reason;
    case "affected_count":
      return row.affected_count;
    case "created_by_name":
      return row.created_by_name;
  }
}

// `created_by_name` is the only nullable column here (closures seeded
// without a staff creator, e.g. imported public holidays, have none) —
// sink a null to the bottom regardless of direction rather than flipping
// it to the top on desc.
function compareValues(a: string | number | null, b: string | number | null, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") {
    const cmp = a - b;
    return dir === "asc" ? cmp : -cmp;
  }
  // `closed_on` is already the ISO date string, so comparing it as a
  // string sorts by its underlying date value, not a formatted display
  // string — there's no separate "display order" to drift from "real order".
  const cmp = String(a).localeCompare(String(b), "en", { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
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
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Add closure
      </h2>
      <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="closed_on">Date</Label>
          <StableInput id="closed_on" name="closed_on" type="date" required />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="reason">Reason</Label>
          <StableInput
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
  const searchParams = useSearchParams();
  const sort = parseSort(
    searchParams.get("sort") ?? undefined,
    searchParams.get("dir") ?? undefined,
    SORTABLE_COLUMNS,
    DEFAULT_SORT,
  );

  // Sort before anything else. `closed_on` is the natural key here — the
  // table shows one row per date — so it doubles as the tie-break that
  // gives every other column a total order.
  const sorted = useMemo(() => {
    return [...closures].sort((a, b) => {
      const cmp = compareValues(valueFor(a, sort.key), valueFor(b, sort.key), sort.dir);
      if (cmp !== 0) return cmp;
      return a.closed_on.localeCompare(b.closed_on);
    });
  }, [closures, sort]);

  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
  };
  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
    });
  };
  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  // No pager here, deliberately: this table is scoped to the next 60 days
  // (see the copy below) and grows by a handful of rows a year — public
  // holidays plus the occasional ad-hoc closure. A pager would sit there
  // permanently inert with everything fitting on one page; sorting still
  // earns its place (e.g. pulling the most-affected closure to the top).
  return (
    <section>
      <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Upcoming closures ({closures.length})
      </h2>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Past closures are hidden. The public slot picker only ever reads the
        next 60 days.
      </p>
      <Panel className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("closed_on", "Date")}
              {th("reason", "Reason")}
              {th("affected_count", "Affected")}
              {th("created_by_name", "Added by")}
              <PlainTh label="Action" align="right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No upcoming closures.
                </td>
              </tr>
            ) : (
              sorted.map((c) => <ClosureRow key={c.closed_on} row={c} />)
            )}
          </tbody>
        </table>
      </Panel>
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

  const dateLabel = friendlyManilaDate(row.closed_on);

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
