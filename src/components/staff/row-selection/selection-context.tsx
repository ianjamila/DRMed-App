"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LIMITS,
  EMPTY_SELECTION,
  addEntries,
  canAdd as canAddPure,
  keysByKind as keysByKindPure,
  recordsOf,
  removeKeys,
  toggleEntry,
  type SelectionEntry,
  type SelectionLimits,
  type SelectionState,
} from "@/lib/ui/bulk-selection";

export interface RowSelection {
  state: SelectionState;
  isSelected: (rowKey: string) => boolean;
  toggle: (entry: SelectionEntry) => void;
  /** Header select-all: adds (stopping at the caps) or removes the given entries. */
  setMany: (entries: readonly SelectionEntry[], selected: boolean) => void;
  clear: () => void;
  /** Prune after a successful action, or when a row's checkbox unmounts / changes kind. */
  clearKeys: (rowKeys: readonly string[]) => void;
  canAdd: (entry: SelectionEntry) => boolean;
  keysByKind: Record<string, string[]>;
  count: number;
  records: number;
  /** How many rows the last setMany could not add because a cap was reached; 0 after any other change. */
  refusedCount: number;
  limits: SelectionLimits;
}

const SelectionContext = createContext<RowSelection | null>(null);

interface ProviderProps {
  /**
   * A normalised string of every list parameter that changes the row set or
   * its order (view, filters, sort, page, size, search…). It is applied as the
   * React key of the inner provider, so the selection drops whenever the list
   * changes. Search-param navigation does NOT remount client components by
   * itself — this key is the mechanism.
   */
  resetKey: string;
  limits?: SelectionLimits;
  children: ReactNode;
}

export function SelectionProvider({ resetKey, limits, children }: ProviderProps) {
  return (
    <InnerProvider key={resetKey} limits={limits ?? DEFAULT_LIMITS}>
      {children}
    </InnerProvider>
  );
}

function InnerProvider({ limits, children }: { limits: SelectionLimits; children: ReactNode }) {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const [refusedCount, setRefusedCount] = useState(0);

  const toggle = useCallback(
    (entry: SelectionEntry) => {
      setRefusedCount(0);
      setState((prev) => toggleEntry(prev, entry, limits));
    },
    [limits],
  );

  const setMany = useCallback(
    (entries: readonly SelectionEntry[], selected: boolean) => {
      if (!selected) {
        setRefusedCount(0);
        setState((prev) => removeKeys(prev, entries.map((e) => e.rowKey)));
        return;
      }
      setState((prev) => {
        const { next, refused } = addEntries(prev, entries, limits);
        setRefusedCount(refused.length);
        return next;
      });
    },
    [limits],
  );

  const clear = useCallback(() => {
    setRefusedCount(0);
    setState(EMPTY_SELECTION);
  }, []);

  const clearKeys = useCallback((rowKeys: readonly string[]) => {
    if (rowKeys.length === 0) return;
    // removeKeys returns the same reference when nothing was removed, so the
    // unmount-pruning effect (fires for every row on a full revalidation) does
    // not cause a re-render.
    setState((prev) => removeKeys(prev, rowKeys));
  }, []);

  const isSelected = useCallback((rowKey: string) => state.has(rowKey), [state]);
  const canAdd = useCallback(
    (entry: SelectionEntry) => canAddPure(state, entry, limits),
    [state, limits],
  );
  const byKind = useMemo(() => keysByKindPure(state), [state]);

  const value = useMemo<RowSelection>(
    () => ({
      state,
      isSelected,
      toggle,
      setMany,
      clear,
      clearKeys,
      canAdd,
      keysByKind: byKind,
      count: state.size,
      records: recordsOf(state),
      refusedCount,
      limits,
    }),
    [state, isSelected, toggle, setMany, clear, clearKeys, canAdd, byKind, refusedCount, limits],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useRowSelection(): RowSelection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useRowSelection must be used within a SelectionProvider");
  return ctx;
}
