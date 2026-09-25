"use client";

import { useEffect, useMemo } from "react";
import { useRowSelection } from "./selection-context";

interface Props {
  rowKey: string;
  kinds: readonly string[];
  /** Underlying records this row expands to (a booking's services). Default 1. */
  weight?: number;
  /** Feeds the aria-label, e.g. "Select Maria Santos, 3 services". */
  label: string;
}

// Leading checkbox cell for a selectable row. Disables itself when adding the
// row would pass either cap. Prunes its key when it unmounts OR when its
// kinds/weight change after a refresh — the same eligibility rule as the visit
// page's checkbox — so a row that changed under the operator is never acted
// on under its old kinds.
export function RowSelectCheckbox({ rowKey, kinds, weight = 1, label }: Props) {
  const { isSelected, toggle, clearKeys, canAdd, limits } = useRowSelection();
  const kindsKey = kinds.join("|");
  const entry = useMemo(
    () => ({ rowKey, kinds: kindsKey.split("|").filter(Boolean), weight }),
    [rowKey, kindsKey, weight],
  );

  useEffect(() => {
    return () => clearKeys([rowKey]);
  }, [rowKey, kindsKey, weight, clearKeys]);

  const checked = isSelected(rowKey);
  const blocked = !checked && !canAdd(entry);

  return (
    <label className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={blocked}
        onChange={() => toggle(entry)}
        aria-label={`Select ${label}`}
        title={blocked ? `You can select up to ${limits.rows} rows at a time` : undefined}
        className="h-4 w-4 accent-[color:var(--color-brand-cyan)] disabled:opacity-40"
      />
    </label>
  );
}
