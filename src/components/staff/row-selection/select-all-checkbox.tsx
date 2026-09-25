"use client";

import { useEffect, useRef } from "react";
import { selectAllState, type SelectionEntry } from "@/lib/ui/bulk-selection";
import { useRowSelection } from "./selection-context";

interface Props {
  /** The selectable rows THIS table renders on this page — serialisable, built by the server page. */
  entries: readonly SelectionEntry[];
  label: string;
}

// Header checkbox over one table. Checked when every entry is selected,
// indeterminate when some are; clicking at "all" removes them, otherwise adds
// the rest (setMany stops at the caps and the bar says so).
export function SelectAllCheckbox({ entries, label }: Props) {
  const { state, setMany } = useRowSelection();
  const status = selectAllState(entries, state);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = status === "some";
  }, [status]);

  return (
    <label className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        checked={status === "all"}
        disabled={entries.length === 0}
        onChange={() => setMany(entries, status !== "all")}
        aria-label={label}
        className="h-4 w-4 accent-[color:var(--color-brand-cyan)] disabled:opacity-40"
      />
    </label>
  );
}
