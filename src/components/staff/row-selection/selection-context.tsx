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

interface SelectionAndRefused {
  selection: SelectionState;
  /** How many rows the last setMany could not add because a cap was reached; 0 after any other change. */
  refused: number;
}

const EMPTY: SelectionAndRefused = { selection: EMPTY_SELECTION, refused: 0 };

function InnerProvider({ limits, children }: { limits: SelectionLimits; children: ReactNode }) {
  // Selection and refusedCount live in ONE state object so every updater can
  // return both from a single, pure function — React (StrictMode especially)
  // requires a setState updater to have no side effects, and calling a second
  // setState from inside one is exactly that.
  const [sel, setSel] = useState<SelectionAndRefused>(EMPTY);

  const toggle = useCallback(
    (entry: SelectionEntry) => {
      setSel((prev) => ({ selection: toggleEntry(prev.selection, entry, limits), refused: 0 }));
    },
    [limits],
  );

  const setMany = useCallback(
    (entries: readonly SelectionEntry[], selected: boolean) => {
      if (!selected) {
        setSel((prev) => ({
          selection: removeKeys(prev.selection, entries.map((e) => e.rowKey)),
          refused: 0,
        }));
        return;
      }
      setSel((prev) => {
        const { next, refused } = addEntries(prev.selection, entries, limits);
        return { selection: next, refused: refused.length };
      });
    },
    [limits],
  );

  const clear = useCallback(() => {
    setSel(EMPTY);
  }, []);

  const clearKeys = useCallback((rowKeys: readonly string[]) => {
    if (rowKeys.length === 0) return;
    setSel((prev) => {
      // removeKeys returns the same reference when nothing was removed, so
      // returning prev unchanged (same object identity) lets React bail out
      // of the re-render — load-bearing for the unmount-pruning effect, which
      // fires for every row on a full revalidation.
      const next = removeKeys(prev.selection, rowKeys);
      if (next === prev.selection) return prev;
      return { selection: next, refused: 0 };
    });
  }, []);

  const isSelected = useCallback((rowKey: string) => sel.selection.has(rowKey), [sel.selection]);
  const canAdd = useCallback(
    (entry: SelectionEntry) => canAddPure(sel.selection, entry, limits),
    [sel.selection, limits],
  );
  const byKind = useMemo(() => keysByKindPure(sel.selection), [sel.selection]);

  const value = useMemo<RowSelection>(
    () => ({
      state: sel.selection,
      isSelected,
      toggle,
      setMany,
      clear,
      clearKeys,
      canAdd,
      keysByKind: byKind,
      count: sel.selection.size,
      records: recordsOf(sel.selection),
      refusedCount: sel.refused,
      limits,
    }),
    [sel, isSelected, toggle, setMany, clear, clearKeys, canAdd, byKind, limits],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useRowSelection(): RowSelection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useRowSelection must be used within a SelectionProvider");
  return ctx;
}
