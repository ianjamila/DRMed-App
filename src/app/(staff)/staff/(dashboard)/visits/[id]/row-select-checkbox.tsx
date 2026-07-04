"use client";

import { useEffect } from "react";
import { MAX_BULK_SELECTION } from "@/lib/visits/bulk-selection";
import {
  useRowSelection,
  type SelectionEligibility,
} from "./selection-context";

interface Props {
  testRequestId: string;
  eligibility: SelectionEligibility;
  // Feeds the sr-only/aria-label, e.g. "Select CBC" — lets screen-reader
  // users tell rows apart without relying on table position.
  label: string;
}

// Leading checkbox cell for a release-eligible (ready_for_release) or
// unrelease-eligible (released) test_request row. Disables itself once its
// own eligibility bucket hits MAX_BULK_SELECTION so a receptionist can't
// build a selection the server action would reject outright.
export function RowSelectCheckbox({ testRequestId, eligibility, label }: Props) {
  const { isSelected, toggle, clearIds, releaseCount, unreleaseCount } =
    useRowSelection();

  // Prune this row from the selection when the checkbox unmounts or its
  // eligibility flips (a revalidation moved the row ready↔released or out of
  // eligibility entirely). Keeps the bar's counts honest — a stale id can
  // otherwise linger in the Map with no visible checkbox backing it.
  useEffect(() => {
    return () => clearIds([testRequestId]);
  }, [testRequestId, eligibility, clearIds]);

  const checked = isSelected(testRequestId);
  const countOfKind = eligibility === "release" ? releaseCount : unreleaseCount;
  const atCap = !checked && countOfKind >= MAX_BULK_SELECTION;

  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={atCap}
      onChange={() => toggle(testRequestId, eligibility)}
      aria-label={`Select ${label}`}
      title={
        atCap
          ? `You can select up to ${MAX_BULK_SELECTION} tests at a time`
          : undefined
      }
      className="h-4 w-4 accent-[color:var(--color-brand-cyan)] disabled:opacity-40"
    />
  );
}
