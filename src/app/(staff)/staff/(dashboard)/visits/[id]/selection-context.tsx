"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MAX_BULK_SELECTION } from "@/lib/visits/bulk-selection";

// A row is either release-eligible (currently ready_for_release) or
// unrelease-eligible (currently released). The two kinds are tracked in one
// map — keyed by test_request_id — so a single provider/toolbar can drive
// both the "Release selected" and "Unrelease selected" actions at once.
export type SelectionEligibility = "release" | "unrelease";

interface SelectionContextValue {
  isSelected: (testRequestId: string) => boolean;
  toggle: (testRequestId: string, eligibility: SelectionEligibility) => void;
  clear: () => void;
  // Removes only the given ids, leaving the rest of the selection intact —
  // used after a bulk action succeeds so acting on one bucket never unchecks
  // the other bucket (or rows ticked mid-flight), and by checkboxes pruning
  // themselves when their row's status/eligibility changes after revalidation.
  clearIds: (testRequestIds: string[]) => void;
  releaseIds: string[];
  unreleaseIds: string[];
  releaseCount: number;
  unreleaseCount: number;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

// Wraps the server-rendered Tests section (packages + standalone tables) so
// row checkboxes anywhere inside can share one selection and the bottom
// action bar can read it. Standard RSC composition: this client provider
// takes server-rendered children via `props.children` — it never needs to
// know about the rows themselves.
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<
    Map<string, SelectionEligibility>
  >(new Map());

  const toggle = useCallback(
    (testRequestId: string, eligibility: SelectionEligibility) => {
      setSelection((prev) => {
        const next = new Map(prev);
        if (next.has(testRequestId)) {
          next.delete(testRequestId);
          return next;
        }
        // Defense in depth: RowSelectCheckbox disables itself past the cap,
        // but guard here too in case a stale render slips a toggle through.
        const countOfKind = [...next.values()].filter(
          (kind) => kind === eligibility,
        ).length;
        if (countOfKind >= MAX_BULK_SELECTION) return prev;
        next.set(testRequestId, eligibility);
        return next;
      });
    },
    [],
  );

  const clear = useCallback(() => setSelection(new Map()), []);

  const clearIds = useCallback((testRequestIds: string[]) => {
    if (testRequestIds.length === 0) return;
    setSelection((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of testRequestIds) {
        if (next.delete(id)) changed = true;
      }
      // Return the same reference when nothing was removed so React can
      // bail out of the re-render (matters for the unmount-pruning effect,
      // which fires for every eligible row on any full-page revalidation).
      return changed ? next : prev;
    });
  }, []);

  const isSelected = useCallback(
    (testRequestId: string) => selection.has(testRequestId),
    [selection],
  );

  const { releaseIds, unreleaseIds } = useMemo(() => {
    const release: string[] = [];
    const unrelease: string[] = [];
    for (const [id, kind] of selection) {
      if (kind === "release") release.push(id);
      else unrelease.push(id);
    }
    return { releaseIds: release, unreleaseIds: unrelease };
  }, [selection]);

  const value = useMemo<SelectionContextValue>(
    () => ({
      isSelected,
      toggle,
      clear,
      clearIds,
      releaseIds,
      unreleaseIds,
      releaseCount: releaseIds.length,
      unreleaseCount: unreleaseIds.length,
    }),
    [isSelected, toggle, clear, clearIds, releaseIds, unreleaseIds],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useRowSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error("useRowSelection must be used within a SelectionProvider");
  }
  return ctx;
}
